/**
 * The SOAP client's outbound request chain: one HTTP exchange at a time,
 * gated by the boot gate, with the OCPP-S 1.6 errata 3.2 retry of
 * transaction-related messages (#585). `OCPPSoapHandler` builds the
 * payloads and owns the HTTP exchange (`postSoap`); this queue orders the
 * exchanges and decides what a failure does.
 */
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { TransactionMessageAction } from "../../../domain/charge-point/ChargePointEvents";
import type { Transaction } from "../../../domain/connector/Transaction";
import { OCPPAction } from "../../../domain/types/OcppTypes";
import { OCPP_1_6_SOAP } from "../../../domain/types/OcppVersion";
import type { BootGate } from "../../../application/state/machines/BootGate";
import { MAX_TIMER_MS } from "../../../shared/timers";
import { unrefTimerHandle } from "../../../shared/clock";
import type { TimerHandle } from "../../../shared/clock";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type { SoapDialect } from "./dialect";
import {
  SoapFaultError,
  type ParsedSoapEnvelope,
  type SoapOperation,
  type SoapPayload,
} from "./soapEnvelope";
import { soapPayload } from "./soapConverters";

export const OPERATION_ACTION: Record<SoapOperation, OCPPAction | null> = {
  Authorize: OCPPAction.Authorize,
  BootNotification: OCPPAction.BootNotification,
  DataTransfer: OCPPAction.DataTransfer,
  DiagnosticsStatusNotification: OCPPAction.DiagnosticsStatusNotification,
  FirmwareStatusNotification: OCPPAction.FirmwareStatusNotification,
  Heartbeat: OCPPAction.Heartbeat,
  MeterValues: OCPPAction.MeterValues,
  StartTransaction: OCPPAction.StartTransaction,
  StatusNotification: OCPPAction.StatusNotification,
  StopTransaction: OCPPAction.StopTransaction,
  CancelReservation: OCPPAction.CancelReservation,
  ChangeAvailability: OCPPAction.ChangeAvailability,
  ChangeConfiguration: OCPPAction.ChangeConfiguration,
  ClearCache: OCPPAction.ClearCache,
  ClearChargingProfile: OCPPAction.ClearChargingProfile,
  GetCompositeSchedule: OCPPAction.GetCompositeSchedule,
  GetConfiguration: OCPPAction.GetConfiguration,
  GetDiagnostics: OCPPAction.GetDiagnostics,
  GetLocalListVersion: OCPPAction.GetLocalListVersion,
  RemoteStartTransaction: OCPPAction.RemoteStartTransaction,
  RemoteStopTransaction: OCPPAction.RemoteStopTransaction,
  ReserveNow: OCPPAction.ReserveNow,
  Reset: OCPPAction.Reset,
  SendLocalList: OCPPAction.SendLocalList,
  SetChargingProfile: OCPPAction.SetChargingProfile,
  TriggerMessage: OCPPAction.TriggerMessage,
  UnlockConnector: OCPPAction.UnlockConnector,
  UpdateFirmware: OCPPAction.UpdateFirmware,
};

/** What a failed exchange reports as `errorCode`: the SOAP Fault code, or the
 *  HTTP status. */
function faultCode(error: SoapFaultError | SoapHttpStatusError): string {
  return error instanceof SoapFaultError
    ? `SOAP Fault ${error.fault.code.replace(/^.*:/, "")}`
    : `HTTP ${error.status}`;
}

/**
 * An HTTP error status that carried no SOAP Fault. OCPP-S 1.6 errata 3.2
 * treats it like a Fault: the CSMS answered, and failed to process the
 * message (#585).
 */
export class SoapHttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SoapHttpStatusError";
  }
}

/**
 * OCPP-S 1.6 errata 3.2 (#585): a transaction-related message a SOAP Fault
 * or an HTTP error status answered is retried. The caller of `enqueueRequest`
 * describes the message; `attempt` is the 1-based transmission.
 */
