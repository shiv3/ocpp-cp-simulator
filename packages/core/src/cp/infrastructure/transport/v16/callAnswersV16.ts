// CALLRESULT / CALLERROR handling of OCPPMessageHandler (#877): answers to the
// station's own CALLs.
import type {
  AuthorizeRequestV16,
  DataTransferResponseV16,
  MeterValuesRequestV16,
  StartTransactionRequestV16,
  StartTransactionResponseV16,
  StopTransactionRequestV16,
} from "@ocpp-cp-simulator/ocpp/index";
import type { OcppMessageErrorPayload } from "../OCPPWebSocket";
import type { CallWaiters } from "../CallWaiters";
import type { ExpertCalls } from "../ExpertCalls";
import {
  type MessageHandlerRegistry,
  type HandlerContext,
  StartTransactionResultHandler,
  StopTransactionResultHandler,
  MeterValuesResultHandler,
  AuthorizeResultHandler,
} from "../handlers";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { isRunningTransactionStartedBy } from "../../../domain/connector/Transaction";
import type { DataTransferResult } from "../../../domain/types/DataTransfer";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import { OCPPAction } from "../../../domain/types/OcppTypes";
import { requestConnectorId, type RequestHistory } from "./outboundRequestsV16";
import type { SerialCallQueueV16 } from "./serialCallQueueV16";
import type { OcppMessagePayloadCallResult } from "./payloadTypesV16";

/** What the answer handling needs from the 1.6 handler. */
export interface CallAnswersV16Context {
  readonly chargePoint: ChargePoint;
  readonly logger: Logger;
  readonly registry: () => MessageHandlerRegistry;
  readonly requests: RequestHistory;
  readonly expertCalls: ExpertCalls;
  readonly dataTransferWaiters: CallWaiters<DataTransferResult>;
  readonly delivery: SerialCallQueueV16;
}

export class CallAnswersV16 {
  private readonly _chargePoint: ChargePoint;
  private readonly _logger: Logger;
  private readonly _registryOf: () => MessageHandlerRegistry;
  private readonly _requests: RequestHistory;
  private readonly _expertCalls: ExpertCalls;
  private readonly _dataTransferWaiters: CallWaiters<DataTransferResult>;
  private readonly _delivery: SerialCallQueueV16;

  constructor(context: CallAnswersV16Context) {
    this._chargePoint = context.chargePoint;
    this._logger = context.logger;
    this._registryOf = context.registry;
    this._requests = context.requests;
    this._expertCalls = context.expertCalls;
    this._dataTransferWaiters = context.dataTransferWaiters;
    this._delivery = context.delivery;
  }

  private get _registry(): MessageHandlerRegistry {
    return this._registryOf();
  }

