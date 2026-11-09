import type { TransactionEventRequestV201 } from "@ocpp-cp-simulator/ocpp/index";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { MAX_TIMER_MS } from "../../../shared/timers";
import { clockOf, unrefTimerHandle } from "../../../shared/clock";
import type { SimClock, TimerHandle } from "../../../shared/clock";
import type {
  PendingMessage,
  PendingMessageQueue,
} from "../../../domain/transport/PendingMessageQueue";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { V201QueuedAction } from "./offlineReplayV201";

/**
 * One TransactionEvent the station is delivering under E13 (#490, #529),
 * shared by all its transmissions. A message ends once it is settled (a
 * CALLRESULT arrived for any transmission) or discarded; the handler then
 * forgets every transmission of it.
 */
export interface TransactionEventMessage {
  readonly connectorId: number;
  readonly payload: TransactionEventRequestV201;
  /** Transmissions made so far (the latest one's 1-based number). */
  sent: number;
  /** Transmissions already counted as failed (CALLERROR or timeout). */
  failed: number;
  /** Message ids of the transmissions still awaiting an answer. */
  readonly inFlight: Set<string>;
  /** The resend waiting out `MessageAttemptInterval`, if any. */
  resend?: TimerHandle;
  done: boolean;
  /** A behavior's beforeSend dropped a transmission: the message was not
   *  refused by the socket, it was withdrawn on purpose. */
  droppedByBehavior?: boolean;
  /** #554: the E11 queue row this message is a replay of. The row stays in
   *  the table until the CSMS answers (or the message is discarded); a
   *  close hands it back to the queue instead of adding a second one. */
  queueRowId?: string;
}

/** How the logs name a TransactionEvent. */
function describeTransactionEvent(
  payload: TransactionEventRequestV201,
): string {
  return `TransactionEvent ${payload.eventType} (seqNo ${payload.seqNo}) of transaction ${payload.transactionInfo.transactionId}`;
}

/** Where a TransactionEvent CALL stands in its E13 delivery (#490). */
export interface TransactionEventDelivery {
  readonly message: TransactionEventMessage;
  /** 1-based transmission number of this CALL. */
  readonly attempt: number;
}

export type TransactionEventFailure =
  | { reason: "callError"; errorCode: string }
  | { reason: "timeout"; seconds: number };

/** What the TransactionEvent delivery needs from the handler. */
export interface TransactionEventDeliveryContext {
  readonly chargePoint: Pick<
    ChargePoint,
    | "clock"
    | "configuration"
    | "notifyTransactionMessageDiscarded"
    | "notifyTransactionMessageRejected"
  >;
  readonly logger: Logger;
  readonly webSocket: Pick<OCPPWebSocket, "isConnected">;
  /** The E11 offline queue (#528). */
  readonly pendingQueue: PendingMessageQueue<V201QueuedAction>;
  /** The handler's written CALLs awaiting their answer, by message id. */
  readonly pendingRequests: Pick<
    Map<string, { readonly timeout?: TimerHandle }>,
    "get" | "delete"
  >;
  /** Whether `onWebSocketClosed` handled the current outage (#528). */
  isOutageHandled(): boolean;
  generateMessageId(): string;
  send(
    action: "TransactionEvent",
    messageId: string,
    payload: TransactionEventRequestV201,
    onDropped: (reason: string) => void,
    transactionEvent: TransactionEventDelivery,
  ): void;
  /** Free the §4.1.1 slot `messageId` holds (#708). */
  releaseCall(messageId: string, pump?: boolean): void;
  /** Send the next CALL waiting for the slot (#708). */
  pumpCalls(): void;
}

/**
 * The E13 delivery of the TransactionEvents the 2.x handler builds (#490,
 * #529): transmissions, MessageTimeout, resends and discards, and their
 * E11 offline queueing and replay (#528, #554), thinning included (#877).
 */