export interface TransactionRetry {
  readonly action: TransactionMessageAction;
  readonly connectorId: number;
  /** `"0"` for a StartTransaction.req, which has no CSMS id yet. */
  readonly transactionId: string;
  /** StartTransaction only: the transaction it started still runs on the
   *  connector. The first failure marks it (as on OCPP-J, #527). */
  readonly startedTransaction?: () => Transaction | null;
  /** StartTransaction only: the request was discarded; the transaction goes
   *  on without a StartTransaction.conf. */
  readonly proceedWithoutConf?: () => void;
}

interface RetryEntry {
  readonly operation: SoapOperation;
  readonly payload: SoapPayload;
  readonly onResponse: (envelope: ParsedSoapEnvelope) => void;
  readonly retry: TransactionRetry;
  /** Transmission number of the resend. */
  readonly attempt: number;
  readonly errorCode: string;
}

/** What the queue reads and drives on the station: no more. */
export type SoapRequestQueueChargePoint = Pick<
  ChargePoint,
  | "clock"
  | "configuration"
  | "error"
  | "events"
  | "getConnector"
  | "notifyTransactionMessageRejected"
  | "notifyTransactionMessageDiscarded"
>;

export interface SoapRequestQueueContext {
  /** The live station: `error` is a setter, so never a copy of it. */
  readonly chargePoint: SoapRequestQueueChargePoint;
  readonly logger: Logger;
  readonly dialect: Pick<SoapDialect, "version">;
  readonly bootGate: Pick<BootGate, "isCallAllowed" | "status">;
  /** One HTTP exchange; rejects with a `SoapFaultError`, a
   *  `SoapHttpStatusError` or a connection error. */
  readonly postSoap: (
    operation: SoapOperation,
    payload: SoapPayload,
  ) => Promise<ParsedSoapEnvelope>;
}

export class SoapRequestQueue {
  private _requestChain: Promise<void> = Promise.resolve();
  /** #585: resends waiting out `TransactionMessageRetryInterval`. */
  private readonly _transactionRetries = new Map<TimerHandle, RetryEntry>();
  /** Bumped on stop and dispose: a failure handled after it is not retried. */
  private _retryEpoch = 0;
  private readonly _chargePoint: SoapRequestQueueChargePoint;
  private readonly _logger: Logger;
  private readonly _dialect: Pick<SoapDialect, "version">;
  private readonly _bootGate: Pick<BootGate, "isCallAllowed" | "status">;
  private readonly _postSoap: SoapRequestQueueContext["postSoap"];

  constructor(context: SoapRequestQueueContext) {
    this._chargePoint = context.chargePoint;
    this._logger = context.logger;
    this._dialect = context.dialect;
    this._bootGate = context.bootGate;
    this._postSoap = context.postSoap;
  }

  /** The connection was closed (stop or dispose). */
  public onConnectionClosed(): void {
    this._requestChain = Promise.resolve();
    // #585: SOAP has no offline queue to salvage a waiting resend to, so a
    // stop or dispose ends the retry, with a notice.
    this._retryEpoch += 1;
    const waiting = [...this._transactionRetries];
    this._transactionRetries.clear();
    for (const [timer, entry] of waiting) {
      this._chargePoint.clock.clearTimeout(timer);
      this.discardRetry(
        entry,
        entry.attempt - 1,
        "the connection was closed during the retry interval",
        { proceed: false },
      );
    }
  }