  public handleCallResult(
    messageId: string,
    payload: OcppMessagePayloadCallResult,
  ): void {
    if (this._expertCalls.claimResult(messageId, payload)) {
      this._delivery.forgetAnsweredCall(messageId);
      return;
    }
    const request = this._requests.get(messageId);
    if (!request) {
      this._logger.warn(
        `Received unexpected CallResult: ${messageId}`,
        LogType.OCPP,
      );
      return;
    }

    const action = request.action;
    // #565: before the handler, which can stop the transaction (a Stop built
    // from here on takes this id when it is sent).
    if (
      action === OCPPAction.StartTransaction &&
      request.attempt !== undefined
    ) {
      const id = (payload as StartTransactionResponseV16).transactionId;
      const start = request.payload as StartTransactionRequestV16;
      const connectorId = requestConnectorId(request);
      // A conf for a transaction that no longer runs and that no queued
      // message waits on (its Stop already went out with `-1`) has nothing
      // left to rewrite: nothing is recorded, so no entry outlives it.
      if (
        typeof id === "number" &&
        (isRunningTransactionStartedBy(
          this._chargePoint.getConnector(connectorId)?.transaction,
          start,
        ) ||
          this._delivery.hasMessageWaitingOn({
            connectorId,
            idTag: start.idTag,
            startedAt: start.timestamp,
          }))
      ) {
        this._delivery.recordStartOutcome(start, connectorId, id);
      }
    }
    let handler = this._registry.getCallResultHandler(action);

    // For transaction-related handlers that need connector info, create them dynamically
    if (!handler) {
      if (action === OCPPAction.StartTransaction) {
        const start = request.payload as StartTransactionRequestV16;
        handler = new StartTransactionResultHandler(
          requestConnectorId(request),
          start.idTag,
          // #527: the station's own StartTransaction.req (it carries an
          // attempt) answers for its transaction only. An expert call with
          // applyResponse (#389) applies to the connector as before.
          request.attempt !== undefined ? start.timestamp : undefined,
        );
      } else if (action === OCPPAction.StopTransaction) {
        handler = new StopTransactionResultHandler(
          requestConnectorId(request),
          (request.payload as StopTransactionRequestV16).idTag,
        );
      } else if (action === OCPPAction.MeterValues) {
        handler = new MeterValuesResultHandler(
          (request.payload as MeterValuesRequestV16).connectorId,
        );
      } else if (action === OCPPAction.Authorize) {
        handler = new AuthorizeResultHandler(
          request.payload as AuthorizeRequestV16,
        );
      }
    }

    if (handler) {
      try {
        const context: HandlerContext = {
          chargePoint: this._chargePoint,
          logger: this._logger,
        };
        handler.handle(payload, context);
      } catch (error) {
        this._logger.error(
          `Error handling ${action} result: ${error}`,
          LogType.OCPP,
        );
      }
    } else {
      this._logger.warn(
        `No handler for action result: ${action}`,
        LogType.OCPP,
      );
    }

    if (action === OCPPAction.DataTransfer) {
      const answer = payload as DataTransferResponseV16;
      this._dataTransferWaiters.resolve(messageId, {
        status: answer.status,
        ...(answer.data !== undefined ? { data: answer.data } : {}),
      });
    }

    // #565: a resend answered; what waited behind it goes on. Not for one
    // that already timed out (#839): its timeout released its hold, and the
    // hold now standing belongs to a newer resend, which must keep it
    // (§3.7: the messages stay in chronological order).
    if (
      request.attempt !== undefined &&
      request.attempt > 1 &&
      !request.timedOut
    ) {
      this._delivery.releaseHold();
    }
    this._requests.remove(messageId);
    // §4.1.1: response received — release the serialization slot so the
    // next queued CALL can go out.
    this._delivery.settleSerialInFlight(messageId);
  }

  public handleCallError(
    messageId: string,
    error: OcppMessageErrorPayload,
  ): void {
    const request = this._requests.get(messageId);
    this._logger.error(
      `Received CALLERROR for message ${messageId} (action=${request?.action ?? "unknown"}): ${JSON.stringify(error)}`,
      LogType.OCPP,
    );
    if (this._expertCalls.claimError(messageId, error)) {
      this._delivery.forgetAnsweredCall(messageId);
      return;
    }

    if (request?.attempt !== undefined && !request.timedOut) {
      this._delivery.onTransactionMessageCallError(request, error.errorCode);
    }

    // Issue #181: a CALLERROR answering Authorize.req is a definite
    // protocol failure, unlike the authorizeAndWait paths where the CSMS
    // said nothing at all (#452: a disconnect applies the offline rules;
    // a timeout refuses a tag known locally as NOT valid and otherwise
    // proceeds as "Accepted"). Here the CSMS *did* respond, and what it
    // said was "I couldn't process this" — so treat it as fail-CLOSED:
    // synthesize a denial ("Invalid") rather than let authorizeAndWait
    // burn its full timeout waiting for a CALLRESULT that will never
    // arrive.
    if (request?.action === OCPPAction.Authorize) {
      const idTag = (request.payload as AuthorizeRequestV16).idTag;
      this._chargePoint.notifyAuthorizeResult(idTag, "Invalid");
    }

    this._dataTransferWaiters.reject(
      messageId,
      new Error(
        `DataTransfer ${messageId} answered with CALLERROR ${error.errorCode}: ${error.errorDescription}`,
      ),
    );

    this._requests.remove(messageId);
    // §4.1.1: CALLERROR also settles the in-flight CALL.
    this._delivery.settleSerialInFlight(messageId);
  }
}
