import {
  DATA_TRANSFER_RESPONSE_TIMEOUT_MS,
  type DataTransferData,
  type DataTransferResult,
} from "../../domain/types/DataTransfer";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "../../domain/types/FirmwareLogStatus";
import {
  csmsActionAliases,
  V201_ACTIONS_WITHOUT_STATUS_RESPONSE,
} from "../../domain/types/csmsActionNames";
import type {
  BootNotificationRequestV201,
  HeartbeatRequestV201,
  HeartbeatResponseV201,
  BootNotificationResponseV201,
  DataTransferRequestV201,
  DataTransferResponseV201,
  FirmwareStatusNotificationRequestV201,
  LogStatusNotificationRequestV201,
  StatusNotificationRequestV201,
  StatusNotificationResponseV201,
  TransactionEventRequestV201,
  TransactionEventResponseV201,
  MeterValuesRequestV201,
  MeterValuesResponseV201,
  AuthorizeRequestV201,
  AuthorizeResponseV201,
} from "../../../ocpp";
import type { OCPPWebSocket } from "./OCPPWebSocket";
import type { ProtocolCodec } from "./profile/ProtocolProfile";
import { CallWaiters } from "./CallWaiters";
import { ExpertCalls, type CallErrorFields } from "./ExpertCalls";
import {
  type OcppCallOutcome,
  type OcppCallRequest,
} from "../../domain/types/OcppCall";
import { OcppCallRejectedError } from "../../domain/errors/OcppCallErrors";
import { Logger, LogType } from "../../shared/Logger";
import {
  BootNotification,
  ChargePointErrorCode,
  type OCPPErrorCode,
  OCPPMessageType,
  OCPPStatus,
} from "../../domain/types/OcppTypes";
import {
  endedStoppedReason,
  endedTriggerReason,
  type Transaction,
  type TransactionChargingState,
  type TransactionUpdateOptions,
} from "../../domain/connector/Transaction";
import {
  buildSampledValues,
  type MeterSampleOverrides,
  type ReadingContext,
  type SampledValue,
} from "../../domain/connector/MeterValueBuilder";
import {
  signReading,
  toOcpp2SignedMeterValue,
  type OcmfReading,
} from "../../domain/connector/SignedMeterData";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import { MAX_TIMER_MS, unrefTimer } from "../../shared/timers";
import type { TransactionLifecycleEvent } from "../../domain/transport/TransactionLifecycleEvent";
import type { IChargePointMessageHandler } from "./IChargePointMessageHandler";
import { DataTransferHandler } from "./handlers";
import {
  v201MeterEvseId,
  v201StatusEvse,
  v201TransactionEvse,
} from "./v201/topologyWireV201";
import {
  buildV201InboundRegistry,
  type V201Action,
  type V201InboundContext,
  type V201InboundRegistry,
  type V201RequestPayload,
} from "./v201/inboundRegistryV201";
import {
  ResponseEffectQueue,
  type GenerationToken,
  type Settlement,
} from "./network-sim";

type V201ResponsePayload =
  | BootNotificationResponseV201
  | HeartbeatResponseV201
  | StatusNotificationResponseV201
  | TransactionEventResponseV201
  | MeterValuesResponseV201
  | AuthorizeResponseV201;

type V201MeterValuesSampledValue =
  MeterValuesRequestV201["meterValue"][number]["sampledValue"][number];

function ocppStatusToV201(
  status: OCPPStatus,
): StatusNotificationRequestV201["connectorStatus"] {
  switch (status) {
    case OCPPStatus.Available:
      return "Available";
    case OCPPStatus.Reserved:
      return "Reserved";
    case OCPPStatus.Unavailable:
      return "Unavailable";
    case OCPPStatus.Faulted:
      return "Faulted";
    default:
      return "Occupied";
  }
}

function ocppStatusToTransactionChargingState(
  status: OCPPStatus,
): TransactionChargingState | null {
  switch (status) {
    case OCPPStatus.Charging:
      return "Charging";
    case OCPPStatus.SuspendedEV:
      return "SuspendedEV";
    case OCPPStatus.SuspendedEVSE:
      return "SuspendedEVSE";
    default:
      return null;
  }
}

/** Where a TransactionEvent CALL stands in its E13 delivery (#490). */
interface TransactionEventDelivery {
  readonly connectorId: number;
  /** 1-based transmission number of this CALL. */
  readonly attempt: number;
}