export class TransactionEventDeliveryV201 {
  private readonly _chargePoint: TransactionEventDeliveryContext["chargePoint"];
  private readonly _logger: Logger;
  private readonly _webSocket: TransactionEventDeliveryContext["webSocket"];
  private readonly _pendingQueue: PendingMessageQueue<V201QueuedAction>;
  private readonly _pendingRequests: TransactionEventDeliveryContext["pendingRequests"];
  /** Every TransactionEvent not yet settled, discarded or queued, in
   *  creation order (#528): a close queues them all (E11.FR.01/07). */
  private readonly _activeTransactionEvents =
    new Set<TransactionEventMessage>();
  /** True while TransactionEvents wait in the E11 queue for their replay
   *  (#528): set when one is queued (or a restart finds persisted ones),
   *  re-derived from the queued TransactionEvent rows after each replay.
   *  While set, a new TransactionEvent joins the queue so the order holds.
   *  Queued NotifyEvents (#538) never set it, so they cannot hold
   *  TransactionEvents back. */
  private _awaitingReplay: boolean;
  /** Updated TransactionEvents dropped from the full queue since the last
   *  replay (#554, E11.FR.04/05); reported and reset by `flushPendingQueue`. */
  private _droppedTransactionEvents = 0;
  /** E11.FR.05 thinning cursor: index into the idle queued `Updated` rows
   *  of the next row to drop; 1 at the start of an outage. */
  private _thinningCursor = 1;

  constructor(private readonly ctx: TransactionEventDeliveryContext) {
    this._chargePoint = ctx.chargePoint;
    this._logger = ctx.logger;
    this._webSocket = ctx.webSocket;
    this._pendingQueue = ctx.pendingQueue;
    this._pendingRequests = ctx.pendingRequests;
    this._awaitingReplay = this.hasIdleQueuedTransactionEvents();
  }

  /** The charge point's clock (the platform clock for a stand-in without one). */
  private get clock(): SimClock {
    return clockOf(this._chargePoint);
  }

  private clearTimer(handle: TimerHandle | undefined): void {
    if (handle !== undefined) this.clock.clearTimeout(handle);
  }

  private get _outageHandled(): boolean {
    return this.ctx.isOutageHandled();
  }

  private generateMessageId(): string {
    return this.ctx.generateMessageId();
  }

  private send(
    action: "TransactionEvent",
    messageId: string,
    payload: TransactionEventRequestV201,
    onDropped: (reason: string) => void,
    transactionEvent: TransactionEventDelivery,
  ): void {
    this.ctx.send(action, messageId, payload, onDropped, transactionEvent);
  }

  private releaseCall(messageId: string, pump = true): void {
    this.ctx.releaseCall(messageId, pump);
  }

  private pumpCalls(): void {
    this.ctx.pumpCalls();
  }

  /** The TransactionEvents not yet settled, discarded or queued, in
   *  creation order: a later one waits for them (E13, #708). */
  public get active(): ReadonlySet<TransactionEventMessage> {
    return this._activeTransactionEvents;
  }

  /** Start delivering a TransactionEvent built by this handler (#490).
   *  #528: while the E11 queue holds events waiting for their replay, a new
   *  one joins them, so the CSMS still gets them in the order they were
   *  produced. */
  public sendTransactionEventCall(
    connectorId: number,
    payload: TransactionEventRequestV201,
  ): void {
    const message = this.newTransactionEventMessage(connectorId, payload);
    if (this._awaitingReplay) {
      this.queueTransactionEvent(message);
      return;
    }
    this.transmitTransactionEvent(message);
  }

  private newTransactionEventMessage(
    connectorId: number,
    payload: TransactionEventRequestV201,
  ): TransactionEventMessage {
    const message: TransactionEventMessage = {
      connectorId,
      payload,
      sent: 0,
      failed: 0,
      inFlight: new Set(),
      done: false,
    };
    this._activeTransactionEvents.add(message);
    return message;
  }

  /** Send the next transmission of `message` (#490). Each transmission is a
   *  new CALL with a new message id (OCPP-J Part 4 §4.1.4: "This also
   *  applies to retries"); the payload, seqNo included, is the same object
   *  every time. */
  private transmitTransactionEvent(message: TransactionEventMessage): void {
    const attempt = ++message.sent;
    const messageId = this.generateMessageId();
    message.inFlight.add(messageId);
    this.send(
      "TransactionEvent",
      messageId,
      message.payload,
      (reason) => {
        message.inFlight.delete(messageId);
        this.onTransmissionDropped(message, attempt, reason);
      },
      { message, attempt },
    );
  }

