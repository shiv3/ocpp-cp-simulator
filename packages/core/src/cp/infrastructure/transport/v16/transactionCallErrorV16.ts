// The OCPP 1.6 §3.7.1 resend of a transaction-related message after a
// CALLERROR (#527) and its discard limits, split out of SerialCallQueueV16
// (#877). The queue state stays in SerialCallQueueV16; this reaches it only
// through the context below.
import type { StartTransactionRequestV16 } from "@ocpp-cp-simulator/ocpp/index";
import type { OcppMessageRequestPayload } from "../OCPPWebSocket";
import type { Transaction } from "../../../domain/connector/Transaction";
import { isRunningTransactionStartedBy } from "../../../domain/connector/Transaction";
import { MAX_TIMER_MS } from "../../../shared/timers";
import { unrefTimerHandle } from "../../../shared/clock";
import type { SimClock, TimerHandle } from "../../../shared/clock";
import { LogType } from "../../../shared/Logger";
import { OCPPAction, OCPPStatus } from "../../../domain/types/OcppTypes";
import {
  UNKNOWN_TRANSACTION_ID,
  isRetriedOnCallError,
  requestConnectorId,
  type OCPPRequest,
  type SerialEntry,
  type StartRef,
} from "./outboundRequestsV16";
import type { SerialCallQueueV16Context } from "./serialCallQueueV16";

/** What the resend needs from the serial queue; every member reads the
 *  queue's current state (the arrays are reassigned there). */
export interface TransactionCallErrorContextV16 {
  readonly chargePoint: SerialCallQueueV16Context["chargePoint"];
  readonly webSocket: SerialCallQueueV16Context["webSocket"];
  readonly logger: SerialCallQueueV16Context["logger"];
  readonly clock: () => SimClock;
  readonly transactionMessageRetries: Map<TimerHandle, SerialEntry>;
  readonly serialQueue: () => SerialEntry[];
  readonly setSerialQueue: (queue: SerialEntry[]) => void;
  /** `_held ??= []` of the queue: the held list, created when absent. */
  readonly ensureHeld: () => SerialEntry[];
  readonly isCallAllowed: (action: OCPPAction) => boolean;
  readonly salvageOrDiscard: (entry: SerialEntry, reason: string) => void;
  readonly holdToOfflineQueue: (reason: string) => void;
  readonly interceptOutgoing: (
    action: OCPPAction,
    payload: OcppMessageRequestPayload,
    onDropped?: (reason: string) => void,
  ) => OcppMessageRequestPayload | undefined | "dropped";
  readonly pumpSerialQueue: () => void;
  readonly generateMessageId: () => string;
  readonly releaseHold: () => void;
  readonly hasMessageWaitingOn: (ref: StartRef) => boolean;
  readonly recordStartOutcome: (
    start: StartTransactionRequestV16,
    connectorId: number,
    transactionId: number,
  ) => void;
}

