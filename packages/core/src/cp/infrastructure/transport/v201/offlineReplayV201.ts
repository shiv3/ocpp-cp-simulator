import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type {
  PendingMessage,
  PendingMessageQueue,
} from "../../../domain/transport/PendingMessageQueue";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { V201Action } from "./inboundRegistryV201";
import type { TransactionEventDeliveryV201 } from "./transactionEventDeliveryV201";
import type { EventQueuesV201 } from "./eventQueuesV201";

/** Actions the 2.x handler queues offline and replays (#528, E11; #538,
 *  N07.FR.04; #552, A04.FR.02). Any other row in `pending_messages` was queued by the 1.6
 *  handler under the same charge point id: the queue deletes it on load. */
export type V201QueuedAction = Extract<
  V201Action,
  "TransactionEvent" | "NotifyEvent" | "SecurityEventNotification"
>;
export const QUEUED_ON_OCPP2: ReadonlySet<V201QueuedAction> = new Set([
  "TransactionEvent",
  "NotifyEvent",
  "SecurityEventNotification",
]);

/** What the E11 replay needs from the handler. */
export interface OfflineReplayContext {
  readonly logger: Logger;
  readonly webSocket: Pick<OCPPWebSocket, "isConnected">;
  /** The E11 offline queue (#528). */
  readonly pendingQueue: PendingMessageQueue<V201QueuedAction>;
  readonly transactionEvents: Pick<
    TransactionEventDeliveryV201,
    "refreshAwaitingReplay" | "replay" | "reportOutageDrops"
  >;
  readonly eventQueues: Pick<
    EventQueuesV201,
    "replayNotifyEvent" | "replaySecurityEvent" | "reportOutageDrops"
  >;
  /** The connection is live again: a drop no longer queues by itself, the
   *  next close does (#528). */
  markOutageOver(): void;
}

/**
 * The replay of the E11 offline queue after Boot Accepted (#528, #538,
 * #552, #554): each queued row goes to the block that owns its action, in
 * queue order (#877).
 */
export class OfflineReplayV201 {
  private readonly _logger: Logger;
  private readonly _webSocket: OfflineReplayContext["webSocket"];
  private readonly _pendingQueue: PendingMessageQueue<V201QueuedAction>;
  private readonly _transactionEvents: OfflineReplayContext["transactionEvents"];
  private readonly _eventQueues: OfflineReplayContext["eventQueues"];

  constructor(private readonly ctx: OfflineReplayContext) {
    this._logger = ctx.logger;
    this._webSocket = ctx.webSocket;
    this._pendingQueue = ctx.pendingQueue;
    this._transactionEvents = ctx.transactionEvents;
    this._eventQueues = ctx.eventQueues;
  }

  /**
   * #528, OCPP 2.0.1 / 2.1 E11.FR.02: once BootNotification is Accepted,
   * send the queued TransactionEvents in order, each with `offline = true`
   * (E11.FR.07: a queued message is set Offline). The seqNo is the one the
   * event was built with. Each replay is a fresh E13 delivery: its
   * transmission and failure counts restart at zero, as a 1.6 replay goes
   * through `sendRequest` anew. A row stays in the queue until the CSMS answers
   * it or E13 discards it (#554); a close before the answer puts the same
   * row back in its old position. A
   * replay the socket refuses while it stays open (`not_accepted`, a
   * network-sim overflow) stays at the head and the replay stops there, so
   * the order holds; it waits for the next Boot Accepted. E13 owns the
   * attempt counting, so the queue's own limit is off. Queued NotifyEvents
   * (#538, N07.FR.04) replay in the same pass, in the order they were
   * queued among the TransactionEvents.
   */
  public flushPendingQueue(): void {
    if (!this._webSocket.isConnected()) return;
    // The connection is live: a replay dropped from here on waits for the
    // next close to be queued again, so this loop never feeds itself.
    this.ctx.markOutageOver();
    this._transactionEvents.reportOutageDrops();
    this._eventQueues.reportOutageDrops();
    let replayed = 0;
    this._pendingQueue.replay((queued, rowId) => {
      if (!this._webSocket.isConnected()) return false;
      if (this.replayQueued(queued, rowId) === "held") return false;
      replayed += 1;
      return true;
    });
    this._transactionEvents.refreshAwaitingReplay();
    if (replayed > 0) {
      this._logger.info(
        `[v2.0.1] Replayed ${replayed} queued message(s); ${this._pendingQueue.size()} left`,
        LogType.OCPP,
      );
    }
  }

  /** Send one queued message again. Each queued action gets its own case. */
  private replayQueued(
    queued: PendingMessage<V201QueuedAction>,
    rowId: string,
  ): "replayed" | "held" {
    switch (queued.action) {
      case "TransactionEvent": {
        return this._transactionEvents.replay(queued, rowId);
      }
      case "NotifyEvent": {
        // A NotifyEvent has no E13 delivery: its row leaves once answered.
        return this._eventQueues.replayNotifyEvent(queued, rowId);
      }
      case "SecurityEventNotification": {
        // Like a NotifyEvent, its row leaves once answered (#552, #554, #664).
        return this._eventQueues.replaySecurityEvent(queued, rowId);
      }
    }
  }
}