  /**
   * A transmission never reached the wire.
   *
   * #528, E11.FR.01: when the connection is going down (socket no longer
   * open, or the close draining the network-sim pipeline), the message is
   * queued for the replay. Until `onWebSocketClosed` has handled this
   * outage it stays tracked, so that close queues it with the older
   * unanswered events, in creation order; a network-sim cut drains the
   * pipeline while the socket is still OPEN and closes it on a later task.
   *
   * With the socket still up (an overflowing network-sim queue), a first
   * transmission is lost silently and a resend is logged as lost (#490).
   */
  private onTransmissionDropped(
    message: TransactionEventMessage,
    attempt: number,
    reason: string,
  ): void {
    const goingOffline =
      reason === "socket_closed" ||
      reason === "disposed" ||
      !this._webSocket.isConnected();
    if (!message.done && goingOffline) {
      if (this._outageHandled) this.queueTransactionEvent(message);
      return;
    }
    if (reason === "dropped_by_behavior") message.droppedByBehavior = true;
    if (attempt === 1) {
      if (!message.done) {
        // #554 with #708: a replay that waited for the slot and was refused
        // only now keeps its row, as one refused at the hand-over does.
        const rowId = message.queueRowId;
        message.queueRowId = undefined;
        this.forgetTransactionEvent(message);
        if (rowId !== undefined && this._pendingQueue.release(rowId)) {
          this._awaitingReplay = true;
          this._logger.warn(
            `[v2.0.1] Replay of ${describeTransactionEvent(message.payload)} refused by the socket; kept in the queue (size=${this._pendingQueue.size()})`,
            LogType.TRANSACTION,
          );
        }
      }
      return;
    }
    this.warnResendLost(message.payload, attempt, `dropped: ${reason}`);
    // A timed-out transmission still on the wire keeps the message open:
    // its late answer can still settle it. It no longer holds the later
    // events back, though: no further attempt is scheduled.
    if (message.inFlight.size === 0) this.forgetTransactionEvent(message);
    else this.pumpCalls();
  }

  /**
   * #528, OCPP 2.0.1 / 2.1 E11.FR.01: queue a TransactionEvent the CSMS has
   * not settled, once. Its transmissions are forgotten (a late answer to
   * one is ignored) and its waiting resend is cancelled; the replay starts
   * its E13 delivery anew. The payload is stored as it was last sent or
   * built: without `offline` for an event not yet replayed, with
   * `offline: true` for a replay queued again by a new close. The replay
   * sets `offline: true` either way.
   */
  private queueTransactionEvent(message: TransactionEventMessage): void {
    if (message.done) return;
    // #554: a replay still unanswered keeps its row; the close hands it
    // back in its place instead of queueing it a second time.
    const rowId = message.queueRowId;
    message.queueRowId = undefined;
    this.forgetTransactionEvent(message);
    if (rowId !== undefined && this._pendingQueue.release(rowId)) {
      this._awaitingReplay = true;
      this._logger.warn(
        `[v2.0.1] ${describeTransactionEvent(message.payload)} unanswered when the connection was lost; kept in the queue (size=${this._pendingQueue.size()})`,
        LogType.TRANSACTION,
      );
      return;
    }
    if (!this.makeRoomForTransactionEvent(message)) {
      this._awaitingReplay = this.hasIdleQueuedTransactionEvents();
      return;
    }
    this._awaitingReplay = true;
    this._pendingQueue.enqueue({
      action: "TransactionEvent",
      payload: message.payload,
      connectorId: message.connectorId,
    });
    this._logger.warn(
      `[v2.0.1] ${describeTransactionEvent(message.payload)} queued while offline; queue size=${this._pendingQueue.size()}`,
      LogType.TRANSACTION,
    );
  }

  /** TransactionEvents in the E11 queue that no replay has in flight (#554):
   *  the ones a new TransactionEvent must queue behind. */
  private hasIdleQueuedTransactionEvents(): boolean {
    return this._pendingQueue.idleRows("TransactionEvent").length > 0;
  }