export class TransactionCallErrorV16 {
  constructor(private readonly ctx: TransactionCallErrorContextV16) {}

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
      const connector = this.ctx.chargePoint.getConnector(connectorId);
      const current = connector?.transaction;
      const start = request.payload as StartTransactionRequestV16;
      if (connector && isRunningTransactionStartedBy(current, start)) {
        startedTransaction = current;
        connector.markStartCallError();
      }
    }
    const config = this.ctx.chargePoint.configuration;
    const attempts = Math.max(1, config.transactionMessageAttempts());
    if (attempt >= attempts) {
      this.ctx.chargePoint.notifyTransactionMessageRejected({
        ...report,
        attempt,
      });
      this.ctx.logger.warn(
        `${request.action} of transaction ${report.transactionId} discarded after ${attempt} attempt(s): ${errorCode}`,
        LogType.TRANSACTION,
      );
      this.ctx.chargePoint.notifyTransactionMessageDiscarded({
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
      this.ctx.releaseHold();
      return;
    }
    const delayMs = Math.min(
      Math.max(0, config.transactionMessageRetryInterval()) * attempt * 1000,
      MAX_TIMER_MS,
    );
    this.ctx.logger.warn(
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
    const held = this.ctx.ensureHeld();
    const queued = this.ctx.serialQueue().filter(isRetriedOnCallError);
    if (queued.length > 0) {
      this.ctx.setSerialQueue(
        this.ctx.serialQueue().filter((entry) => !isRetriedOnCallError(entry)),
      );
      held.push(...queued);
    }
    const timer = this.ctx.clock().setTimeout(() => {
      this.ctx.transactionMessageRetries.delete(timer);
      // The boot gate closed meanwhile (a BootNotification answered
      // Pending): sendRequest would drop the resend. It waits in the
      // offline queue for the next Accepted instead, as on a close.
      if (!this.ctx.isCallAllowed(resend.action)) {
        this.ctx.salvageOrDiscard(resend, "boot gate");
        this.ctx.holdToOfflineQueue("boot gate");
        return;
      }
      // A resend is a new transmission: the behaviors see it again, starting
      // from the payload as built (the same rule as a replay from the offline
      // queue, and as on 2.x).
      let wire: OcppMessageRequestPayload | undefined;
      if (this.ctx.webSocket.isConnected()) {
        const decision = this.ctx.interceptOutgoing(
          resend.action,
          resend.payload,
        );
        if (decision === "dropped") {
          this.ctx.logger.warn(
            `${resend.action} resend dropped by a behavior's beforeSend; the message is not sent again`,
            LogType.TRANSACTION,
          );
          this.ctx.releaseHold();
          return;
        }
        wire = decision;
      }
      this.ctx.serialQueue().push({
        ...resend,
        ...(wire !== undefined && { wire }),
        id: this.ctx.generateMessageId(),
        intercepted: this.ctx.webSocket.isConnected(),
      });
      this.ctx.pumpSerialQueue();
    }, delayMs);
    unrefTimerHandle(timer);
    this.ctx.transactionMessageRetries.set(timer, resend);
    // After the timer is tracked: a listener closing the link must find it
    // in `_transactionMessageRetries`, or it would fire after the close.
    this.ctx.chargePoint.notifyTransactionMessageRejected({
      ...report,
      attempt,
    });
  }

  /** #565: a StartTransaction.req was discarded: the messages of its
   *  transaction that follow carry `-1` (1.6 errata 3.18: "SHALL send any
   *  Transaction related messages for this transaction ... with a
   *  transactionId = -1"). */
  public discardedStart(
    start: StartTransactionRequestV16,
    connectorId: number,
  ): void {
    // Recorded only for a queued, held or waiting message that takes its id
    // from this Start (#847): a message built after the discard already
    // carries `-1` (`wireTransactionId`) and has no `startRef`, so nothing
    // would ever consume the entry.
    if (
      !this.ctx.hasMessageWaitingOn({
        connectorId,
        idTag: start.idTag,
        startedAt: start.timestamp,
      })
    ) {
      return;
    }
    this.ctx.recordStartOutcome(start, connectorId, UNKNOWN_TRANSACTION_ID);
  }

  /**
   * #527, §3.7.1 resends a message only until it "encountered as many
   * failures" as `TransactionMessageAttempts`. This resend already did, the
   * limit having been lowered while it waited: on its interval, in the serial
   * queue or in the offline queue. It ends as after a last attempt, and a
   * replay carries no last error, which is not persisted. A first
   * transmission (no `attempt` above 1) always goes out.
   */
  public discardResendPastLimit(entry: SerialEntry): boolean {
    const attempt = entry.attempt ?? 1;
    if (attempt <= 1) return false;
    const limit = Math.max(
      1,
      this.ctx.chargePoint.configuration.transactionMessageAttempts(),
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
    this.ctx.logger.warn(
      `${entry.action} of transaction ${report.transactionId} discarded after ${attempts} attempt(s): TransactionMessageAttempts is now ${limit}`,
      LogType.TRANSACTION,
    );
    this.ctx.chargePoint.notifyTransactionMessageDiscarded({
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
    this.ctx.releaseHold();
    return true;
  }

  /** #527: the StartTransaction.req was discarded; the transaction it
   *  started, still running on the connector, goes on without a
   *  StartTransaction.conf. Checked here, after the discard's listeners ran:
   *  one may have stopped that transaction or started another, which waits
   *  for its own conf. */
  public proceedWithoutStartConf(
    connectorId: number,
    start: StartTransactionRequestV16,
  ): void {
    const connector = this.ctx.chargePoint.getConnector(connectorId);
    if (
      connector?.status === OCPPStatus.Preparing &&
      isRunningTransactionStartedBy(connector.transaction, start)
    ) {
      this.ctx.chargePoint.updateConnectorStatus(
        connectorId,
        OCPPStatus.Charging,
      );
    }
  }
}
