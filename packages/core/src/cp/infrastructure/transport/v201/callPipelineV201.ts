import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { MAX_TIMER_MS } from "../../../shared/timers";
import { clockOf, unrefTimerHandle } from "../../../shared/clock";
import type { SimClock, TimerHandle } from "../../../shared/clock";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import { behaviorTapOf } from "../behaviorTap";
import type { V201Action, V201RequestPayload } from "./inboundRegistryV201";
import type {
  TransactionEventDelivery,
  TransactionEventDeliveryV201,
  TransactionEventMessage,
} from "./transactionEventDeliveryV201";

/** A written CP→CSMS CALL awaiting its answer. */
export interface PendingRequest {
  action: V201Action;
  payload: V201RequestPayload;
  /** Set on the TransactionEvents this handler builds (#490). */
  transactionEvent?: TransactionEventDelivery;
  /** Its `MessageTimeout` timer (#529), armed when the CALL is written;
   *  cleared on answer and WebSocket close. */
  timeout?: TimerHandle;
}

/** A CALL waiting for, or holding, the §4.1.1 slot (#708). */
interface CallJob {
  readonly action: V201Action;
  readonly messageId: string;
  /** What is written (the behaviors' beforeSend applied). */
  readonly payload: V201RequestPayload;
  /** The CALL as built: answers are matched with it. */
  readonly built: V201RequestPayload;
  readonly onDropped?: (reason: string) => void;
  readonly transactionEvent?: TransactionEventDelivery;
  readonly onWritten?: () => void;
}

/** The CALL holding the slot: handed to the socket, or written. */
type CallSlot =
  | { phase: "queued"; id: string }
  // `timer` is absent for a TransactionEvent: its own MessageTimeout timer
  // (armTransactionEventTimeout) frees the slot.
  | { phase: "written"; id: string; timer?: TimerHandle };

/** What the outbound call pipeline needs from the handler. */
export interface CallPipelineContext {
  readonly chargePoint: Pick<
    ChargePoint,
    "clock" | "configuration" | "notifyOutgoingCall"
  >;
  readonly logger: Logger;
  readonly webSocket: Pick<
    OCPPWebSocket,
    "currentGeneration" | "isConnected" | "sendAction"
  >;
  readonly codec?: ProtocolCodec;
  /** The handler's written CALLs awaiting their answer, by message id. */
  readonly pendingRequests: Map<string, PendingRequest>;
  readonly transactionEvents: Pick<
    TransactionEventDeliveryV201,
    "active" | "armTransactionEventTimeout"
  >;
  /** A CALL was written: the outage is over (#528). */
  markOutageOver(): void;
}

/**
 * The CP→CSMS CALLs of the 2.x handler under OCPP-J Part 4 §4.1.1 (#708):
 * one CALL in flight, the others waiting in order, TransactionEvents
 * delivered one after the other (E13), the slot freed by the answer, the
 * `MessageTimeout` or a close (#877).
 */
export class CallPipelineV201 {
  private readonly _chargePoint: CallPipelineContext["chargePoint"];
  private readonly _logger: Logger;
  private readonly _webSocket: CallPipelineContext["webSocket"];
  private readonly _codec?: ProtocolCodec;
  private readonly _pendingRequests: Map<string, PendingRequest>;
  private readonly _transactionEvents: CallPipelineContext["transactionEvents"];
  /** OCPP-J 2.0.1 / 2.1 Part 4 §4.1.1 (#708): CALLs wait here for the one in
   *  flight; `_callSlot` holds the slot from the hand-over to the socket until
   *  the CALLRESULT / CALLERROR, the `MessageTimeout` or a close. */
  private _callQueue: CallJob[] = [];
  private _callSlot: CallSlot | null = null;

  constructor(private readonly ctx: CallPipelineContext) {
    this._chargePoint = ctx.chargePoint;
    this._logger = ctx.logger;
    this._webSocket = ctx.webSocket;
    this._codec = ctx.codec;
    this._pendingRequests = ctx.pendingRequests;
    this._transactionEvents = ctx.transactionEvents;
  }

  /** The charge point's clock (the platform clock for a stand-in without one). */
  private get clock(): SimClock {
    return clockOf(this._chargePoint);
  }

  private clearTimer(handle: TimerHandle | undefined): void {
    if (handle !== undefined) this.clock.clearTimeout(handle);
  }