  /**
   * #554, E11.FR.04 / E11.FR.05: keep the E11 queue under
   * `OfflineQueueMaxEvents` (0 = no limit). With the queue full, only an
   * `Updated` event is dropped, never a `Started` or `Ended`. E11.FR.05
   * fixes the order: intermediate messages first (the 2nd, 4th, 6th, ...),
   * not from the start of the queue and not by refusing new messages. The
   * candidates are the idle queued `Updated` rows in queue order (`D`); a
   * cursor `k` (1 at the start of an outage) picks `D[k]` and advances. The
   * list shifts left after each drop, so successive drops remove the 2nd,
   * 4th, 6th, ... original rows; at the end of `D` the cursor wraps to 1,
   * which halves the density again. `D[0]` goes only when it is the only
   * candidate. The new event is always queued, unless it is an `Updated` and
   * no idle queued `Updated` exists; a new `Started` or `Ended` is queued
   * past the limit when nothing can go. Rows are dropped until the queue is
   * under the limit, so a queue left above it (events queued past it, rows
   * loaded after a restart) shrinks back. A row whose replay awaits its
   * answer is not dropped. The dropped events leave a `seqNo` gap the CSMS
   * can see. Returns whether `message` may be queued.
   */
  private makeRoomForTransactionEvent(
    message: TransactionEventMessage,
  ): boolean {
    const limit = this._chargePoint.configuration.offlineQueueMaxEvents();
    if (limit <= 0) return true;
    const isUpdated = (p: unknown) =>
      (p as TransactionEventRequestV201).eventType === "Updated";
    while (this._pendingQueue.payloadsOf("TransactionEvent").length >= limit) {
      const candidates = this._pendingQueue.idleRows(
        "TransactionEvent",
        isUpdated,
      );
      if (candidates.length > 1 && this._thinningCursor >= candidates.length) {
        this._thinningCursor = 1;
      }
      const victim =
        candidates.length > 1
          ? candidates[this._thinningCursor]
          : candidates[0];
      const first = this._droppedTransactionEvents === 0;
      if (victim !== undefined) {
        const dropped = this._pendingQueue.payloadOfRow(victim);
        this._pendingQueue.remove(victim);
        if (candidates.length > 1) this._thinningCursor += 1;
        this.noteDroppedTransactionEvent(
          first,
          message.payload,
          limit,
          dropped as TransactionEventRequestV201 | undefined,
        );
        continue;
      }
      this._thinningCursor = 1;
      if (message.payload.eventType === "Updated") {
        this.noteDroppedTransactionEvent(first, message.payload, limit);
        return false;
      }
      this._logger.warn(
        `[v2.0.1] ${describeTransactionEvent(message.payload)} queued past the limit of ${limit}: only Updated events are dropped (E11.FR.05)`,
        LogType.TRANSACTION,
      );
      return true;
    }
    return true;
  }

  private noteDroppedTransactionEvent(
    first: boolean,
    payload: TransactionEventRequestV201,
    limit: number,
    dropped?: TransactionEventRequestV201,
  ): void {
    this._droppedTransactionEvents += 1;
    if (!first) return;
    this._logger.warn(
      `[v2.0.1] Offline queue full (${limit} TransactionEvents, OfflineQueueMaxEvents): dropping Updated events until the connection is back, while keeping Started and Ended (E11.FR.04/05); triggered by ${describeTransactionEvent(payload)}${dropped ? `; first dropped: ${describeTransactionEvent(dropped)}` : ""}`,
      LogType.TRANSACTION,
    );
  }

  /**
   * #554, E14: whether TransactionEvents are still to be delivered, for
   * `transactionId` or, without one, for any transaction: queued ones
   * (replay in flight included, as the CSMS has not answered) and live ones
   * not yet settled.
   */
  public hasTransactionEventsToDeliver(transactionId?: string): boolean {
    const matches = (p: TransactionEventRequestV201) =>
      transactionId === undefined ||
      p.transactionInfo.transactionId === transactionId;
    for (const payload of this._pendingQueue.payloadsOf("TransactionEvent")) {
      if (matches(payload as TransactionEventRequestV201)) return true;
    }
    for (const message of this._activeTransactionEvents) {
      if (matches(message.payload)) return true;
    }
    return false;
  }

  /**
   * #529: OCPP 2.0.1 / 2.1 E13 (2.0.1 Table 120 / 2.1 E13 use case,
   * Description and Remark) also
   * resends a transaction-related message the CSMS "does not reply [to]
   * within the MessageTimeout"; OCPP-J Part 4 §4.1.1 calls such a CALL timed
   * out. `OCPPCommCtrlr.MessageTimeout[Default]` is read at each
   * transmission. The pending entry stays, so a late answer can still
   * settle the message. Armed when the CALL is written (the caller has
   * checked the message is not done); the timer lives in the pending entry.
   */
  public armTransactionEventTimeout(
    delivery: TransactionEventDelivery,
    messageId: string,
  ): TimerHandle {
    const seconds = this._chargePoint.configuration.messageTimeout();
    const timer = this.clock.setTimeout(
      () => {
        // Part 4 §4.1.1: a CALL that timed out frees the slot (#708).
        this.releaseCall(messageId, false);
        this.onTransactionEventFailure(delivery, {
          reason: "timeout",
          seconds,
        });
        this.pumpCalls();
      },
      Math.min(Math.max(1, seconds) * 1000, MAX_TIMER_MS),
    );
    unrefTimerHandle(timer);
    return timer;
  }