export class OCPPMessageHandlerV201 implements IChargePointMessageHandler {
  private readonly _chargePoint: ChargePoint;
  private readonly _webSocket: OCPPWebSocket;
  private readonly _logger: Logger;
  private readonly _codec?: ProtocolCodec;
  private readonly _dataTransferHandler: DataTransferHandler =
    new DataTransferHandler();
  private readonly _inbound: V201InboundRegistry;
  /** Tracks in-flight CP→CSMS CALLs by messageId so `handleCallResult` can
   *  correlate a CALLRESULT back to the request that provoked it (issue
   *  #181) — e.g. Authorize.conf carries no idToken of its own, so the
   *  idToken has to come from the original Authorize.req. Entries are
   *  removed once the matching CALLRESULT/CALLERROR arrives. */
  private readonly _pendingRequests = new Map<
    string,
    {
      action: V201Action;
      payload: V201RequestPayload;
      /** Set on the TransactionEvents this handler builds (#490). */
      transactionEvent?: TransactionEventDelivery;
    }
  >();
  /** Resends waiting out `MessageAttemptInterval[TransactionEvent]`
   *  (#490), with what each one would send; cleared on WebSocket close. */
  private readonly _transactionEventRetries = new Map<
    ReturnType<typeof setTimeout>,
    { payload: TransactionEventRequestV201; attempt: number }
  >();
  /** Control-plane `data_transfer` callers waiting for the CSMS's answer
   *  (#348), keyed by CALL id — see the 1.6 handler's twin. */
  private readonly _dataTransferWaiters = new CallWaiters<DataTransferResult>(
    DATA_TRANSFER_RESPONSE_TIMEOUT_MS,
    (id) =>
      new Error(
        `DataTransfer ${id}: no answer within ${DATA_TRANSFER_RESPONSE_TIMEOUT_MS}ms`,
      ),
  );
  /** Expert calls (#389) in flight; their answers are routed here first. */
  // 2.x writes a CALL at once or drops it: nothing is ever left to withdraw.
  private readonly _expertCalls = new ExpertCalls(() => false);
  // Response effect queue for deferred handler side effects
  private readonly _responseEffectQueue: ResponseEffectQueue;
  private _bootStatus:
    | { status: "Idle" }
    | { status: "Accepted" }
    | { status: "Pending" }
    | { status: "Rejected"; retryAfter: Date } = { status: "Idle" };

  constructor(
    chargePoint: ChargePoint,
    webSocket: OCPPWebSocket,
    logger: Logger,
    inboundRegistry?: V201InboundRegistry,
    codec?: ProtocolCodec,
  ) {
    this._chargePoint = chargePoint;
    this._webSocket = webSocket;
    this._logger = logger;
    this._codec = codec;
    this._inbound = inboundRegistry ?? buildV201InboundRegistry();

    // Initialize response effect queue with deps
    this._responseEffectQueue = new ResponseEffectQueue({
      isGenerationCurrent: (gen) =>
        gen.gen === this._webSocket.currentGeneration().gen,
      defer: (run) => queueMicrotask(run),
      log: (message) => this._logger.info(message, LogType.OCPP),
    });

    // Register close-transaction callback for effect flushing
    // Note: OCPPWebSocket.onCloseTransaction stores a SINGLE callback;
    // since one protocol per connection, this is fine.
    this._webSocket.onCloseTransaction((finalized) =>
      this._responseEffectQueue.flushAfterCloseFinalization(finalized),
    );

    this._webSocket.setMessageHandler(this.handleIncomingMessage.bind(this));
  }

  private generateMessageId(): string {
    return crypto.randomUUID();
  }

  /** Answer an inbound CSMS CALL with a CALLRESULT, announcing it first
   *  (#396). */
  private answerCall(
    action: string,
    messageId: string,
    response: unknown,
    gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    this._chargePoint.notifyIncomingCallCompleted({
      action,
      messageId,
      outcome: "CallResult",
    });
    this._webSocket.sendResult(messageId, response, gen, onSettled);
  }

  /** Leave an inbound CSMS CALL unanswered, announcing it (#396). */
  private ignoreCall(action: string, messageId: string): void {
    this._chargePoint.notifyIncomingCallCompleted({
      action,
      messageId,
      outcome: "NoResponse",
    });
  }

  /** Answer an inbound CSMS CALL with a CALLERROR, announcing it first
   *  (#396). */
  private rejectCall(
    action: string,
    messageId: string,
    errorCode: OCPPErrorCode,
    errorDescription: string,
    gen: GenerationToken,
  ): void {
    this._chargePoint.notifyIncomingCallCompleted({
      action,
      messageId,
      outcome: "CallError",
      errorCode,
    });
    this._webSocket.sendError(
      messageId,
      { errorCode, errorDescription, errorDetails: {} },
      gen,
    );
  }

  private send(
    action: V201Action,
    messageId: string,
    payload: V201RequestPayload,
    /** Told when the CALL never reached the wire (#348 waiters). */
    onDropped?: (reason: string) => void,
    transactionEvent?: TransactionEventDelivery,
  ): void {
    if (!this._webSocket.isConnected()) {
      this._logger.warn(
        `[v2.0.1] Not connected, dropping ${action}`,
        LogType.WEBSOCKET,
      );
      onDropped?.("not_connected");
      return;
    }
    const warning = this._codec?.outgoingWarning(action, payload);
    if (warning) {
      this._logger.warn(warning, LogType.OCPP);
    }
    const gen = this._webSocket.currentGeneration();
    const accepted = this._webSocket.sendAction(
      messageId,
      action,
      payload,
      gen,
      (settlement) => {
        if (settlement.outcome === "written") {
          this._pendingRequests.set(messageId, {
            action,
            payload,
            ...(transactionEvent ? { transactionEvent } : {}),
          });
          this._chargePoint.notifyOutgoingCall(action === "Heartbeat");
        } else {
          // On drop outcomes (socket_closed, disposed, write_failed,
          // queue_overflow): no retry — a 2.x drop is unrecovered wire loss
          // per spec. A caller waiting for an answer is told.
          onDropped?.(settlement.outcome);
        }
      },
    );
    if (!accepted) {
      onDropped?.("not_accepted");
      // send-false: the CALL was never accepted; preserve current behavior
      // (likely just a warn/log already in place from isConnected check above)
      this._logger.debug(
        `[v2.0.1] sendAction returned false for ${action}`,
        LogType.WEBSOCKET,
      );
    }
  }