  public send(
    action: V201Action,
    messageId: string,
    payload: V201RequestPayload,
    /** Told when the CALL never reached the wire (#348 waiters). */
    onDropped?: (reason: string) => void,
    transactionEvent?: TransactionEventDelivery,
    onWritten?: () => void,
    /** The behaviors' beforeSend already ran (the expert path). */
    intercepted = false,
  ): void {
    if (!this._webSocket.isConnected()) {
      this._logger.warn(
        `[v2.0.1] Not connected, dropping ${action}`,
        LogType.WEBSOCKET,
      );
      onDropped?.("not_connected");
      return;
    }
    // The CALL as built: answers are matched with it, not with the copy a
    // behavior's beforeSend rewrote (the same rule as on 1.6).
    const built = payload;
    if (!intercepted) {
      const decision = behaviorTapOf(this._chargePoint).beforeSend(
        action,
        payload,
      );
      if ("drop" in decision) {
        this._logger.warn(
          `[v2.0.1] Dropping ${action}: a behavior's beforeSend dropped it`,
          LogType.OCPP,
        );
        onDropped?.("dropped_by_behavior");
        // A dropped Heartbeat is a Heartbeat the CSMS never answered: the
        // idle timer still goes on, or the periodic Heartbeat would stop for good.
        if (action === "Heartbeat") this._chargePoint.notifyOutgoingCall(false);
        return;
      }
      payload = decision.payload as V201RequestPayload;
    }
    const warning = this._codec?.outgoingWarning(action, payload);
    if (warning) {
      this._logger.warn(warning, LogType.OCPP);
    }
    // §4.1.1 (#708): one CALL in flight. The job waits for the slot; the
    // answer, the timeout or a close releases it.
    this._callQueue.push({
      action,
      messageId,
      payload,
      built,
      onDropped,
      transactionEvent,
      onWritten,
    });
    this.pumpCalls();
  }

  /**
   * Hand the next eligible CALL to the socket unless one is in flight (queued
   * with the socket or written). Re-entrant safe: the slot is taken before the
   * socket sees the CALL, and a settlement that fires synchronously finds it.
   */
  public pumpCalls(): void {
    while (this._callSlot === null && this._callQueue.length > 0) {
      if (!this._webSocket.isConnected()) return;
      const index = this.nextEligibleCall();
      if (index === -1) return;
      const [job] = this._callQueue.splice(index, 1);
      if (job === undefined) return;
      this.transmitCall(job);
    }
  }

  /**
   * The first CALL that may go out now. Non-TransactionEvent CALLs go in
   * queue order. E13.FR.03/04 deliver transaction-related messages one after
   * the other ("continue with the next transaction-related message"): a
   * TransactionEvent waits while an older message is waiting out its
   * `MessageAttemptInterval`, has a transmission queued or still awaits
   * its answer, so a resent
   * `Started` is not overtaken by `Ended`. A message settled or discarded
   * while its CALL waited is never written.
   */
  private nextEligibleCall(): number {
    for (let i = 0; i < this._callQueue.length; i++) {
      const delivery = this._callQueue[i]!.transactionEvent;
      if (delivery === undefined) return i;
      if (delivery.message.done) return i; // dropped by transmitCall
      if (!this.hasOlderUndeliveredEvent(delivery.message)) return i;
    }
    return -1;
  }

  private hasOlderUndeliveredEvent(message: TransactionEventMessage): boolean {
    for (const older of this._transactionEvents.active) {
      if (older === message) return false;
      if (older.resend !== undefined) return true;
      for (const id of older.inFlight) {
        // A transmission that already timed out only waits for a late answer:
        // when its resend was dropped (a network-sim `queue_overflow`, a
        // behavior's `beforeSend`) no further attempt is scheduled, and
        // holding the later events for it would never end (#565). One still
        // travelling through the network-sim has no pending entry yet.
        const attempt =
          this._pendingRequests.get(id)?.transactionEvent?.attempt;
        if (attempt === undefined || attempt > older.failed) return true;
      }
      if (
        this._callQueue.some((job) => job.transactionEvent?.message === older)
      ) {
        return true;
      }
    }
    return false;
  }

