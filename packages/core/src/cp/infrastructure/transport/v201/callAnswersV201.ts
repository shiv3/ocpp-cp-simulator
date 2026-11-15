// CALLRESULT / CALLERROR handling of OCPPMessageHandlerV201 (#877): answers
// to the station's own CALLs.
import type {
  AuthorizeRequestV201,
  AuthorizeResponseV201,
  BootNotificationResponseV201,
  HeartbeatResponseV201,
  StatusNotificationResponseV201,
  MeterValuesResponseV201,
  DataTransferResponseV201,
  GetCertificateStatusRequestV201,
  GetCertificateStatusResponseV201,
  SignCertificateRequestV201,
  SignCertificateResponseV201,
  TransactionEventRequestV201,
  TransactionEventResponseV201,
} from "@ocpp-cp-simulator/ocpp/index";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { OCPPStatus } from "../../../domain/types/OcppTypes";
import type { DataTransferResult } from "../../../domain/types/DataTransfer";
import { behaviorTapOf } from "../behaviorTap";
import { recordIdTokenInfo } from "./authorizationCacheV201";
import type { CallWaiters } from "../CallWaiters";
import type { CallErrorFields, ExpertCalls } from "../ExpertCalls";
import type { PendingRequest } from "./callPipelineV201";
import type { CertificateSigningV201 } from "./certificateSigningV201";
import type { TransactionEventDeliveryV201 } from "./transactionEventDeliveryV201";
import type { TransactionMessagesV201 } from "./transactionMessagesV201";

export type V201ResponsePayload =
  | BootNotificationResponseV201
  | HeartbeatResponseV201
  | StatusNotificationResponseV201
  | TransactionEventResponseV201
  | MeterValuesResponseV201
  | AuthorizeResponseV201;

/** What the answer handling needs from the 2.0.1 handler. */
export interface CallAnswersV201Context {
  readonly chargePoint: ChargePoint;
  readonly logger: Logger;
  readonly pendingRequests: Map<string, PendingRequest>;
  readonly statusAcks: Map<string, { connectorId: number; status: OCPPStatus }>;
  readonly expertCalls: ExpertCalls;
  readonly dataTransferWaiters: CallWaiters<DataTransferResult>;
  readonly transactionEvents: TransactionEventDeliveryV201;
  readonly transactionMessages: TransactionMessagesV201;
  readonly certificates: CertificateSigningV201;
}

export class CallAnswersV201 {
  private readonly _chargePoint: ChargePoint;
  private readonly _logger: Logger;
  private readonly _pendingRequests: Map<string, PendingRequest>;
  private readonly _statusAcks: Map<
    string,
    { connectorId: number; status: OCPPStatus }
  >;
  private readonly _expertCalls: ExpertCalls;
  private readonly _dataTransferWaiters: CallWaiters<DataTransferResult>;
  private readonly _transactionEvents: TransactionEventDeliveryV201;
  private readonly _transactionMessages: TransactionMessagesV201;
  private readonly _certificates: CertificateSigningV201;

  constructor(context: CallAnswersV201Context) {
    this._chargePoint = context.chargePoint;
    this._logger = context.logger;
    this._pendingRequests = context.pendingRequests;
    this._statusAcks = context.statusAcks;
    this._expertCalls = context.expertCalls;
    this._dataTransferWaiters = context.dataTransferWaiters;
    this._transactionEvents = context.transactionEvents;
    this._transactionMessages = context.transactionMessages;
    this._certificates = context.certificates;
  }

  public handleCallError(messageId: string, payload: unknown): void {
    this.observeAnswer(messageId, "error", payload);
    const pending = this._pendingRequests.get(messageId);
    this._pendingRequests.delete(messageId);
    this._logger.warn(`[v2.0.1] CALLERROR for ${messageId}`, LogType.OCPP);
    const error = payload as CallErrorFields;
    if (this._expertCalls.claimError(messageId, error)) return;
    if (pending?.transactionEvent) {
      this._transactionEvents.endTransmission(
        messageId,
        pending.transactionEvent,
        pending.timeout,
      );
      this._transactionEvents.onTransactionEventFailure(
        pending.transactionEvent,
        {
          reason: "callError",
          errorCode: error.errorCode ?? "GenericError",
        },
      );
      return;
    }
    if (pending?.action === "DataTransfer") {
      this._dataTransferWaiters.reject(
        messageId,
        new Error(
          `DataTransfer ${messageId} answered with CALLERROR ${error.errorCode ?? "?"}: ${error.errorDescription ?? ""}`,
        ),
      );
    }

    // Issue #181: a CALLERROR answering Authorize.req is a definite
    // protocol failure, unlike the authorizeAndWait paths where the CSMS
    // said nothing at all (#452: a disconnect applies the offline
    // rules; a timeout refuses a tag known locally as NOT valid and
    // otherwise proceeds as "Accepted"). Here the CSMS *did* respond,
    // and what it said was "I couldn't process this" — so treat it as
    // fail-CLOSED:
    // synthesize a denial ("Invalid") rather than let authorizeAndWait
    // burn its full timeout waiting for a CALLRESULT that will never
    // arrive.
    if (pending?.action === "Authorize") {
      const authorizeRequest = pending.payload as AuthorizeRequestV201;
      this._chargePoint.notifyAuthorizeResult(
        authorizeRequest.idToken.idToken,
        "Invalid",
      );
    }
  }