  private handleIncomingMessage(
    messageType: OCPPMessageType,
    messageId: string,
    action: string,
    payload: unknown,
  ): void {
    if (messageType === OCPPMessageType.CALL) {
      // #349: the three scenario mechanisms the 1.6 handler consults at this
      // point — the csmsCallTrigger event, inbound policies and one-shot
      // response overrides — were never consulted here, so no negative or
      // wait-for-call scenario was expressible on 2.0.1. Scenarios spell
      // actions in either version's vocabulary; a 2.0.1 CALL is looked up
      // under its own name and its 1.6 alias (RequestStartTransaction ←
      // RemoteStartTransaction, …).
      // #396: the control plane announces the CALL under its wire name;
      // every answer below reports itself through answerCall / rejectCall.
      this._chargePoint.notifyIncomingCall(action, payload, messageId);
      const aliases = csmsActionAliases(action);
      const policyName = aliases.find(
        (name) => this._chargePoint.getInboundCallPolicy(name) !== undefined,
      );
      const inboundPolicy =
        policyName === undefined
          ? undefined
          : this._chargePoint.getInboundCallPolicy(policyName);
      if (inboundPolicy) {
        const gen = this._webSocket.currentGeneration();
        if (inboundPolicy.kind === "callerror") {
          this._logger.warn(
            `[v2.0.1] Inbound policy: replied CallError(${inboundPolicy.errorCode}) to ${action}`,
            LogType.OCPP,
          );
          this.rejectCall(
            action,
            messageId,
            inboundPolicy.errorCode as OCPPErrorCode,
            inboundPolicy.errorDescription,
            gen,
          );
          return;
        }
        this._logger.warn(
          `[v2.0.1] Inbound policy: ignored ${action} (no response)`,
          LogType.OCPP,
        );
        this.ignoreCall(action, messageId);
        return;
      }
      const armedUnder = aliases.find((name) =>
        this._chargePoint.hasResponseOverride(name),
      );
      if (armedUnder !== undefined) {
        // One CALL consumes the one-shot under every spelling it was armed
        // with, so a copy left under the other name cannot fire on a later,
        // unrelated call.
        const overrideStatus =
          this._chargePoint.consumeResponseOverride(armedUnder);
        for (const name of aliases)
          this._chargePoint.clearResponseOverride(name);
        if (V201_ACTIONS_WITHOUT_STATUS_RESPONSE.has(action)) {
          // SetVariablesResponse / GetVariablesResponse are not `{ status }`;
          // a canned status would be a schema-invalid answer. Documented
          // caveat, enforced here: the real handler answers instead.
          this._logger.warn(
            `[v2.0.1] Response override armed as ${armedUnder} cannot be honoured for ${action} (its response is not { status }); answering normally`,
            LogType.OCPP,
          );
        } else if (overrideStatus !== null) {
          this._logger.info(
            `[v2.0.1] Response override: ${action} → { status: "${overrideStatus}" }`,
            LogType.OCPP,
          );
          // Same one call site as the 1.6 handler: the caller chose the
          // status, and every other action the responseOverride node lists
          // answers `{ status }` on 2.0.1 too.
          this.answerCall(
            action,
            messageId,
            { status: overrideStatus },
            this._webSocket.currentGeneration(),
          );
          return;
        }
      }

      const entry = this._inbound.get(action);
      if (entry) {
        if (!entry.validate(payload)) {
          const gen = this._webSocket.currentGeneration();
          this.rejectCall(
            action,
            messageId,
            "FormationViolation" as OCPPErrorCode,
            `Invalid ${action} payload`,
            gen,
          );
          return;
        }

        // Capture generation before handler execution
        const gen = this._webSocket.currentGeneration();
        const ctx: V201InboundContext = {
          chargePoint: this._chargePoint,
          logger: this._logger,
          sendCall: (a, p) => this.send(a, this.generateMessageId(), p),
        };
        let handled: ReturnType<typeof entry.handle>;
        try {
          handled = entry.handle(payload, ctx);
        } catch (error) {
          // Same answer as the 1.6J handler: a failing handler is the
          // station's fault, so the CSMS gets InternalError instead of
          // waiting for its timeout (#399).
          this._logger.error(
            `[v2.0.1] Error handling ${action}: ${error}`,
            LogType.OCPP,
          );
          this.rejectCall(
            action,
            messageId,
            "InternalError" as OCPPErrorCode,
            // OCPP-J 2.0.1 / 2.1 Part 4 §4.2.3: ErrorDescription is
            // string[255].
            (error instanceof Error ? error.message : String(error)).slice(
              0,
              255,
            ),
            gen,
          );
          return;
        }
        const { response, afterResult } = handled;
        // Register effect with queue if present, get settlement callback
        const onSettled = afterResult
          ? this._responseEffectQueue.register(gen, afterResult)
          : undefined;
        this.answerCall(action, messageId, response, gen, onSettled);
        return;
      }

      const gen = this._webSocket.currentGeneration();
      this._logger.warn(
        `[v2.0.1] Unsupported CSMS action ${action}`,
        LogType.OCPP,
      );
      this.rejectCall(
        action,
        messageId,
        "NotImplemented" as OCPPErrorCode,
        "This action is not supported",
        gen,
      );
    } else if (messageType === OCPPMessageType.CALLRESULT) {
      this.handleCallResult(messageId, payload as V201ResponsePayload);
    } else if (messageType === OCPPMessageType.CALLERROR) {
      const pending = this._pendingRequests.get(messageId);
      this._pendingRequests.delete(messageId);
      this._logger.warn(`[v2.0.1] CALLERROR for ${messageId}`, LogType.OCPP);
      const error = payload as CallErrorFields;
      if (this._expertCalls.claimError(messageId, error)) return;
      if (pending?.transactionEvent) {
        this.onTransactionEventCallError(
          pending.payload as TransactionEventRequestV201,
          pending.transactionEvent,
          error.errorCode ?? "GenericError",
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
      // protocol failure (unlike the authorizeAndWait timeout/disconnect
      // paths, which proceed fail-OPEN as "Accepted" because the CSMS
      // said nothing at all). Here the CSMS *did* respond, and what it
      // said was "I couldn't process this" — so treat it as fail-CLOSED:
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
  }

  private handleCallResult(
    messageId: string,
    payload: V201ResponsePayload,
  ): void {
    const pending = this._pendingRequests.get(messageId);
    this._pendingRequests.delete(messageId);

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

    if (pending?.action === "TransactionEvent") {
      this.applyTransactionEventResult(
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

  /**
   * #447: the 2.x twin of 1.6's non-Accepted StartTransaction.conf (#181).
   * TransactionEvent.conf carries the CSMS's verdict on the event's idToken
   * in `idTokenInfo`. When it is not Accepted and the transaction is still
   * running, `TxCtrlr/StopTxOnInvalidId` (default true) ends it as
   * Deauthorized / DeAuthorized; false leaves it running. Either way the
   * rejection is reported like the 1.6 one.
   */
  private applyTransactionEventResult(
    request: TransactionEventRequestV201,
    response: TransactionEventResponseV201,
  ): void {
    const status = response.idTokenInfo?.status;
    if (status === undefined || status === "Accepted") return;
    if (request.eventType === "Ended") return;
    const transactionId = request.transactionInfo.transactionId;
    const connector = [...this._chargePoint.connectors.values()].find(
      (c) =>
        c.transaction?.cpTransactionId === transactionId &&
        c.transaction.stopTime === null,
    );
    if (!connector) return;
    const stopOnInvalid =
      this._chargePoint.configuration.stopTransactionOnInvalidId();
    this._logger.warn(
      `[v2.0.1] TransactionEvent idTokenInfo ${status} for transaction ${transactionId}; StopTxOnInvalidId=${stopOnInvalid}`,
      LogType.TRANSACTION,
    );
    connector.transaction!.authorizationStatus = status;
    connector.transaction!.authorizationRejectedMidSession =
      request.eventType !== "Started";
    if (stopOnInvalid) {
      this._chargePoint.stopTransaction(connector, "DeAuthorized", {
        triggerReason: "Deauthorized",
        stoppedReason: "DeAuthorized",
      });
    }
    this._chargePoint.notifyStartTransactionNotAccepted(
      connector.id,
      status,
      stopOnInvalid,
    );
  }

  /** Send a TransactionEvent as transmission `attempt` (#490). Each
   *  transmission is a new CALL with a new message id (OCPP-J Part 4 §4.1.4:
   *  "This also applies to retries"); the payload, seqNo included, is the
   *  same object every time. */
  private sendTransactionEventCall(
    connectorId: number,
    payload: TransactionEventRequestV201,
    attempt = 1,
  ): void {
    this.send(
      "TransactionEvent",
      this.generateMessageId(),
      payload,
      attempt > 1
        ? (reason) =>
            this.warnResendLost(payload, attempt, `dropped: ${reason}`)
        : undefined,
      { connectorId, attempt },
    );
  }

  /**
   * #490, OCPP 2.0.1 / 2.1 E13.FR.02-04: a CALLERROR answering a
   * TransactionEvent means the CSMS failed to process it. The station
   * resends it after `OCPPCommCtrlr.MessageAttemptInterval[TransactionEvent]`
   * seconds times the number of transmissions so far, up to
   * `MessageAttempts[TransactionEvent]` transmissions, then discards it.
   * The transaction keeps running either way (unlike 1.6, #447).
   *
   * Known limitation: 2.x has no serial queue here (see `send`), so a
   * waiting resend does not hold back the next transaction message. E13
   * (Figure 62) describes sequential delivery; this station may deliver
   * `Ended` before the resent `Started`, leaving the CSMS to reorder by
   * `seqNo`. Both settings are read here, so a SetVariables applies to the
   * next failure.
   */
  private onTransactionEventCallError(
    payload: TransactionEventRequestV201,
    delivery: TransactionEventDelivery,
    errorCode: string,
  ): void {
    const { connectorId, attempt } = delivery;
    const report = {
      connectorId,
      transactionId: payload.transactionInfo.transactionId,
      eventType: payload.eventType,
      errorCode,
    };
    const config = this._chargePoint.configuration;
    const attempts = Math.max(1, config.transactionMessageAttempts());
    this._chargePoint.notifyTransactionMessageRejected({ ...report, attempt });
    if (attempt >= attempts) {
      this._logger.warn(
        `[v2.0.1] TransactionEvent ${payload.eventType} (seqNo ${payload.seqNo}) of transaction ${report.transactionId} discarded after ${attempt} attempt(s): ${errorCode}`,
        LogType.TRANSACTION,
      );
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
      `[v2.0.1] TransactionEvent ${payload.eventType} (seqNo ${payload.seqNo}) of transaction ${report.transactionId} answered with CALLERROR ${errorCode}; attempt ${attempt + 1}/${attempts} in ${delayMs / 1000}s`,
      LogType.TRANSACTION,
    );
    const timer = setTimeout(() => {
      this._transactionEventRetries.delete(timer);
      this.sendTransactionEventCall(connectorId, payload, attempt + 1);
    }, delayMs);
    unrefTimer(timer);
    this._transactionEventRetries.set(timer, {
      payload,
      attempt: attempt + 1,
    });
  }

  /** A resend that will never reach the CSMS: logged, no domain event. */
  private warnResendLost(
    payload: TransactionEventRequestV201,
    attempt: number,
    outcome: string,
  ): void {
    this._logger.warn(
      `[v2.0.1] TransactionEvent ${payload.eventType} (seqNo ${payload.seqNo}) of transaction ${payload.transactionInfo.transactionId}: attempt ${attempt} ${outcome}`,
      LogType.TRANSACTION,
    );
  }

  public sendBootNotification(bootPayload: BootNotification): void {
    const messageId = this.generateMessageId();
    const payload: BootNotificationRequestV201 = {
      reason: "PowerUp",
      chargingStation: {
        model: bootPayload.chargePointModel,
        vendorName: bootPayload.chargePointVendor,
        serialNumber: bootPayload.chargePointSerialNumber,
        firmwareVersion: bootPayload.firmwareVersion,
        modem:
          bootPayload.iccid || bootPayload.imsi
            ? { iccid: bootPayload.iccid, imsi: bootPayload.imsi }
            : undefined,
      },
    };
    this.send("BootNotification", messageId, payload);
  }

  public sendHeartbeat(): void {
    const messageId = this.generateMessageId();
    const payload: HeartbeatRequestV201 = {};
    this.send("Heartbeat", messageId, payload);
  }

  public sendStatusNotification(
    connectorId: number,
    status: OCPPStatus,
    opts?: {
      errorCode?: ChargePointErrorCode;
      info?: string;
      vendorErrorCode?: string;
      vendorId?: string;
      timestamp?: Date;
      suppressChargingStateTransactionEvent?: boolean;
    },
  ): void {
    const messageId = this.generateMessageId();
    const ev = v201StatusEvse(connectorId);
    const payload: StatusNotificationRequestV201 = {
      timestamp: (opts?.timestamp ?? new Date()).toISOString(),
      connectorStatus: ocppStatusToV201(status),
      evseId: ev.evseId,
      connectorId: ev.connectorId,
    };
    this.send("StatusNotification", messageId, payload);
    const chargingState = ocppStatusToTransactionChargingState(status);
    if (chargingState && !opts?.suppressChargingStateTransactionEvent) {
      this.sendChargingStateChanged(connectorId, chargingState);
    }
  }

  public authorize(tagId: string): void {
    const messageId = this.generateMessageId();
    const payload: AuthorizeRequestV201 = {
      idToken: { idToken: tagId, type: "ISO14443" },
    };
    this.send("Authorize", messageId, payload);
  }

  private sendStartTransaction(
    transaction: Transaction,
    connectorId: number,
  ): void {
    if (!transaction.cpTransactionId) {
      transaction.cpTransactionId = crypto.randomUUID();
    }
    const transactionId = transaction.cpTransactionId;
    const seqNo = transaction.cpNextSeqNo ?? 0;
    transaction.cpNextSeqNo = seqNo + 1;
    // #335: a driven start may name the state the transaction opens in
    // (e.g. `EVConnected` for a cable-first session); `Charging` is the
    // historical default and stays so for every existing caller.
    const chargingState = transaction.startChargingState ?? "Charging";
    transaction.cpLastTransactionEventChargingState = chargingState;
    const payload: TransactionEventRequestV201 = {
      eventType: "Started",
      timestamp: transaction.startTime.toISOString(),
      triggerReason: transaction.startTriggerReason ?? "Authorized",
      seqNo,
      transactionInfo: {
        transactionId,
        chargingState,
        ...(transaction.remoteStartId !== undefined
          ? { remoteStartId: transaction.remoteStartId }
          : {}),
      },
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
      idToken: { idToken: transaction.tagId, type: "ISO14443" },
      evse: v201TransactionEvse(connectorId),
      meterValue: [
        {
          timestamp: transaction.startTime.toISOString(),
          sampledValue: this.withSignedEnergy(
            [
              {
                value: transaction.meterStart / 1000,
                measurand: "Energy.Active.Import.Register",
                unitOfMeasure: { unit: "kWh" },
              },
            ],
            connectorId,
            transaction.tagId,
            {
              reason: "B",
              energyWh: transaction.meterStart,
              at: transaction.startTime,
            },
            "Transaction.Begin",
          ),
        },
      ],
    };
    this.sendTransactionEventCall(connectorId, payload);
  }

  private sendChargingStateChanged(
    connectorId: number,
    chargingState: TransactionChargingState,
  ): void {
    const connector = this._chargePoint.getConnector(connectorId);
    const transaction = connector?.transaction;
    if (!transaction || transaction.stopTime !== null) return;

    const lastChargingState =
      transaction.cpLastTransactionEventChargingState ?? "Charging";
    if (lastChargingState === chargingState) {
      transaction.cpLastTransactionEventChargingState = lastChargingState;
      return;
    }

    if (!transaction.cpTransactionId) {
      transaction.cpTransactionId = crypto.randomUUID();
    }
    const seqNo = transaction.cpNextSeqNo ?? 0;
    transaction.cpNextSeqNo = seqNo + 1;
    transaction.cpLastTransactionEventChargingState = chargingState;
    connector.markTransactionChanged();
    const payload: TransactionEventRequestV201 = {
      eventType: "Updated",
      timestamp: new Date().toISOString(),
      triggerReason: "ChargingStateChanged",
      seqNo,
      transactionInfo: {
        transactionId: transaction.cpTransactionId,
        chargingState,
      },
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
      evse: v201TransactionEvse(connectorId),
    };
    this.sendTransactionEventCall(connectorId, payload);
  }

  private sendStopTransaction(
    transaction: Transaction,
    connectorId: number,
  ): void {
    const transactionId = transaction.cpTransactionId ?? crypto.randomUUID();
    const timestamp = (transaction.stopTime ?? new Date()).toISOString();
    const seqNo = transaction.cpNextSeqNo ?? 0;
    transaction.cpNextSeqNo = seqNo + 1;
    const payload: TransactionEventRequestV201 = {
      eventType: "Ended",
      timestamp,
      triggerReason: endedTriggerReason(transaction),
      seqNo,
      transactionInfo: {
        transactionId,
        // #335: an explicitly named 2.0.1 reason is sent verbatim; only an
        // unnamed one is derived from the 1.6-shaped `stopReason`.
        stoppedReason: endedStoppedReason(transaction),
      },
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
      ...(transaction.tagId
        ? { idToken: { idToken: transaction.tagId, type: "ISO14443" as const } }
        : {}),
      evse: v201TransactionEvse(connectorId),
      meterValue:
        transaction.meterStop !== null
          ? [
              {
                timestamp,
                sampledValue: this.withSignedEnergy(
                  [
                    {
                      value: transaction.meterStop / 1000,
                      measurand: "Energy.Active.Import.Register",
                      unitOfMeasure: { unit: "kWh" },
                    },
                  ],
                  connectorId,
                  transaction.tagId,
                  {
                    reason: "E",
                    energyWh: transaction.meterStop,
                    at: transaction.stopTime ?? new Date(timestamp),
                  },
                  "Transaction.End",
                ),
              },
            ]
          : undefined,
    };
    this.sendTransactionEventCall(connectorId, payload);
  }

  public sendTransactionEvent(event: TransactionLifecycleEvent): void {
    if (event.phase === "started")
      this.sendStartTransaction(event.transaction, event.connectorId);
    else this.sendStopTransaction(event.transaction, event.connectorId);
  }

  /**
   * A driven TransactionEvent(Updated) (#335): the caller names the
   * `triggerReason` and optionally the `chargingState`; `meterValues: true`
   * attaches the connector's current sampled values, which is how 2.0.1
   * carries in-transaction metering (`MeterValuePeriodic` / `MeterValueClock`).
   * Shares the per-transaction seqNo with the status-driven events, and a
   * named `chargingState` becomes the value those events de-duplicate
   * against, so a later StatusNotification to the same state stays silent.
   */
  public sendTransactionUpdate(
    connectorId: number,
    options: TransactionUpdateOptions,
  ): void {
    const connector = this._chargePoint.getConnector(connectorId);
    const transaction = connector?.transaction;
    if (!connector || !transaction || transaction.stopTime !== null) {
      this._logger.warn(
        `[v2.0.1] transaction_event (${options.triggerReason}): no active transaction on connector ${connectorId}`,
        LogType.TRANSACTION,
      );
      return;
    }
    if (!transaction.cpTransactionId) {
      transaction.cpTransactionId = crypto.randomUUID();
    }
    const seqNo = transaction.cpNextSeqNo ?? 0;
    transaction.cpNextSeqNo = seqNo + 1;
    if (options.chargingState) {
      transaction.cpLastTransactionEventChargingState = options.chargingState;
    }
    connector.markTransactionChanged();
    const timestamp = (options.timestamp ?? new Date()).toISOString();

    let meterValue: TransactionEventRequestV201["meterValue"];
    if (options.meterValues) {
      const measurands =
        options.measurands ??
        this._chargePoint.configuration.meterValuesSampledData();
      const context = options.context ?? "Sample.Periodic";
      const sampledValue = this.withSignedEnergy(
        this.toV201SampledValues(
          buildSampledValues(connector, measurands, context),
        ),
        connectorId,
        transaction.tagId,
        {
          reason: "C",
          energyWh: connector.meterValue,
          at: new Date(timestamp),
        },
        context,
      );
      if (sampledValue.length > 0) {
        meterValue = [
          {
            timestamp,
            sampledValue: sampledValue as [
              V201MeterValuesSampledValue,
              ...V201MeterValuesSampledValue[],
            ],
          },
        ];
      } else {
        this._logger.debug(
          `[v2.0.1] transaction_event: no sampled values for connector ${connectorId}; sending without meterValue`,
          LogType.METER_VALUE,
        );
      }
    }

    const payload: TransactionEventRequestV201 = {
      eventType: "Updated",
      timestamp,
      triggerReason: options.triggerReason,
      seqNo,
      transactionInfo: {
        transactionId: transaction.cpTransactionId,
        ...(options.chargingState
          ? { chargingState: options.chargingState }
          : {}),
      },
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
      evse: v201TransactionEvse(connectorId),
      ...(meterValue ? { meterValue } : {}),
    };
    this.sendTransactionEventCall(connectorId, payload);
  }

  /**
   * #315: while `SampledDataSignReadings` is on, sign `reading` and attach it
   * as `signedMeterValue` to the energy register sample (adding one, with
   * `context`, if the measurand list has none). Unchanged when signing is off.
   */
  private withSignedEnergy(
    sampledValue: V201MeterValuesSampledValue[],
    connectorId: number,
    idTag: string,
    reading: OcmfReading,
    context?: ReadingContext,
  ): [V201MeterValuesSampledValue, ...V201MeterValuesSampledValue[]] {
    const list = sampledValue as [
      V201MeterValuesSampledValue,
      ...V201MeterValuesSampledValue[],
    ];
    // Clock-aligned samples are not signed (no aligned/fiscal records yet).
    if (context === "Sample.Clock") return list;
    const signed = signReading(this._chargePoint, connectorId, idTag, reading);
    if (!signed) return list;
    const withContext = context
      ? { context: context as V201MeterValuesSampledValue["context"] }
      : {};
    const signedMeterValue = toOcpp2SignedMeterValue(signed);
    const energy = list.findIndex(
      (sv) =>
        (sv.measurand ?? "Energy.Active.Import.Register") ===
          "Energy.Active.Import.Register" && !sv.phase,
    );
    if (energy >= 0) {
      return list.map((sv, i) =>
        i === energy ? { ...sv, ...withContext, signedMeterValue } : sv,
      ) as typeof list;
    }
    return [
      ...list,
      {
        value: reading.energyWh / 1000,
        measurand: "Energy.Active.Import.Register",
        unitOfMeasure: { unit: "kWh" },
        ...withContext,
        signedMeterValue,
      },
    ];
  }

  /** 1.6-shaped builder output → 2.0.1 SampledValueType. `context` is
   *  carried through since #335; it used to be computed and dropped. */
  private toV201SampledValues(
    sampledValues: SampledValue[],
  ): V201MeterValuesSampledValue[] {
    return sampledValues.map((sv) => ({
      value: Number(sv.value),
      measurand: sv.measurand as V201MeterValuesSampledValue["measurand"],
      unitOfMeasure: sv.unit ? { unit: sv.unit } : undefined,
      ...(sv.context
        ? { context: sv.context as V201MeterValuesSampledValue["context"] }
        : {}),
      // 2.0.1/2.1 SampledValueType carries `phase` (§2.36 / §2.44) — pass the
      // builder's L1/L2/L3 tag through rather than letting a CSMS receive
      // four indistinguishable samples per measurand (#301).
      ...(sv.phase
        ? { phase: sv.phase as V201MeterValuesSampledValue["phase"] }
        : {}),
    }));
  }

  public sendMeterValue(
    _transactionId: number | undefined,
    connectorId: number,
    context: ReadingContext = "Sample.Periodic",
    overrides: MeterSampleOverrides = {},
  ): void {
    const messageId = this.generateMessageId();
    const connector = this._chargePoint.getConnector(connectorId);
    if (!connector) {
      this._logger.warn(
        `[v2.0.1] sendMeterValue: connector ${connectorId} not found`,
        LogType.METER_VALUE,
      );
      return;
    }

    const measurands =
      overrides.measurands ??
      this._chargePoint.configuration.meterValuesSampledData();
    const sampledValues = buildSampledValues(connector, measurands, context);
    const timestamp = overrides.timestamp ?? new Date();
    let sampledValue = this.toV201SampledValues(sampledValues) as [
      V201MeterValuesSampledValue,
      ...V201MeterValuesSampledValue[],
    ];
    // #315: during a transaction, sign the energy register too. Done before
    // the empty check, so an empty measurand list still sends the signed one.
    const transaction = connector.transaction;
    if (transaction && !transaction.stopTime) {
      sampledValue = this.withSignedEnergy(
        sampledValue,
        connectorId,
        transaction.tagId,
        { reason: "C", energyWh: connector.meterValue, at: timestamp },
        context,
      );
    }
    if (sampledValue.length === 0) {
      this._logger.debug(
        `[v2.0.1] sendMeterValue: no sampled values for connector ${connectorId}`,
        LogType.METER_VALUE,
      );
      return;
    }

    const payload: MeterValuesRequestV201 = {
      evseId: v201MeterEvseId(connectorId),
      meterValue: [
        {
          timestamp: timestamp.toISOString(),
          sampledValue,
        },
      ],
    };
    this.send("MeterValues", messageId, payload);
  }

  public sendDataTransfer(
    vendorId: string,
    messageId?: string,
    data?: DataTransferData,
  ): Promise<DataTransferResult> {
    const id = this.generateMessageId();
    // 2.0.1: `data` is any JSON — passed through as the caller gave it. The
    // generated request type narrows the schema's `anyType` to an object,
    // hence the cast for a string `data`.
    const payload = {
      vendorId,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(data !== undefined ? { data } : {}),
    } as unknown as DataTransferRequestV201;
    const answer = this._dataTransferWaiters.register(id);
    this.send("DataTransfer", id, payload, (reason) =>
      this._dataTransferWaiters.reject(
        id,
        new Error(`DataTransfer ${id} dropped (${reason})`),
      ),
    );
    return answer;
  }

  /** Expert OCPP call (#389): any 2.0.1 / 2.1 station CALL (the catalog
   *  was checked by ChargePoint.sendOcppCall). Its answer goes to the
   *  caller, and through the normal response handling only when
   *  `applyResponse` is set. */
  public async sendOcppCall(
    request: OcppCallRequest,
  ): Promise<OcppCallOutcome> {
    const warning =
      this._codec?.outgoingWarning(request.action, request.payload) ?? null;
    if (warning && !request.skipValidation) {
      throw new OcppCallRejectedError("invalid_payload", warning);
    }
    const id = this.generateMessageId();
    const answer = this._expertCalls.start(id, request);
    // `send` logs the codec warning, if any, as for every CALL; with
    // skipValidation the payload is deliberately unchecked.
    this.send(
      request.action as V201Action,
      id,
      request.payload as unknown as V201RequestPayload,
      (reason) => this._expertCalls.onDropped(id, reason),
    );
    return answer;
  }

  public sendSecurityEventNotification(
    _type: string,
    _techInfo?: string,
  ): void {
    this._logger.warn(
      "[v2.0.1] SecurityEventNotification is not wired through this handler",
      LogType.OCPP,
    );
  }

  public async sendSignCertificate(_csr?: string): Promise<void> {
    this._logger.warn(
      "[v2.0.1] SignCertificate is not wired through this handler",
      LogType.OCPP,
    );
  }

  public sendDiagnosticsStatusNotification(_status: DiagnosticsStatus): void {
    this._logger.warn(
      "[v2.0.1] DiagnosticsStatusNotification not supported in OCPP 2.0.1",
      LogType.OCPP,
    );
  }

  /**
   * L01/L02 FirmwareStatusNotification.req (#345). Until this existed the
   * method was a warn-only stub whose message said 2.0.1 had no such
   * message; it does, and an accepted UpdateFirmware can now be followed
   * through. `requestId` names the UpdateFirmware the report belongs to —
   * the caller's, or the one this station last accepted.
   */
  public sendFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    const id = this.generateMessageId();
    const effectiveRequestId =
      requestId ?? this._chargePoint.lastFirmwareRequestId;
    const payload: FirmwareStatusNotificationRequestV201 = {
      status,
      ...(effectiveRequestId !== undefined
        ? { requestId: effectiveRequestId }
        : {}),
    };
    this.send("FirmwareStatusNotification", id, payload);
  }

  /** N01 LogStatusNotification.req (#345); `requestId` as above, from the
   *  GetLog this station last accepted when the caller gives none. */
  public sendLogStatusNotification(
    status: UploadLogStatus,
    requestId?: number,
  ): void {
    const id = this.generateMessageId();
    const effectiveRequestId = requestId ?? this._chargePoint.lastLogRequestId;
    const payload: LogStatusNotificationRequestV201 = {
      status,
      ...(effectiveRequestId !== undefined
        ? { requestId: effectiveRequestId }
        : {}),
    };
    this.send("LogStatusNotification", id, payload);
  }

  /**
   * 1.6 Security Whitepaper only. In 2.0.1 a signed update is the ordinary
   * UpdateFirmware (its `firmware.signature`) followed by the ordinary
   * FirmwareStatusNotification, whose status set is exactly the Whitepaper's
   * — so this is that message (#345).
   */
  public sendSignedFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    this._logger.debug(
      "[v2.0.1] SignedFirmwareStatusNotification is 1.6-Whitepaper-only; sending FirmwareStatusNotification, which carries the same statuses",
      LogType.OCPP,
    );
    this.sendFirmwareStatusNotification(status, requestId);
  }

  public setBootStatus(
    status:
      | { status: "Idle" }
      | { status: "Accepted" }
      | { status: "Pending" }
      | { status: "Rejected"; retryAfter: Date },
  ): void {
    if (
      this._bootStatus.status === status.status &&
      status.status !== "Rejected"
    ) {
      return;
    }
    this._bootStatus = status;
  }

  public getDataTransferHandler(): DataTransferHandler {
    return this._dataTransferHandler;
  }

  public onWebSocketClosed(): void {
    // Clear written-but-unanswered correlation entries on disconnect.
    // A disconnect must not leave stale correlation state.
    this._pendingRequests.clear();
    this._expertCalls.onClosed();
    // #490: a resend waiting for its interval dies with the connection (2.x
    // has no offline queue to hand it to). Close, disconnect, reset and
    // dispose all reach here through ChargePoint.teardownAfterClose.
    for (const [timer, resend] of this._transactionEventRetries) {
      clearTimeout(timer);
      this.warnResendLost(
        resend.payload,
        resend.attempt,
        "cancelled: WebSocket closed",
      );
    }
    this._transactionEventRetries.clear();
  }

  public flushPendingQueue(): void {
    // OCPP 2.0.1: pending queue handled by TransactionEvent seqNo mechanism
  }
}