  private transmitCall(job: CallJob): void {
    const { action, messageId, payload, built, transactionEvent } = job;
    if (transactionEvent?.message.done) {
      // Settled or discarded while it waited: nothing to send. The
      // transmission was forgotten with the message.
      return;
    }
    this._callSlot = { phase: "queued", id: messageId };
    const gen = this._webSocket.currentGeneration();
    const accepted = this._webSocket.sendAction(
      messageId,
      action,
      payload,
      gen,
      (settlement) => {
        if (settlement.outcome === "written") {
          this.ctx.markOutageOver();
          // A transmission written after its message was settled or
          // discarded is not tracked: nothing would ever remove it.
          if (transactionEvent?.message.done) {
            this._chargePoint.notifyOutgoingCall(false);
            this.releaseCall(messageId);
            return;
          }
          this._pendingRequests.set(messageId, {
            action,
            payload: built,
            ...(transactionEvent
              ? {
                  transactionEvent,
                  timeout: this._transactionEvents.armTransactionEventTimeout(
                    transactionEvent,
                    messageId,
                  ),
                }
              : {}),
          });
          this.armCallTimeout(messageId, transactionEvent !== undefined);
          this._chargePoint.notifyOutgoingCall(action === "Heartbeat");
          job.onWritten?.();
        } else {
          // On drop outcomes (socket_closed, disposed, write_failed,
          // queue_overflow): no retry here. The caller is told; a
          // TransactionEvent's delivery queues it when offline (#528, E11),
          // any other CALL is lost.
          const closing =
            settlement.outcome === "socket_closed" ||
            settlement.outcome === "disposed";
          this.releaseCall(messageId, false);
          job.onDropped?.(settlement.outcome);
          // A close hands the rest of the queue to onWebSocketClosed.
          if (!closing) this.pumpCalls();
        }
      },
    );
    if (!accepted) {
      this.releaseCall(messageId, false);
      job.onDropped?.("not_accepted");
      this.pumpCalls();
      // send-false: the CALL was never accepted; preserve current behavior
      // (likely just a warn/log already in place from isConnected check above)
      this._logger.debug(
        `[v2.0.1] sendAction returned false for ${action}`,
        LogType.WEBSOCKET,
      );
    }
  }

  /** Arm the slot's timeout once the CALL is written: after `MessageTimeout`
   *  seconds the CALL counts as timed out (Part 4 §4.1.1) and the next one
   *  may go. Its pending entry stays, so a late answer is still recognised. */
  private armCallTimeout(messageId: string, ownTimer: boolean): void {
    const cur = this._callSlot;
    if (!cur || cur.id !== messageId) return;
    if (ownTimer) {
      this._callSlot = { phase: "written", id: messageId };
      return;
    }
    const configuration = this._chargePoint.configuration;
    const seconds =
      typeof configuration.messageTimeout === "function"
        ? configuration.messageTimeout()
        : 30;
    const timer = this.clock.setTimeout(
      () => {
        const slot = this._callSlot;
        if (!slot || slot.id !== messageId) return;
        this._logger.warn(
          `[v2.0.1] CALL ${messageId} got no answer within ${seconds}s; releasing the slot`,
          LogType.OCPP,
        );
        this._callSlot = null;
        this.pumpCalls();
      },
      Math.min(Math.max(1, seconds) * 1000, MAX_TIMER_MS),
    );
    unrefTimerHandle(timer);
    this._callSlot = { phase: "written", id: messageId, timer };
  }

  /** Free the slot `messageId` holds (answer, drop or timeout) and, unless
   *  `pump` is false, send the next CALL. */
  public releaseCall(messageId: string, pump = true): void {
    const cur = this._callSlot;
    if (!cur || cur.id !== messageId) return;
    if (cur.phase === "written") this.clearTimer(cur.timer);
    this._callSlot = null;
    if (pump) this.pumpCalls();
  }

  /** Take a CALL back out of the queue if it has not been handed to the
   *  socket (#389: its caller was told "no answer"). */
  public withdrawQueued(messageId: string): boolean {
    const index = this._callQueue.findIndex((j) => j.messageId === messageId);
    if (index === -1) return false;
    this._callQueue.splice(index, 1);
    return true;
  }

  /** The connection closed: free the slot and tell the CALLs still waiting
   *  for it, except the TransactionEvents the close queues (#708). */
  public closeQueue(): void {
    const waiting = this._callQueue;
    this._callQueue = [];
    const slot = this._callSlot;
    this._callSlot = null;
    if (slot?.phase === "written") this.clearTimer(slot.timer);
    for (const job of waiting) {
      if (job.transactionEvent === undefined) job.onDropped?.("socket_closed");
    }
  }
}