  /** Tell the behaviors' `callResult` hooks the CSMS answered one of our CALLs. */
  public observeAnswer(
    messageId: string,
    outcome: "result" | "error",
    payload: unknown,
  ): void {
    const pending = this._pendingRequests.get(messageId);
    if (!pending) return;
    behaviorTapOf(this._chargePoint).observe({
      type: "callResult",
      action: pending.action,
      messageId,
      outcome,
      payload,
    });
  }

  public handleCallResult(
    messageId: string,
    payload: V201ResponsePayload,
  ): void {
    const pending = this._pendingRequests.get(messageId);
    this._pendingRequests.delete(messageId);

    const statusAck = this._statusAcks.get(messageId);
    if (statusAck) {
      this._statusAcks.delete(messageId);
      this._chargePoint.noteStatusAcknowledged(
        statusAck.connectorId,
        statusAck.status,
      );
    }

    if (this._expertCalls.claimResult(messageId, payload)) return;

    if (pending?.action === "DataTransfer") {
      const answer = payload as DataTransferResponseV201;
      this._logger.info(
        `[v2.0.1] DataTransfer response: ${JSON.stringify(answer)}`,
        LogType.OCPP,
      );
      this._dataTransferWaiters.resolve(messageId, {
        status: answer.status,
        ...(answer.data !== undefined ? { data: answer.data } : {}),
      });
      return;
    }

    // Issue #181: correlate Authorize.conf back to the idToken from the
    // original Authorize.req (AuthorizeResponseV201 itself carries none)
    // and fan it out via the same `authorizeResult` event/notify path the
    // v16 AuthorizeResultHandler uses, so `ChargePoint.authorizeAndWait`
    // (the #181 local-authorize gate) resolves promptly for v2.0.1/2.1
    // local starts instead of always timing out.
    if (pending?.action === "Authorize") {
      const authorizeResult = payload as AuthorizeResponseV201;
      const authorizeRequest = pending.payload as AuthorizeRequestV201;
      const status = authorizeResult.idTokenInfo?.status;
      recordIdTokenInfo(
        this._chargePoint,
        authorizeRequest.idToken,
        authorizeResult.idTokenInfo,
      );
      if (status !== undefined) {
        this._logger.info(
          `[v2.0.1] Authorize response: ${status}`,
          LogType.OCPP,
        );
        this._chargePoint.notifyAuthorizeResult(
          authorizeRequest.idToken.idToken,
          status,
        );
      }
      return;
    }

    if (pending?.action === "GetCertificateStatus") {
      this._certificates.applyCertificateStatusResult(
        pending.payload as GetCertificateStatusRequestV201,
        payload as GetCertificateStatusResponseV201,
      );
      return;
    }

    if (pending?.action === "SignCertificate") {
      this._certificates.applySignCertificateResult(
        pending.payload as SignCertificateRequestV201,
        payload as SignCertificateResponseV201,
      );
      return;
    }

    if (pending?.transactionEvent) {
      // #529: the first CALLRESULT for any transmission settles the
      // message. Its other transmissions are forgotten, so a second answer
      // finds no pending entry and is ignored like any unknown CALLRESULT.
      // One written only after that (it sat in the socket's queue) finds
      // the message done, and its answer is ignored too.
      const { message } = pending.transactionEvent;
      this._transactionEvents.endTransmission(
        messageId,
        pending.transactionEvent,
        pending.timeout,
      );
      if (message.done) return;
      this._transactionEvents.forgetTransactionEvent(message);
      this._transactionMessages.applyTransactionEventResult(
        message.payload,
        payload as TransactionEventResponseV201,
      );
      return;
    }

    if (pending?.action === "TransactionEvent") {
      this._transactionMessages.applyTransactionEventResult(
        pending.payload as TransactionEventRequestV201,
        payload as TransactionEventResponseV201,
      );
      return;
    }

    const bootResult = payload as BootNotificationResponseV201;
    if (
      bootResult.status !== undefined &&
      bootResult.currentTime !== undefined &&
      bootResult.interval !== undefined
    ) {
      this._logger.info(
        `[v2.0.1] BootNotification response: ${bootResult.status}`,
        LogType.OCPP,
      );
      this._chargePoint.onBootNotificationResult({
        status: bootResult.status,
        interval: bootResult.interval,
        currentTime: bootResult.currentTime,
      });
    }
  }
}
