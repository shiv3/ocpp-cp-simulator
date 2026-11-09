// The OCPP 1.6 outbound delivery of OCPPMessageHandler (#877): the
// §4.1.1 serial queue, the #565 hold and start outcomes, salvage to the
// offline queue, and the §3.7.1 resend of a transaction-related message
// after a CALLERROR (#527) with its discard limits.
import type { StartTransactionRequestV16 } from "@ocpp-cp-simulator/ocpp/index";
import type {
  OCPPWebSocket,
  OcppMessageRequestPayload,
} from "../OCPPWebSocket";
import type { Settlement } from "../network-sim";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import { behaviorTapOf } from "../behaviorTap";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Transaction } from "../../../domain/connector/Transaction";
import { isRunningTransactionStartedBy } from "../../../domain/connector/Transaction";
import type { PendingMessageQueue } from "../../../domain/transport/PendingMessageQueue";
import type { BootGate } from "../../../application/state/machines/BootGate";
import { MAX_TIMER_MS } from "../../../shared/timers";
import { clockOf, unrefTimerHandle } from "../../../shared/clock";
import type { SimClock, TimerHandle } from "../../../shared/clock";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import {
  OCPPAction,
  OCPPMessageType,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import {
  UNKNOWN_TRANSACTION_ID,
  isCriticalSecurityEventCall,
  isRetriedOnCallError,
  isTransactionRelated,
  requestConnectorId,
  startKey,
  type OCPPRequest,
  type RequestHistory,
  type SerialEntry,
  type StartRef,
} from "./outboundRequestsV16";

/** What the delivery needs from the 1.6 handler: never the handler itself. */
export interface SerialCallQueueV16Context {
  /** The charge point object itself, typed narrowly: `behaviorTapOf` and
   *  `clockOf` read its `engine` and `clock`. */
  readonly chargePoint: Pick<
    ChargePoint,
    | "clock"
    | "configuration"
    | "getConnector"
    | "notifyOutgoingCall"
    | "notifyTransactionMessageRejected"
    | "notifyTransactionMessageDiscarded"
    | "updateConnectorStatus"
  >;
  readonly webSocket: Pick<
    OCPPWebSocket,
    "isConnected" | "currentGeneration" | "sendAction"
  >;
  readonly logger: Logger;
  readonly codec: Pick<ProtocolCodec, "outgoingWarning">;
  readonly bootGate: Pick<BootGate, "isCallAllowed" | "status">;
  readonly pendingQueue: Pick<
    PendingMessageQueue,
    "enqueue" | "size" | "all" | "flush"
  >;
  /** The handler's request history: answers are matched against it. */
  readonly requests: RequestHistory;
  /** See {@link SerialCallQueueV16._startOutcomes}. */
  readonly startOutcomes: Map<string, number>;
  readonly generateMessageId: () => string;
}

export class SerialCallQueueV16 {
  private readonly _chargePoint: SerialCallQueueV16Context["chargePoint"];
  private readonly _webSocket: SerialCallQueueV16Context["webSocket"];
  private readonly _logger: Logger;
  private readonly _codec: SerialCallQueueV16Context["codec"];
  private readonly _bootGate: SerialCallQueueV16Context["bootGate"];
  private readonly _pendingQueue: SerialCallQueueV16Context["pendingQueue"];
  private readonly _requests: RequestHistory;
  private readonly _generateMessageId: () => string;

  // OCPP-J §4.1.1 (Synchronicity): "A Charge Point or Central System
  // SHOULD NOT send a CALL message to the other party unless all the
  // CALL messages it sent before have been responded to or have timed
  // out." We serialize outgoing CALLs through this queue so only one is
  // in-flight at a time. Without this, real CSMS implementations drop
  // post-Boot StatusNotification fan-outs at the application layer and
  // then issue TriggerMessage to recover (observed in dev env).
  private _serialQueue: SerialEntry[] = [];
  private _serialInFlight:
    | { phase: "queued"; action: OCPPAction; id: string }
    | {
        phase: "written";
        action: OCPPAction;
        id: string;
        timer: TimerHandle;
      }
    | null = null;
  // §4.1.1 lets the implementation pick the CALL timeout. 30s is a common
  // CSMS default and roughly matches Configuration's default
  // TransactionMessageRetryInterval (60s).
  private static readonly SERIAL_CALL_TIMEOUT_MS = 30_000;

  /** #527: transaction-related messages waiting out their
   *  TransactionMessageRetryInterval after a CALLERROR, keyed by timer. */
  private readonly _transactionMessageRetries = new Map<
    TimerHandle,
    SerialEntry
  >();

  /**
   * #565, §3.7: while a resend waits (its retry interval, the serial queue,
   * in flight), new transaction-related messages wait behind it, in order;
   * `null` when none does. Released when the resend settles, moved to the
   * offline queue behind it when the link closes.
   */
  private _held: SerialEntry[] | null = null;

  /** #565: what each StartTransaction.req of this process got: the id of its
   *  conf, or `-1` once discarded. Read when a StopTransaction.req or a
   *  MeterValues.req of that transaction is sent; the Stop removes it. */
  private readonly _startOutcomes: Map<string, number>;

  constructor(context: SerialCallQueueV16Context) {
    this._chargePoint = context.chargePoint;
    this._webSocket = context.webSocket;
    this._logger = context.logger;
    this._codec = context.codec;
    this._bootGate = context.bootGate;
    this._pendingQueue = context.pendingQueue;
    this._requests = context.requests;
    this._startOutcomes = context.startOutcomes;
    this._generateMessageId = context.generateMessageId;
  }

  public sendRequest(
    action: OCPPAction,
    id: string,
    payload: OcppMessageRequestPayload,
    connectorId?: number,
    onDropped?: (reason: string) => void,
    attempt?: number,
    /** The behaviors' beforeSend already ran (the expert path). */
    intercepted = false,
    /** #565: the StartTransaction.req a Stop / MeterValues belongs to. */
    startRef?: StartRef,
  ): void {
    if (!this.isCallAllowed(action)) {
      this._logger.warn(
        `Suppressing ${action}: blocked by the boot gate — BootNotification not yet Accepted (status=${this._bootGate.status.status})`,
        LogType.OCPP,
      );
      return;
    }
    // #565, §3.7: "The delivery of new transaction-related messages SHALL
    // wait until the queue has been emptied": behind a waiting resend.
    if (this._held && isRetriedOnCallError({ action, payload, onDropped })) {
      this._held.push({
        action,
        id,
        payload,
        ...(connectorId !== undefined && { connectorId }),
        ...(attempt !== undefined && { attempt }),
        ...(startRef && { startRef }),
        intercepted,
      });
      this._logger.info(
        `${action} waits behind a transaction message being resent (§3.7); ${this._held.length} held`,
        LogType.TRANSACTION,
      );
      return;
    }
    // A CALL handed over while the socket is down is not transmitted, so
    // beforeSend does not see it: it is queued as built and intercepted when
    // it is replayed (once per transmission, like the 2.x handler).
    let wire: OcppMessageRequestPayload | undefined;
    let interceptedHere = false;
    if (!intercepted && this._webSocket.isConnected()) {
      const decision = this.interceptOutgoing(action, payload, onDropped);
      if (decision === "dropped") return;
      wire = decision;
      interceptedHere = true;
    }
    const warning = this._codec.outgoingWarning(action, wire ?? payload);
    if (warning) {
      this._logger.warn(warning, LogType.OCPP);
    }
    // §4.1.1: queue here, pumpSerialQueue does the actual `ws.sendAction`
    // one CALL at a time. The previous CALL's CALLRESULT/CALLERROR (or
    // timeout) releases the slot via `settleSerialInFlight`.
    this._serialQueue.push({
      action,
      id,
      payload,
      ...(wire !== undefined && { wire }),
      connectorId,
      onDropped,
      attempt,
      ...(startRef && { startRef }),
      intercepted: intercepted || interceptedHere,
    });
    this.pumpSerialQueue();
  }

  /**
   * #565: give a StopTransaction.req or MeterValues.req the id its
   * transaction's StartTransaction.req got, as late as the CALL is sent: the
   * conf can arrive after the message was built (the transaction stopped
   * while the request was in flight or being resent). A discarded request
   * leaves `-1` (1.6 errata 3.18).
   */
  private applyStartOutcome(entry: SerialEntry): void {
    if (!entry.startRef) return;
    const key = startKey(entry.startRef);
    const id = this._startOutcomes.get(key);
    if (id === undefined) return;
    const payload = entry.payload as { transactionId?: number };
    if (
      typeof payload.transactionId === "number" &&
      payload.transactionId !== id
    ) {
      const before = payload.transactionId;
      entry.payload = {
        ...payload,
        transactionId: id,
      } as OcppMessageRequestPayload;
      const wire = entry.wire as { transactionId?: number } | undefined;
      if (wire && wire.transactionId === before) {
        entry.wire = {
          ...wire,
          transactionId: id,
        } as OcppMessageRequestPayload;
      }
    }
    if (entry.action === OCPPAction.StopTransaction) {
      this._startOutcomes.delete(key);
    }
  }

  /** Whether a queued, held or waiting CALL takes its id from `ref`'s conf. */
  public hasMessageWaitingOn(ref: StartRef): boolean {
    const key = startKey(ref);
    const waits = (e: { startRef?: StartRef }): boolean =>
      e.startRef !== undefined && startKey(e.startRef) === key;
    // A CALL in flight took its id when it was sent: it does not wait.
    return [
      ...this._serialQueue,
      ...(this._held ?? []),
      ...this._transactionMessageRetries.values(),
    ].some(waits);
  }

  public recordStartOutcome(
    start: StartTransactionRequestV16,
    connectorId: number,
    id: number,
  ): void {
    this._startOutcomes.set(
      startKey({ connectorId, idTag: start.idTag, startedAt: start.timestamp }),
      id,
    );
    // A Stop removes its entry; this only bounds a station that never stops.
    if (this._startOutcomes.size > 256) {
      const oldest = this._startOutcomes.keys().next().value;
      if (oldest !== undefined) this._startOutcomes.delete(oldest);
    }
  }

  /**
   * #727, errata 3.18: the id a StopTransaction.req or MeterValues.req of
   * `transaction` carries. The placeholder `0` stands while a
   * StartTransaction.req of it is still on its way (the message then takes
   * the id of its conf when it is sent, `applyStartOutcome`); once none is
   * (it timed out, was discarded, or was lost in a restart) the station will
   * not learn an id, and the message carries `-1`.
   */
  public wireTransactionId(transaction: Transaction): number {
    if (
      transaction.id !== 0 ||
      !transaction.startUnanswered ||
      this.isStartLive({
        connectorId: transaction.connectorId,
        idTag: transaction.tagId,
        startedAt: transaction.startTime.toISOString(),
      })
    ) {
      return transaction.id;
    }
    return UNKNOWN_TRANSACTION_ID;
  }

  /** Whether a StartTransaction.req for `ref` is in flight, queued, waiting
   *  out a resend interval, held or in the offline queue. */
  private isStartLive(ref: StartRef): boolean {
    const is = (
      action: string,
      payload: unknown,
      connectorId?: number | null,
    ): boolean => {
      if (action !== OCPPAction.StartTransaction) return false;
      const start = payload as StartTransactionRequestV16;
      return (
        start.idTag === ref.idTag &&
        start.timestamp === ref.startedAt &&
        requestConnectorId({ connectorId, payload }) === ref.connectorId
      );
    };
    const inFlight = this._serialInFlight
      ? this._requests.get(this._serialInFlight.id)
      : undefined;
    if (inFlight && is(inFlight.action, inFlight.payload, inFlight.connectorId))
      return true;
    const entries = [
      ...this._serialQueue,
      ...(this._held ?? []),
      ...this._transactionMessageRetries.values(),
    ];
    if (entries.some((e) => is(e.action, e.payload, e.connectorId)))
      return true;
    return this._pendingQueue
      .all()
      .some((m) => is(m.action, m.payload, m.connectorId));
  }

  /** #565: the waiting resend settled (answered, discarded, timed out or
   *  dropped): the messages held behind it go on, in order. */
  public releaseHold(): void {
    const held = this._held;
    this._held = null;
    if (!held || held.length === 0) return;
    this._logger.info(
      `Releasing ${held.length} transaction message(s) held behind a resend`,
      LogType.TRANSACTION,
    );
    for (const entry of held) {
      // The boot gate closed while the resend was settling (a
      // TriggerMessage(BootNotification) answered Pending): sendRequest would
      // drop the message. §3.7 queues it instead, as on a close (the timer
      // path does the same).
      if (!this.isCallAllowed(entry.action)) {
        this.salvageOrDiscard(entry, "boot gate");
        continue;
      }
      this.applyStartOutcome(entry);
      if (entry.intercepted) {
        // Already seen by beforeSend (and carrying its `wire`, `attempt` and
        // `lastErrorCode`): back in the queue, not through sendRequest.
        this._serialQueue.push(entry);
        continue;
      }
      this.sendRequest(
        entry.action,
        entry.id,
        entry.payload,
        entry.connectorId,
        entry.onDropped,
        entry.attempt,
        false,
        entry.startRef,
      );
    }
    this.pumpSerialQueue();
  }

  /** #565: the resend left for the offline queue; what waits behind it
   *  follows it there, in order (§3.7: queue while offline). */
  private holdToOfflineQueue(reason: string): void {
    const held = this._held;
    this._held = null;
    if (!held) return;
    for (const entry of held) this.salvageOrDiscard(entry, reason);
  }

  /**
   * The behaviors' beforeSend for one transmission. Returns the payload to
   * write when a behavior changed it (`undefined`: unchanged), or "dropped"
   * after telling the caller: nothing is queued and nothing is written, the
   * serial queue is not held up.
   */
  private interceptOutgoing(
    action: OCPPAction,
    payload: OcppMessageRequestPayload,
    onDropped?: (reason: string) => void,
  ): OcppMessageRequestPayload | undefined | "dropped" {
    const decision = behaviorTapOf(this._chargePoint).beforeSend(
      action,
      payload,
    );
    if ("drop" in decision) {
      this._logger.warn(
        `Dropping ${action}: a behavior's beforeSend dropped it`,
        LogType.OCPP,
      );
      onDropped?.("dropped_by_behavior");
      // A dropped Heartbeat is a Heartbeat the CSMS never answered: the
      // idle timer still goes on, or the periodic Heartbeat would stop for good.
      if (action === OCPPAction.Heartbeat) {
        this._chargePoint.notifyOutgoingCall(false);
      }
      return "dropped";
    }
    return decision.payload as OcppMessageRequestPayload;
  }

  /**
   * Centralize custody: a CALL with a waiting caller tells it; otherwise
   * transaction-related messages (StartTransaction/StopTransaction/MeterValues)
   * are queued for retry and others are logged and discarded.
   */
  private salvageOrDiscard(entry: SerialEntry, reason: string): void {
    if (entry.onDropped) {
      this._logger.warn(
        `Dropping ${entry.action} (${reason}); its caller is told`,
        LogType.OCPP,
      );
      entry.onDropped(reason);
      return;
    }
    if (
      isTransactionRelated(entry.action) ||
      isCriticalSecurityEventCall(entry)
    ) {
      // #565: the id its StartTransaction.req got, if the conf (or the
      // discard) came after the message was built.
      if (isTransactionRelated(entry.action)) this.applyStartOutcome(entry);
      this._pendingQueue.enqueue({
        action: entry.action,
        payload: entry.payload,
        connectorId: entry.connectorId,
        attempts: (entry.attempt ?? 1) - 1,
      });
      this._logger.warn(
        `Salvaged ${entry.action} to PendingMessageQueue (${reason}); size=${this._pendingQueue.size()}`,
        LogType.OCPP,
      );
      // #565: what waited behind a resend follows it, in order.
      if ((entry.attempt ?? 1) > 1) this.holdToOfflineQueue(reason);
    } else {
      this._logger.warn(
        `Dropping ${entry.action} (informational, ${reason})`,
        LogType.OCPP,
      );
    }
  }

  /**
   * Drain one CALL off `_serialQueue` and put it in flight. No-op when
   * another CALL is already in flight (queued OR written); the eventual
   * settlement callback will pump us again when the in-flight CALL transitions
   * from "written" → timeout/CALLRESULT.
   */
  public pumpSerialQueue(): void {
    // Checked on every turn, and the head leaves the queue first: a discard
    // can send a CALL of its own (the StatusNotification of the connector it
    // moves), which pumps too.
    while (!this._serialInFlight && this._serialQueue.length > 0) {
      const head = this._serialQueue.shift()!;
      if (this.discardResendPastLimit(head)) continue;
      if (!this.isCallAllowed(head.action)) {
        // Boot gate currently blocks this action — leave it at the front
        // of the queue. `setBootStatus` re-pumps us when the gate opens.
        this._serialQueue.unshift(head);
        return;
      }
      // #565: the id its transaction's StartTransaction.req got, if that
      // answer came after the message was built.
      this.applyStartOutcome(head);
      this._requests.add({
        type: OCPPMessageType.CALL,
        action: head.action,
        id: head.id,
        payload: head.payload,
        connectorId: head.connectorId,
        ...(isRetriedOnCallError(head) && { attempt: head.attempt ?? 1 }),
        ...(head.startRef && { startRef: head.startRef }),
      });

      // Create the slot in "queued" phase BEFORE sendAction, because the settlement
      // callback may fire SYNCHRONOUSLY (disabled path) and must find a slot to transition.
      this._serialInFlight = {
        phase: "queued",
        action: head.action,
        id: head.id,
      };

      const gen = this._webSocket.currentGeneration();
      const accepted = this._webSocket.sendAction(
        head.id,
        head.action,
        head.wire ?? head.payload,
        gen,
        (settlement) => this.onSerialSettled(head, settlement),
      );

      if (!accepted) {
        // send-false: the pre-created slot must be cleared; the request never went out.
        this._serialInFlight = null;
        this._requests.remove(head.id);
        this.salvageOrDiscard(head, "send-false");
        continue;
      }
      // Accepted. If the settlement already fired synchronously (disabled), onSerialSettled
      // has already transitioned the slot to "written" (armed timer + notifyOutgoingCall).
      // If async (enabled/delayed), the slot stays "queued" and holds the serializer.
      return;
    }
  }

  /**
   * Settlement callback for the in-flight serialized CALL. Fires exactly once per
   * sendAction, either when the frame is physically written or when a drop occurs
   * (socket_closed, disposed, write_failed). Handles the phase transition from
   * "queued" → "written" and manages custody (salvage vs. drop) on failure.
   */
  private onSerialSettled(head: SerialEntry, settlement: Settlement): void {
    const cur = this._serialInFlight;
    // Staleness guard: ignore a settlement that no longer matches the current slot.
    if (!cur || cur.id !== head.id) return;

    if (settlement.outcome === "written") {
      // Now it is physically on the wire: NOW arm the 30s response timeout and count heartbeat activity.
      this._chargePoint.notifyOutgoingCall(
        head.action === OCPPAction.Heartbeat,
      );
      const timer = this.clock.setTimeout(
        () => this.handleSerialTimeout(head.id),
        SerialCallQueueV16.SERIAL_CALL_TIMEOUT_MS,
      );
      this._serialInFlight = {
        phase: "written",
        action: head.action,
        id: head.id,
        timer,
      };
      return;
    }

    // Drop outcomes: the frame never physically went out (or its write failed).
    this._serialInFlight = null;
    this._requests.remove(head.id);
    this.salvageOrDiscard(head, settlement.outcome);

    if (
      settlement.outcome === "socket_closed" ||
      settlement.outcome === "disposed"
    ) {
      // Do NOT pump here. The close/teardown path (onWebSocketClosed) owns salvaging the
      // remaining _serialQueue in order; pumping now could write into a closing socket
      // or reorder salvage. Just release the slot.
      return;
    }
    if (settlement.outcome === "write_failed") {
      // Salvaged above; defer a pump that re-checks the socket is still open before releasing the next CALL.
      queueMicrotask(() => {
        if (this._webSocket.isConnected()) this.pumpSerialQueue();
      });
      return;
    }
    // queue_overflow cannot occur for a CALL (sendAction returns false on overflow -> the send-false path).
  }

  /** Take an expert CALL back out of the serial queue if it has not been
   *  sent yet (#389): its caller has already been told "no answer". */
  public withdrawQueued(messageId: string): boolean {
    const index = this._serialQueue.findIndex(
      (entry) => entry.id === messageId,
    );
    if (index === -1) return false;
    this._serialQueue.splice(index, 1);
    return true;
  }

  /** An answered CALL whose answer stops here (#389 expert call without
   *  `applyResponse`): forget it and free the serialization slot. */
  public forgetAnsweredCall(messageId: string): void {
    this._requests.remove(messageId);
    this.settleSerialInFlight(messageId);
  }

  /** Release the serialization slot when a response settles the in-flight
   *  CALL. The caller is responsible for invoking this from
   *  handleCallResult / handleCallError. */
  public settleSerialInFlight(messageId: string): void {
    const cur = this._serialInFlight;
    if (!cur || cur.id !== messageId) return;
    if (cur.phase === "written") this.clock.clearTimeout(cur.timer);
    this._serialInFlight = null;
    this.pumpSerialQueue();
  }

  /** Per-CALL watchdog. §4.1.1 says implementations choose the timeout;
   *  on expiry we proceed to the next CALL so a stuck CSMS doesn't deadlock
   *  the queue forever. The dead CALL is dropped (transaction-related
   *  ones are also tracked via the persistent PendingMessageQueue). This timer
   *  only fires when the slot is in "written" phase (that is the only phase
   *  with an armed timer). */
  private handleSerialTimeout(messageId: string): void {
    const cur = this._serialInFlight;
    if (!cur || cur.id !== messageId) return;
    this._logger.warn(
      `CALL ${messageId} (${cur.action}) timed out after ${SerialCallQueueV16.SERIAL_CALL_TIMEOUT_MS}ms — releasing serialization slot`,
      LogType.OCPP,
    );
    const request = this._requests.get(messageId);
    if (request) request.timedOut = true;
    this._serialInFlight = null;
    // #727, errata 3.18: no StartTransaction.conf came within the timeout and
    // 1.6 does not retry a timeout, so the station gives the id up. The
    // transaction's messages carry `-1`, unless a late conf still assigns one.
    if (
      request?.action === OCPPAction.StartTransaction &&
      request.attempt !== undefined
    ) {
      const start = request.payload as StartTransactionRequestV16;
      const connectorId = requestConnectorId(request);
      this.discardedStart(start, connectorId);
      // Like a discard after a CALLERROR (#527): the transaction goes on
      // without a StartTransaction.conf.
      this.proceedWithoutStartConf(connectorId, start);
    }
    // 1.6 does not retry a timeout: a resend that timed out is settled.
    if (request?.attempt !== undefined && request.attempt > 1) {
      this.releaseHold();
    }
    this.pumpSerialQueue();
  }

  /**
   * §3.7 / errata 3.36: put the transaction-related CALL that was written but
   * is not answered yet on the offline queue, so it is delivered after the
   * next boot instead of being discarded when the socket closes. Called by a
   * graceful daemon shutdown that gave up waiting for the CSMS; a close in
   * general keeps its discard behavior (a Reset closes right after the stop
   * and its answer is still on the way). A resend after the CSMS did process
   * the original is the at-least-once delivery the queue implies. One whose
   * watchdog already expired was given up, and one with a waiting caller
   * is that caller's. Returns whether a CALL was queued.
   */
  public queueUnansweredTransactionCall(): boolean {
    const inFlight = this._serialInFlight;
    if (!inFlight || inFlight.phase !== "written") return false;
    const request = this._requests.get(inFlight.id);
    if (!request || request.timedOut || !isTransactionRelated(request.action)) {
      return false;
    }
    this.clock.clearTimeout(inFlight.timer);
    this._serialInFlight = null;
    this._requests.remove(request.id);
    this.salvageOrDiscard(
      {
        action: request.action,
        id: request.id,
        payload: request.payload as OcppMessageRequestPayload,
        connectorId: request.connectorId ?? undefined,
        attempt: request.attempt,
      },
      "no answer before shutdown",
    );
    // No pump: the socket is closing, so the next queued CALL must stay
    // unsent. Writing it here would make it the written in-flight CALL, which
    // onWebSocketClosed discards; left in the queue it is salvaged there.
    return true;
  }

  /** The socket closed: the first step of the handler's onWebSocketClosed.
   *  Cancels the in-flight timer and releases the slot. */
  public clearInFlightOnClose(): void {
    if (this._serialInFlight) {
      if (this._serialInFlight.phase === "written") {
        this.clock.clearTimeout(this._serialInFlight.timer);
      }
      // The written-but-unanswered in-flight CALL keeps existing discard behavior (pre-existing limitation);
      // a daemon shutdown queues it first through queueUnansweredTransactionCall.
      this._serialInFlight = null;
    }
  }

  /** The socket closed: the last step of the handler's onWebSocketClosed,
   *  after its waiters were told. Salvages the waiting resends, the unsent
   *  queued CALLs and what is held behind a resend. */
  public salvageOnClose(): void {
    // #527: a resend waiting out its retry interval goes to the offline
    // queue (§3.7: queue transaction-related messages while offline), ahead
    // of the queued CALLs, which are younger. Replayed after the next boot,
    // it goes on with its count: §3.7.1 counts failures for this message.
    for (const [timer, resend] of this._transactionMessageRetries) {
      this.clock.clearTimeout(timer);
      this.salvageOrDiscard(resend, "socket_closed");
    }
    this._transactionMessageRetries.clear();
    // Salvage every UNSENT queued CALL (they never reached the wire) in FIFO order.
    for (const entry of this._serialQueue) {
      this.salvageOrDiscard(entry, "socket_closed");
    }
    this._serialQueue = [];
    // #565: a resend lost in flight leaves nothing to salvage it behind.
    this.holdToOfflineQueue("socket_closed");
  }

  /** The replay part of the handler's flushPendingQueue: every message
   *  still in the offline queue once the security events went out. */
  public replayPendingQueue(): void {
    const maxAttempts =
      this._chargePoint.configuration.transactionMessageAttempts();
    // Route flushed messages through `sendRequest` so they take the same
    // §4.1.1 serialization path as fresh CALLs. The PendingMessageQueue's
    // `flush` callback returns true for every entry (we're handing
    // delivery to the serializer); it'll re-enqueue on actual send
    // failure via the path in `pumpSerialQueue` below.
    // #565: a Stop or MeterValues still on the `0` placeholder follows the
    // StartTransaction.req replayed before it on its connector, and takes
    // the id that one gets.
    const startOf = new Map<number, StartRef>();
    const delivered = this._pendingQueue.flush((message) => {
      const messageId = this.generateMessageId();
      const payload = message.payload as OcppMessageRequestPayload;
      let startRef: StartRef | undefined;
      if (message.action === OCPPAction.StartTransaction) {
        const start = payload as StartTransactionRequestV16;
        startOf.set(requestConnectorId(message), {
          connectorId: requestConnectorId(message),
          idTag: start.idTag,
          startedAt: start.timestamp,
        });
      } else if (
        (payload as { transactionId?: number }).transactionId === 0 &&
        (message.action === OCPPAction.StopTransaction ||
          message.action === OCPPAction.MeterValues)
      ) {
        startRef = startOf.get(requestConnectorId(message));
      }
      this.sendRequest(
        message.action,
        messageId,
        payload,
        message.connectorId,
        undefined,
        message.attempts > 0 ? message.attempts + 1 : undefined,
        false,
        startRef,
      );
      return true;
    }, maxAttempts);
    if (delivered > 0) {
      this._logger.info(
        `Flushed ${delivered} queued transaction message(s)`,
        LogType.OCPP,
      );
    }
  }

  /**
   * #527, OCPP 1.6 Part 2 §3.7.1: a CALLERROR answering StartTransaction.req,
   * StopTransaction.req or a MeterValues.req of a transaction is a failure to
   * process it. The station sends the same message again under a new message
   * id, through the serial queue, waiting `TransactionMessageRetryInterval`
   * seconds times the number of transmissions so far, until
   * `TransactionMessageAttempts` transmissions failed; then it discards the
   * message and carries on. The transaction stays as it is either way,
   * running or ended, as on 2.x (#490).
   *
   * A discarded StartTransaction.req leaves the transaction without a CSMS
   * id: its MeterValues.req and StopTransaction.req then carry `-1` (1.6
   * errata 3.18), and a connector still in Preparing goes
   * to Charging, as when StopTransactionOnInvalidId=false keeps a rejected
   * start running.
   *
   * §3.7 asks for chronological delivery ("The delivery of new
   * transaction-related messages SHALL wait until the queue has been
   * emptied"), so the transaction-related messages that follow a failed one
   * wait for it (#565): `_held`, released when the resend is answered,
   * discarded, dropped or timed out (`releaseHold`), moved behind it to the
   * offline queue when it leaves for there (`holdToOfflineQueue`). A
   * StartTransaction.req resend is sent even if its transaction stopped
   * meanwhile: the StopTransaction.req follows it, with the id its conf
   * assigns or `-1` once it is discarded (1.6 errata 3.18,
   * `applyStartOutcome`). Both settings are read here, so a
   * ChangeConfiguration applies to the next failure; `discardResendPastLimit`
   * applies the limit to a resend already waiting too.
   */
  public onTransactionMessageCallError(
    request: OCPPRequest,
    errorCode: string,
  ): void {
    const attempt = request.attempt ?? 1;
    const payload = request.payload as { transactionId?: number };
    const connectorId = requestConnectorId(request);
    const report = {
      connectorId,
      // StartTransaction.req has no id yet: the 1.6 placeholder stands in.
      transactionId: String(payload.transactionId ?? 0),
      action: request.action as
        "StartTransaction" | "StopTransaction" | "MeterValues",
      reason: "callError" as const,
      errorCode,
    };
    // The transaction this StartTransaction.req started, if it still runs:
    // its `0` placeholder is now one the CSMS failed to process (#491).
    let startedTransaction: Transaction | null = null;
    if (request.action === OCPPAction.StartTransaction) {
      const connector = this._chargePoint.getConnector(connectorId);
      const current = connector?.transaction;
      const start = request.payload as StartTransactionRequestV16;
      if (connector && isRunningTransactionStartedBy(current, start)) {
        startedTransaction = current;
        connector.markStartCallError();
      }
    }
    const config = this._chargePoint.configuration;
    const attempts = Math.max(1, config.transactionMessageAttempts());
    if (attempt >= attempts) {
      this._chargePoint.notifyTransactionMessageRejected({
        ...report,
        attempt,
      });
      this._logger.warn(
        `${request.action} of transaction ${report.transactionId} discarded after ${attempt} attempt(s): ${errorCode}`,
        LogType.TRANSACTION,
      );
      this._chargePoint.notifyTransactionMessageDiscarded({
        ...report,
        attempts: attempt,
      });
      if (request.action === OCPPAction.StartTransaction) {
        this.discardedStart(
          request.payload as StartTransactionRequestV16,
          connectorId,
        );
      }
      if (startedTransaction) {
        this.proceedWithoutStartConf(
          connectorId,
          request.payload as StartTransactionRequestV16,
        );
      }
      // The last attempt failed: what waited behind it goes on (§3.7.1: "the
      // Charge Point SHOULD discard the message and continue with the next
      // transaction-related message").
      this.releaseHold();
      return;
    }
    const delayMs = Math.min(
      Math.max(0, config.transactionMessageRetryInterval()) * attempt * 1000,
      MAX_TIMER_MS,
    );
    this._logger.warn(
      `${request.action} of transaction ${report.transactionId} answered with CALLERROR ${errorCode}; attempt ${attempt + 1}/${attempts} in ${delayMs / 1000}s`,
      LogType.TRANSACTION,
    );
    const resend: SerialEntry = {
      action: request.action,
      id: request.id,
      payload: request.payload as OcppMessageRequestPayload,
      ...(request.connectorId != null && { connectorId: request.connectorId }),
      attempt: attempt + 1,
      lastErrorCode: errorCode,
      ...(request.startRef && { startRef: request.startRef }),
    };
    // #565, §3.7: the messages after this one wait for it. Those already
    // queued behind it in the serial queue join them, in order.
    const held = (this._held ??= []);
    const queued = this._serialQueue.filter(isRetriedOnCallError);
    if (queued.length > 0) {
      this._serialQueue = this._serialQueue.filter(
        (entry) => !isRetriedOnCallError(entry),
      );
      held.push(...queued);
    }
    const timer = this.clock.setTimeout(() => {
      this._transactionMessageRetries.delete(timer);
      // The boot gate closed meanwhile (a BootNotification answered
      // Pending): sendRequest would drop the resend. It waits in the
      // offline queue for the next Accepted instead, as on a close.
      if (!this.isCallAllowed(resend.action)) {
        this.salvageOrDiscard(resend, "boot gate");
        this.holdToOfflineQueue("boot gate");
        return;
      }
      // A resend is a new transmission: the behaviors see it again, starting
      // from the payload as built (the same rule as a replay from the offline
      // queue, and as on 2.x).
      let wire: OcppMessageRequestPayload | undefined;
      if (this._webSocket.isConnected()) {
        const decision = this.interceptOutgoing(resend.action, resend.payload);
        if (decision === "dropped") {
          this._logger.warn(
            `${resend.action} resend dropped by a behavior's beforeSend; the message is not sent again`,
            LogType.TRANSACTION,
          );
          this.releaseHold();
          return;
        }
        wire = decision;
      }
      this._serialQueue.push({
        ...resend,
        ...(wire !== undefined && { wire }),
        id: this.generateMessageId(),
        intercepted: this._webSocket.isConnected(),
      });
      this.pumpSerialQueue();
    }, delayMs);
    unrefTimerHandle(timer);
    this._transactionMessageRetries.set(timer, resend);
    // After the timer is tracked: a listener closing the link must find it
    // in `_transactionMessageRetries`, or it would fire after the close.
    this._chargePoint.notifyTransactionMessageRejected({ ...report, attempt });
  }

  /** #565: a StartTransaction.req was discarded: the messages of its
   *  transaction that follow carry `-1` (1.6 errata 3.18: "SHALL send any
   *  Transaction related messages for this transaction ... with a
   *  transactionId = -1"). */
  private discardedStart(
    start: StartTransactionRequestV16,
    connectorId: number,
  ): void {
    // Recorded only for a queued, held or waiting message that takes its id
    // from this Start (#847): a message built after the discard already
    // carries `-1` (`wireTransactionId`) and has no `startRef`, so nothing
    // would ever consume the entry.
    if (
      !this.hasMessageWaitingOn({
        connectorId,
        idTag: start.idTag,
        startedAt: start.timestamp,
      })
    ) {
      return;
    }
    this.recordStartOutcome(start, connectorId, UNKNOWN_TRANSACTION_ID);
  }

  /**
   * #527, §3.7.1 resends a message only until it "encountered as many
   * failures" as `TransactionMessageAttempts`. This resend already did, the
   * limit having been lowered while it waited: on its interval, in the serial
   * queue or in the offline queue. It ends as after a last attempt, and a
   * replay carries no last error, which is not persisted. A first
   * transmission (no `attempt` above 1) always goes out.
   */
  private discardResendPastLimit(entry: SerialEntry): boolean {
    const attempt = entry.attempt ?? 1;
    if (attempt <= 1) return false;
    const limit = Math.max(
      1,
      this._chargePoint.configuration.transactionMessageAttempts(),
    );
    if (attempt <= limit) return false;
    const attempts = attempt - 1;
    const connectorId = requestConnectorId(entry);
    const { transactionId } = entry.payload as { transactionId?: number };
    const report = {
      connectorId,
      // StartTransaction.req has no id yet: the 1.6 placeholder stands in.
      transactionId: String(transactionId ?? 0),
      action: entry.action as
        "StartTransaction" | "StopTransaction" | "MeterValues",
      reason: "callError" as const,
    };
    this._logger.warn(
      `${entry.action} of transaction ${report.transactionId} discarded after ${attempts} attempt(s): TransactionMessageAttempts is now ${limit}`,
      LogType.TRANSACTION,
    );
    this._chargePoint.notifyTransactionMessageDiscarded({
      ...report,
      ...(entry.lastErrorCode !== undefined && {
        errorCode: entry.lastErrorCode,
      }),
      attempts,
    });
    if (entry.action === OCPPAction.StartTransaction) {
      this.discardedStart(
        entry.payload as StartTransactionRequestV16,
        connectorId,
      );
      this.proceedWithoutStartConf(
        connectorId,
        entry.payload as StartTransactionRequestV16,
      );
    }
    this.releaseHold();
    return true;
  }

  /** #527: the StartTransaction.req was discarded; the transaction it
   *  started, still running on the connector, goes on without a
   *  StartTransaction.conf. Checked here, after the discard's listeners ran:
   *  one may have stopped that transaction or started another, which waits
   *  for its own conf. */
  private proceedWithoutStartConf(
    connectorId: number,
    start: StartTransactionRequestV16,
  ): void {
    const connector = this._chargePoint.getConnector(connectorId);
    if (
      connector?.status === OCPPStatus.Preparing &&
      isRunningTransactionStartedBy(connector.transaction, start)
    ) {
      this._chargePoint.updateConnectorStatus(connectorId, OCPPStatus.Charging);
    }
  }

  /** The charge point's clock (the platform clock for a stand-in without one). */
  private get clock(): SimClock {
    return clockOf(this._chargePoint);
  }

  private isCallAllowed(action: OCPPAction): boolean {
    return this._bootGate.isCallAllowed(action);
  }

  private generateMessageId(): string {
    return this._generateMessageId();
  }
}