  /** A transmission got its answer: its timeout no longer applies. */
  public endTransmission(
    messageId: string,
    { message }: TransactionEventDelivery,
    timeout: TimerHandle | undefined,
  ): void {
    message.inFlight.delete(messageId);
    this.clearTimer(timeout);
  }

  /** Settle or discard `message`: cancel its waiting resend and forget all
   *  its transmissions, so a later answer to any of them is ignored. */
  public forgetTransactionEvent(message: TransactionEventMessage): void {
    message.done = true;
    this._activeTransactionEvents.delete(message);
    if (message.resend !== undefined) {
      this.clock.clearTimeout(message.resend);
      message.resend = undefined;
    }
    for (const id of message.inFlight) {
      this.clearTimer(this._pendingRequests.get(id)?.timeout);
      this._pendingRequests.delete(id);
      // Its timer is gone; nothing may keep the one-CALL slot (#708).
      this.releaseCall(id, false);
    }
    message.inFlight.clear();
    // #554: settled or discarded, the replayed event leaves the table now.
    if (message.queueRowId !== undefined) {
      this._pendingQueue.remove(message.queueRowId);
      message.queueRowId = undefined;
    }
    // A later message may have waited for this one (E13, #708).
    this.pumpCalls();
  }

  /**
   * #490 / #529, OCPP 2.0.1 / 2.1 E13.FR.02-04: a transmission of a
   * TransactionEvent failed — a CALLERROR answered it (the CSMS failed to
   * process it) or no answer came within `MessageTimeout`. The station
   * resends it after `OCPPCommCtrlr.MessageAttemptInterval[TransactionEvent]`
   * seconds times the number of transmissions so far, up to
   * `MessageAttempts[TransactionEvent]` transmissions, then discards it.
   * The transaction keeps running either way, as on 1.6 since #527.
   *
   * Each transmission counts as failed once: a CALLERROR arriving for a
   * transmission that already timed out changes nothing, and neither does
   * any failure once the message is settled or discarded.
   *
   * While a message waits for its resend, the next TransactionEvent waits
   * too (`nextEligibleCall`, #708): E13 delivers transaction-related
   * messages one after the other, so `Ended` does not overtake a resent
   * `Started`. Both settings are read here, so a SetVariables applies to
   * the next failure.
   */
  public onTransactionEventFailure(
    delivery: TransactionEventDelivery,
    failure: TransactionEventFailure,
  ): void {
    const { message, attempt } = delivery;
    if (message.done || attempt <= message.failed) return;
    message.failed = attempt;
    const { connectorId, payload } = message;
    const report = {
      connectorId,
      transactionId: payload.transactionInfo.transactionId,
      action: "TransactionEvent" as const,
      eventType: payload.eventType,
      reason: failure.reason,
      ...(failure.reason === "callError"
        ? { errorCode: failure.errorCode }
        : {}),
    };
    const [cause, what] =
      failure.reason === "callError"
        ? [failure.errorCode, `answered with CALLERROR ${failure.errorCode}`]
        : [
            `no answer within ${failure.seconds}s`,
            `got no answer within ${failure.seconds}s`,
          ];
    const config = this._chargePoint.configuration;
    const attempts = Math.max(1, config.transactionMessageAttempts());
    this._chargePoint.notifyTransactionMessageRejected({ ...report, attempt });
    if (attempt >= attempts) {
      this._logger.warn(
        `[v2.0.1] ${describeTransactionEvent(payload)} discarded after ${attempt} attempt(s): ${cause}`,
        LogType.TRANSACTION,
      );
      this.forgetTransactionEvent(message);
      this._chargePoint.notifyTransactionMessageDiscarded({
        ...report,
        attempts: attempt,
      });
      return;
    }
    const delayMs = Math.min(
      Math.max(0, config.transactionMessageRetryInterval()) * attempt * 1000,
      MAX_TIMER_MS,
    );
    this._logger.warn(
      `[v2.0.1] ${describeTransactionEvent(payload)} ${what}; attempt ${attempt + 1}/${attempts} in ${delayMs / 1000}s`,
      LogType.TRANSACTION,
    );
    const timer = this.clock.setTimeout(() => {
      message.resend = undefined;
      this.transmitTransactionEvent(message);
    }, delayMs);
    unrefTimerHandle(timer);
    message.resend = timer;
  }