  public enqueueRequest(
    operation: SoapOperation,
    payload: SoapPayload,
    onResponse: (envelope: ParsedSoapEnvelope) => void,
    retry?: TransactionRetry,
    attempt = 1,
  ): void {
    const action = OPERATION_ACTION[operation];
    if (action && !this.isCallAllowed(action)) {
      this._logger.warn(
        `Suppressing ${operation}: blocked by the boot gate — BootNotification not yet Accepted (status=${this._bootGate.status.status})`,
        LogType.OCPP,
      );
      return;
    }

    const epoch = this._retryEpoch;
    const run = async () => {
      const response = await this.postSoap(operation, payload);
      onResponse(response);
    };
    this._requestChain = this._requestChain
      .catch(() => undefined)
      .then(run)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this._logger.error(
          `SOAP ${operation} failed: ${message}`,
          LogType.OCPP,
        );
        if (
          retry !== undefined &&
          this._dialect.version === OCPP_1_6_SOAP &&
          (error instanceof SoapFaultError ||
            error instanceof SoapHttpStatusError)
        ) {
          await this.onTransactionMessageFailure(
            {
              operation,
              payload,
              onResponse,
              retry,
              attempt,
              errorCode: faultCode(error),
            },
            epoch,
          );
          return;
        }
        if (operation === "BootNotification") {
          // SOAP has no persistent connection, so there's no `onclose`
          // handler to fall back on the way the WebSocket path has —
          // `connect()` emits "connected" optimistically (before
          // BootNotification round-trips), and without this, a failed
          // round-trip would leave that "connected" state stuck forever,
          // with Connect/Disconnect UI never recovering (#178 C). Mirror
          // the WebSocket path's onclose transition: surface the failure
          // via `error` and flip back with a "disconnected" event.
          this._chargePoint.error = message;
          this._chargePoint.events.emit("disconnected", {
            code: 1006,
            reason: message,
          });
        }
      });
  }

  /**
   * #585, OCPP-S 1.6 errata 3.2: a SOAP Fault or an HTTP error status
   * answered a transaction-related message (StartTransaction.req,
   * StopTransaction.req, MeterValues.req of a transaction). The station
   * "SHALL retry these a couple of times": it sends the message again,
   * through the request chain, waiting `TransactionMessageRetryInterval`
   * seconds times the number of transmissions so far, until
   * `TransactionMessageAttempts` transmissions failed, then discards it
   * with a notice. Errata 3.2 also has the station send a simple message
   * (Heartbeat) to tell a failure to process from a connection issue: when
   * the probe does not reach the CSMS the failure is a connection issue,
   * which is not retried here (SOAP has no offline queue), as before.
   *
   * A StartTransaction.req whose transaction no longer runs is discarded
   * instead of resent, as on OCPP-J (#527): a conf the station would ignore
   * leaves a transaction open on the CSMS. The transaction itself stays as
   * it is, running or ended, whatever the outcome.
   *
   * OCPP 1.2 and 1.5 are left as they are: only the 1.6 errata sheet was
   * checked.
   */
  private async onTransactionMessageFailure(
    failed: RetryEntry,
    epoch: number,
  ): Promise<void> {
    // A stop while the request was in flight: no probe from a stopped CP.
    if (epoch !== this._retryEpoch) {
      this.discardRetry(
        failed,
        failed.attempt,
        "the connection was closed before the retry",
        { proceed: false },
      );
      return;
    }
    const reachable = await this.probeCentralSystem();
    if (epoch !== this._retryEpoch) {
      this.discardRetry(
        failed,
        failed.attempt,
        "the connection was closed before the retry",
        { proceed: false },
      );
      return;
    }
    if (!reachable) {
      this._logger.warn(
        `${failed.retry.action} of transaction ${failed.retry.transactionId} not retried: the Heartbeat probe did not reach the Central System, so this is a connection issue, not a failure to process`,
        LogType.TRANSACTION,
      );
      return;
    }
    const { retry, attempt, errorCode } = failed;
    const started = retry.startedTransaction?.() ?? null;
    if (started) {
      this._chargePoint.getConnector(retry.connectorId)?.markStartCallError();
    }
    const report = {
      connectorId: retry.connectorId,
      transactionId: retry.transactionId,
      action: retry.action,
      reason: "callError" as const,
      errorCode,
    };
    const config = this._chargePoint.configuration;
    const attempts = Math.max(1, config.transactionMessageAttempts());
    const startOutlived =
      retry.startedTransaction !== undefined && started === null;
    if (attempt >= attempts || startOutlived) {
      this._chargePoint.notifyTransactionMessageRejected({
        ...report,
        attempt,
      });
      this.discardRetry(
        failed,
        attempt,
        startOutlived ? "its transaction no longer runs" : errorCode,
      );
      return;
    }
    const delayMs = Math.min(
      Math.max(0, config.transactionMessageRetryInterval()) * attempt * 1000,
      MAX_TIMER_MS,
    );
    this._logger.warn(
      `${retry.action} of transaction ${retry.transactionId} answered with ${errorCode}; attempt ${attempt + 1}/${attempts} in ${delayMs / 1000}s`,
      LogType.TRANSACTION,
    );
    const resend: RetryEntry = { ...failed, attempt: attempt + 1 };
    const timer = this._chargePoint.clock.setTimeout(() => {
      this._transactionRetries.delete(timer);
      this.resendTransactionMessage(resend);
    }, delayMs);
    unrefTimerHandle(timer);
    this._transactionRetries.set(timer, resend);
    // After the timer is registered: a listener that stops the CP finds it
    // and cancels it.
    this._chargePoint.notifyTransactionMessageRejected({ ...report, attempt });
  }

  /** A resend falls due: the transaction may have ended, or the limit been
   *  lowered, while it waited. */
  private resendTransactionMessage(resend: RetryEntry): void {
    const { retry, attempt } = resend;
    if (
      retry.startedTransaction !== undefined &&
      retry.startedTransaction() === null
    ) {
      this.discardRetry(resend, attempt - 1, "its transaction no longer runs");
      return;
    }
    const action = OPERATION_ACTION[resend.operation];
    if (action && !this.isCallAllowed(action)) {
      this.discardRetry(resend, attempt - 1, "blocked by the boot gate");
      return;
    }
    const limit = Math.max(
      1,
      this._chargePoint.configuration.transactionMessageAttempts(),
    );
    if (attempt > limit) {
      this.discardRetry(
        resend,
        attempt - 1,
        `TransactionMessageAttempts is now ${limit}`,
      );
      return;
    }
    this.enqueueRequest(
      resend.operation,
      resend.payload,
      resend.onResponse,
      retry,
      attempt,
    );
  }

  private discardRetry(
    entry: RetryEntry,
    attempts: number,
    cause: string,
    // `proceed: false` on a stop: the discard is announced, but the
    // connector does not move on to Charging after the user disconnected.
    { proceed = true }: { proceed?: boolean } = {},
  ): void {
    const { retry } = entry;
    this._logger.warn(
      `${retry.action} of transaction ${retry.transactionId} discarded after ${attempts} attempt(s): ${cause}`,
      LogType.TRANSACTION,
    );
    this._chargePoint.notifyTransactionMessageDiscarded({
      connectorId: retry.connectorId,
      transactionId: retry.transactionId,
      action: retry.action,
      reason: "callError",
      errorCode: entry.errorCode,
      attempts,
    });
    // After the discard's listeners ran: one may have stopped the
    // transaction or started another, which waits for its own conf.
    if (proceed) retry.proceedWithoutConf?.();
  }

  /** Errata 3.2: a Heartbeat tells a failure to process from a connection
   *  issue. Any answer, a Fault or an HTTP error included, proves the
   *  Central System is reachable. */
  private async probeCentralSystem(): Promise<boolean> {
    try {
      await this.postSoap("Heartbeat", soapPayload({}));
      return true;
    } catch (error) {
      return (
        error instanceof SoapFaultError || error instanceof SoapHttpStatusError
      );
    }
  }

  private postSoap(
    operation: SoapOperation,
    payload: SoapPayload,
  ): Promise<ParsedSoapEnvelope> {
    return this._postSoap(operation, payload);
  }

  private isCallAllowed(action: OCPPAction): boolean {
    return this._bootGate.isCallAllowed(action);
  }
}
