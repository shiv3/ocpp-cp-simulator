import type { EventEmitter } from "../../shared/EventEmitter";
import type { IdTokenTypeName } from "../connector/Transaction";
import type {
  ChargePointEvents,
  IncomingCallCompletion,
} from "./ChargePointEvents";

/** What the notifications need from their charge point. */
export interface StationNotificationsHost {
  readonly events: () => EventEmitter<ChargePointEvents>;
}

/**
 * The events the protocol handlers raise on the charge point's behalf
 * (remote start / stop, incoming calls, rejected or discarded transaction
 * messages, authorize results). They only report; nothing here changes the
 * station. The charge point keeps the public methods as thin delegates.
 */
export class StationNotifications {
  constructor(private readonly host: StationNotificationsHost) {}

  notifyRemoteStartReceived(
    connectorId: number,
    tagId: string,
    remoteStartId?: number,
    idTokenType?: IdTokenTypeName,
    groupIdToken?: string,
  ): void {
    this.host.events().emit("remoteStartReceived", {
      connectorId,
      tagId,
      ...(remoteStartId !== undefined ? { remoteStartId } : {}),
      ...(idTokenType !== undefined ? { idTokenType } : {}),
      ...(groupIdToken !== undefined ? { groupIdToken } : {}),
    });
  }

  notifyRemoteStopReceived(connectorId: number, transactionId: number): void {
    this.host
      .events()
      .emit("remoteStopReceived", { connectorId, transactionId });
  }

  notifyIncomingCall(
    action: string,
    payload: unknown,
    messageId?: string,
  ): void {
    this.host
      .events()
      .emit("incomingCallReceived", { action, messageId, payload });
  }

  /** #396: the answer to an incoming CSMS CALL is decided. */
  notifyIncomingCallCompleted(completion: IncomingCallCompletion): void {
    this.host.events().emit("incomingCallCompleted", completion);
  }

  /** Called by StartTransactionResultHandler when StartTransaction.conf
   *  carries a non-Accepted idTagInfo.status (issue #181). */
  notifyStartTransactionNotAccepted(
    connectorId: number,
    status: string,
    stopped: boolean,
    midSession = false,
  ): void {
    this.host.events().emit("startTransactionNotAccepted", {
      connectorId,
      status,
      stopped,
      ...(midSession && { midSession: true as const }),
    });
  }

  /** Called by the handlers on each failed transmission of a
   *  transaction-related message: a 2.x TransactionEvent answered with a
   *  CALLERROR (#490) or left without answer for `MessageTimeout` (#529), a
   *  1.6 StartTransaction, StopTransaction or MeterValues of a transaction
   *  answered with a CALLERROR (#527). Reports only: the transaction is
   *  untouched. */
  notifyTransactionMessageRejected(
    event: ChargePointEvents["transactionMessageRejected"],
  ): void {
    this.host.events().emit("transactionMessageRejected", event);
  }

  /** Called by the handlers when a transaction-related message failed its
   *  last attempt and is dropped (#490, #527). Reports only, like the
   *  above. */
  notifyTransactionMessageDiscarded(
    event: ChargePointEvents["transactionMessageDiscarded"],
  ): void {
    this.host.events().emit("transactionMessageDiscarded", event);
  }

  /** Called by AuthorizeResultHandler when Authorize.conf arrives
   *  (issue #181). Fans out to any in-flight `authorizeAndWait` callers
   *  tagId-matched via the `authorizeResult` event. */
  notifyAuthorizeResult(tagId: string, status: string): void {
    this.host.events().emit("authorizeResult", { tagId, status });
  }
}