  /** A resend that will never reach the CSMS: logged, no domain event. */
  private warnResendLost(
    payload: TransactionEventRequestV201,
    attempt: number,
    outcome: string,
  ): void {
    this._logger.warn(
      `[v2.0.1] ${describeTransactionEvent(payload)}: attempt ${attempt} ${outcome}`,
      LogType.TRANSACTION,
    );
  }

  /**
   * #537: a TransactionEvent is active — awaiting its write (network-sim
   * latency can hold it), its answer, or the end of
   * `MessageAttemptInterval` before its resend (#490). A close would not
   * lose it: the E11 queue takes it and replays it after the next accepted
   * boot (#528). The renewed-certificate reconnect still waits for it, so
   * as not to mark offline and resend an event the CSMS was about to
   * settle. Queued events awaiting their replay do not count: they replay
   * after the reconnect's boot anyway.
   */
  public hasTransactionMessagesInFlight(): boolean {
    return this._activeTransactionEvents.size > 0;
  }

  /** #528, E11.FR.01 / E11.FR.07: the connection closed; queue every
   *  TransactionEvent the CSMS has not settled, in creation order. */
  public queueUnsettled(): void {
    for (const message of [...this._activeTransactionEvents]) {
      this.queueTransactionEvent(message);
    }
  }

  /** #554: report the Updated events the full queue dropped during the
   *  outage, and start the E11.FR.05 thinning over. */
  public reportOutageDrops(): void {
    if (this._droppedTransactionEvents > 0) {
      this._logger.warn(
        `[v2.0.1] Dropped ${this._droppedTransactionEvents} Updated TransactionEvent(s) during the outage (queue limit ${this._chargePoint.configuration.offlineQueueMaxEvents()}); the seqNo of the transaction has gaps`,
        LogType.TRANSACTION,
      );
      this._droppedTransactionEvents = 0;
    }
    this._thinningCursor = 1;
  }

  /** After a replay pass, a new TransactionEvent waits only behind the
   *  queued ones no replay has in flight (#528, #554). */
  public refreshAwaitingReplay(): void {
    this._awaitingReplay = this.hasIdleQueuedTransactionEvents();
  }

  /** #528, E11.FR.02 / E11.FR.07: replay a queued TransactionEvent with
   *  `offline = true`, as a fresh E13 delivery. */
  public replay(
    queued: PendingMessage<V201QueuedAction>,
    rowId: string,
  ): "replayed" | "held" {
    const payload: TransactionEventRequestV201 = {
      ...(queued.payload as TransactionEventRequestV201),
      offline: true,
    };
    const message = this.newTransactionEventMessage(
      queued.connectorId ?? 0,
      payload,
    );
    this.transmitTransactionEvent(message);
    // Written, or dropped by a close (still tracked: that close queues
    // it again), the message is open. Done right away means the socket
    // refused it while staying up: keep the row instead of losing it.
    if (message.done && this._webSocket.isConnected()) {
      if (message.droppedByBehavior) {
        // Withdrawn on purpose by a behavior's beforeSend, not refused:
        // the row is spent, or it would block every later event.
        this._logger.warn(
          `[v2.0.1] Replay of ${describeTransactionEvent(payload)} dropped by a behavior's beforeSend; removed from the queue`,
          LogType.TRANSACTION,
        );
        this._pendingQueue.remove(rowId);
        return "replayed";
      }
      this._awaitingReplay = true;
      this._logger.warn(
        `[v2.0.1] Replay of ${describeTransactionEvent(payload)} refused by the socket; kept at the head of the queue (size=${this._pendingQueue.size()})`,
        LogType.TRANSACTION,
      );
      return "held";
    }
    // #554: the row stays until the CSMS answers. Set after the write,
    // so a drop during it (a refusal above) cannot delete the row.
    if (message.done) return "held";
    this._pendingQueue.markDelivering(rowId);
    message.queueRowId = rowId;
    return "replayed";
  }
}
