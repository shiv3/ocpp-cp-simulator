import {
  DATA_TRANSFER_RESPONSE_TIMEOUT_MS,
  type DataTransferData,
  type DataTransferResult,
} from "../../domain/types/DataTransfer";
import { inboundV2xViolation } from "./codec/validateV2x";
import { behaviorTapOf } from "./behaviorTap";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "../../domain/types/FirmwareLogStatus";
import { V201_ACTIONS_WITHOUT_STATUS_RESPONSE } from "../../domain/types/csmsActionNames";
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
  MeterValuesResponseV201,
  AuthorizeRequestV201,
  AuthorizeResponseV201,
  GetCertificateStatusRequestV201,
  GetCertificateStatusResponseV201,
  SignCertificateRequestV201,
  SignCertificateResponseV201,
} from "@ocpp-cp-simulator/ocpp/index";
import type { OCPPWebSocket } from "./OCPPWebSocket";
import type { ProtocolCodec } from "./profile/ProtocolProfile";
import { CallWaiters } from "./CallWaiters";
import { ExpertCalls, type CallErrorFields } from "./ExpertCalls";
import {
  type OcppCallOutcome,
  type OcppCallRequest,
} from "../../domain/types/OcppCall";
import {
  OcppCallNoAnswerError,
  OcppCallRejectedError,
} from "../../domain/errors/OcppCallErrors";
import type { Logger } from "../../shared/Logger";
import { LogType } from "../../shared/Logger";
import type {
  BootNotification,
  BootReason,
  ChargePointErrorCode,
} from "../../domain/types/OcppTypes";
import {
  type OCPPErrorCode,
  OCPPMessageType,
  OCPPStatus,
} from "../../domain/types/OcppTypes";
import {
  DEFAULT_ID_TOKEN_TYPE,
  type IdTokenTypeName,
  type TransactionChargingState,
  type TransactionUpdateOptions,
} from "../../domain/connector/Transaction";
import type {
  MeterSampleOverrides,
  ReadingContext,
} from "../../domain/connector/MeterValueBuilder";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import { toV2ConnectorStatus } from "../../domain/charge-point/runtimeValueKeys";
import { clockOf } from "../../shared/clock";
import type { SimClock, TimerHandle } from "../../shared/clock";
import { systemRngStreams } from "../../shared/rng";
import type { Rng } from "../../shared/rng";
import type { TransactionLifecycleEvent } from "../../domain/transport/TransactionLifecycleEvent";
import type { MonitoringEvent } from "../../domain/monitoring/MonitorEvaluation";
import type {
  AuthorizeSendHooks,
  IChargePointMessageHandler,
} from "../../domain/transport/IChargePointMessageHandler";
import { DataTransferHandler } from "./handlers";
import { v201StatusEvse } from "./v201/topologyWireV201";
import { recordIdTokenInfo } from "./v201/authorizationCacheV201";
import { TransactionMessagesV201 } from "./v201/transactionMessagesV201";
import { CertificateSigningV201 } from "./v201/certificateSigningV201";
import {
  TransactionEventDeliveryV201,
  type TransactionEventDelivery,
} from "./v201/transactionEventDeliveryV201";
import { EventQueuesV201 } from "./v201/eventQueuesV201";
import { CallPipelineV201, type PendingRequest } from "./v201/callPipelineV201";
import {
  OfflineReplayV201,
  QUEUED_ON_OCPP2,
  type V201QueuedAction,
} from "./v201/offlineReplayV201";
import {
  buildV201InboundRegistry,
  type V201Action,
  type V201HandlerResult,
  type V201InboundContext,
  type V201InboundRegistry,
  type V201RequestPayload,
} from "./v201/inboundRegistryV201";
import { ResponseEffectQueue, type GenerationToken } from "./network-sim";
import { PendingMessageQueue } from "../../domain/transport/PendingMessageQueue";
import { CallExchange } from "./inbound/CallExchange";
import { InboundCallGate, portsAliased } from "./inbound/InboundCallGate";

type V201ResponsePayload =
  | BootNotificationResponseV201
  | HeartbeatResponseV201
  | StatusNotificationResponseV201
  | TransactionEventResponseV201
  | MeterValuesResponseV201
  | AuthorizeResponseV201;

/** True for a promise or any other thenable a handler may return. */
function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
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

export {
  MAX_QUEUED_NOTIFY_EVENTS,
  MAX_QUEUED_SECURITY_EVENTS,
} from "./v201/eventQueuesV201";

export class OCPPMessageHandlerV201 implements IChargePointMessageHandler {
  private readonly _chargePoint: ChargePoint;
  private readonly _webSocket: OCPPWebSocket;
  private readonly _logger: Logger;
  private readonly _codec?: ProtocolCodec;
  private readonly _dataTransferHandler: DataTransferHandler =
    new DataTransferHandler();
  private readonly _inbound: V201InboundRegistry;
  /** TransactionEvent, MeterValues and their sampled values (#877). */
  private readonly _transactionMessages: TransactionMessagesV201;
  /** Tracks in-flight CP→CSMS CALLs by messageId so `handleCallResult` can
   *  correlate a CALLRESULT back to the request that provoked it (issue
   *  #181) — e.g. Authorize.conf carries no idToken of its own, so the
   *  idToken has to come from the original Authorize.req. Entries are
   *  removed once the matching CALLRESULT/CALLERROR arrives. */
  private readonly _pendingRequests = new Map<string, PendingRequest>();
  /** The §4.1.1 one-CALL-in-flight pipeline of CP→CSMS CALLs (#877). */
  private readonly _calls: CallPipelineV201;
  /** Written CALLs whose loss a close must make good until the answer comes
   *  (#664): a critical SecurityEventNotification (A04.FR.02) and the queued
   *  rows of the E11 table (security events, NotifyEvent parts) that stay in
   *  the table until the CSMS answers. By messageId. */
  private readonly _unansweredDeliveries = new Map<
    string,
    { onAnswer: () => void; onLost: () => void }
  >();
  /** StatusNotification CALLs sent and not answered yet, by messageId (#702):
   *  the answer tells the charge point what the CSMS knows. */
  private readonly _statusAcks = new Map<
    string,
    { connectorId: number; status: OCPPStatus }
  >();
  /** True from `onWebSocketClosed` (and before the first connection) until
   *  a CALL is written again: no close is left to queue the TransactionEvents
   *  a drop strands, so the drop queues them itself (#528). */
  private _outageHandled = true;
  /** E11 offline queue (#528), persisted in `pending_messages` when the
   *  charge point has a database; replayed after Boot Accepted. */
  private readonly _pendingQueue: PendingMessageQueue<V201QueuedAction>;
  /** E13 delivery and E11 queueing of TransactionEvents (#877). */
  private readonly _transactionEvents: TransactionEventDeliveryV201;
  /** SecurityEventNotification and NotifyEvent queues (#877). */
  private readonly _eventQueues: EventQueuesV201;
  /** The E11 replay after Boot Accepted (#877). */
  private readonly _offlineReplay: OfflineReplayV201;
  /** Control-plane `data_transfer` callers waiting for the CSMS's answer
   *  (#348), keyed by CALL id — see the 1.6 handler's twin. */
  private readonly _dataTransferWaiters = new CallWaiters<DataTransferResult>(
    DATA_TRANSFER_RESPONSE_TIMEOUT_MS,
    (id) =>
      new Error(
        `DataTransfer ${id}: no answer within ${DATA_TRANSFER_RESPONSE_TIMEOUT_MS}ms`,
      ),
    () => this.clock,
  );
  /** Expert calls (#389) in flight; their answers are routed here first. */
  // A CALL waits for the one in flight (#708): when its caller gave up it is
  // taken back out of the queue.
  private readonly _expertCalls = new ExpertCalls(
    (id) => this._calls.withdrawQueued(id),
    () => this.clock,
  );
  // Response effect queue for deferred handler side effects
  private readonly _responseEffectQueue: ResponseEffectQueue;
  private readonly _gate: InboundCallGate;
  /** Outbound certificate signing and OCSP status requests (#877). */
  private readonly _certificates: CertificateSigningV201;
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
    this._transactionMessages = new TransactionMessagesV201({
      chargePoint,
      logger,
      rng: (name) => this.rng(name),
      generateMessageId: () => this.generateMessageId(),
      send: (action, messageId, payload) =>
        this.send(action, messageId, payload),
      sendTransactionEventCall: (connectorId, payload) =>
        this._transactionEvents.sendTransactionEventCall(connectorId, payload),
    });
    this._pendingQueue = new PendingMessageQueue(
      chargePoint.id,
      chargePoint.database ?? null,
      QUEUED_ON_OCPP2,
      chargePoint.clock,
    );
    this._certificates = new CertificateSigningV201({
      chargePoint,
      logger,
      generateMessageId: () => this.generateMessageId(),
      send: (action, messageId, payload) =>
        this.send(action, messageId, payload),
    });
    // `cp.update` can switch ocppVersion over the same --state-db, leaving
    // rows a 2.x CSMS does not know (one a 1.6 handler queued).
    const dropped = this._pendingQueue.droppedOnLoad;
    if (dropped.length > 0) {
      this._logger.warn(
        `[v2.0.1] Dropped ${dropped.length} queued message(s) not replayed on OCPP 2.x: ${dropped.join(", ")}`,
        LogType.OCPP,
      );
    }
    this._eventQueues = new EventQueuesV201({
      chargePoint,
      logger,
      webSocket,
      pendingQueue: this._pendingQueue,
      unansweredDeliveries: this._unansweredDeliveries,
      generateMessageId: () => this.generateMessageId(),
      send: (
        action,
        messageId,
        payload,
        onDropped,
        transactionEvent,
        onWritten,
      ) =>
        this.send(
          action,
          messageId,
          payload,
          onDropped,
          transactionEvent,
          onWritten,
        ),
    });
    this._transactionEvents = new TransactionEventDeliveryV201({
      chargePoint,
      logger,
      webSocket,
      pendingQueue: this._pendingQueue,
      pendingRequests: this._pendingRequests,
      isOutageHandled: () => this._outageHandled,
      generateMessageId: () => this.generateMessageId(),
      send: (action, messageId, payload, onDropped, transactionEvent) =>
        this.send(action, messageId, payload, onDropped, transactionEvent),
      releaseCall: (messageId, pump) =>
        this._calls.releaseCall(messageId, pump),
      pumpCalls: () => this._calls.pumpCalls(),
    });

    this._calls = new CallPipelineV201({
      chargePoint,
      logger,
      webSocket,
      codec,
      pendingRequests: this._pendingRequests,
      transactionEvents: this._transactionEvents,
      markOutageOver: () => {
        this._outageHandled = false;
      },
    });

    // Initialize response effect queue with deps
    this._responseEffectQueue = new ResponseEffectQueue({
      isGenerationCurrent: (gen) =>
        gen.gen === this._webSocket.currentGeneration().gen,
      defer: (run) => queueMicrotask(run),
      log: (message) => this._logger.info(message, LogType.OCPP),
    });
    this._gate = new InboundCallGate({
      ports: portsAliased(chargePoint, V201_ACTIONS_WITHOUT_STATUS_RESPONSE),
      registry: chargePoint.behaviors,
      logPrefix: "[v2.0.1] ",
      info: (message) => this._logger.info(message, LogType.OCPP),
      warn: (message) => this._logger.warn(message, LogType.OCPP),
    });

    this._offlineReplay = new OfflineReplayV201({
      logger,
      webSocket,
      pendingQueue: this._pendingQueue,
      transactionEvents: this._transactionEvents,
      eventQueues: this._eventQueues,
      markOutageOver: () => {
        this._outageHandled = false;
      },
    });

    // Register close-transaction callback for effect flushing
    // Note: OCPPWebSocket.onCloseTransaction stores a SINGLE callback;
    // since one protocol per connection, this is fine.
    this._webSocket.onCloseTransaction((finalized) => {
      this._gate.abandonAll();
      this._responseEffectQueue.flushAfterCloseFinalization(finalized);
    });

    this._webSocket.setMessageHandler(this.handleIncomingMessage.bind(this));

    // `?.`: the socket doubles of the handler's unit tests have no observers.
    this._webSocket.observers?.on("renewedClientCertificateDiscarded", () =>
      this._certificates.onRenewedClientCertificateDiscarded(),
    );
  }

  /** The charge point's clock (the platform clock for a stand-in without one). */
  private get clock(): SimClock {
    return clockOf(this._chargePoint);
  }

  private clearTimer(handle: TimerHandle | undefined): void {
    if (handle !== undefined) this.clock.clearTimeout(handle);
  }

  /** A random stream of the charge point (system randomness for a stand-in). */
  private rng(name: string): Rng {
    const cp = this._chargePoint as { id: string; rng?: (n: string) => Rng };
    return typeof cp.rng === "function"
      ? cp.rng(name)
      : systemRngStreams.stream(cp.id, name);
  }

  private generateMessageId(): string {
    return this.rng("message-id").uuid();
  }

  /** The exchange of one inbound CALL, bound to this socket's generation. */
  private openExchange(
    messageId: string,
    action: string,
    generation: GenerationToken,
  ): CallExchange {
    const exchange = new CallExchange({
      action,
      messageId,
      generation,
      isGenerationCurrent: (g) =>
        g.gen === this._webSocket.currentGeneration().gen,
      announce: (completion) =>
        this._chargePoint.notifyIncomingCallCompleted(completion),
      writeResult: (payload, gen, onSettled) =>
        this._webSocket.sendResult(messageId, payload, gen, onSettled),
      writeError: (errorCode, errorDescription, gen, onSettled) =>
        this._webSocket.sendError(
          messageId,
          {
            errorCode: errorCode as OCPPErrorCode,
            errorDescription,
            errorDetails: {},
          },
          gen,
          onSettled,
        ),
      effects: this._responseEffectQueue,
      warn: (message) =>
        this._logger.warn(
          message.startsWith("[v2.0.1]") ? message : `[v2.0.1] ${message}`,
          LogType.OCPP,
        ),
    });
    this._gate.track(exchange);
    return exchange;
  }

  private send(
    action: V201Action,
    messageId: string,
    payload: V201RequestPayload,
    onDropped?: (reason: string) => void,
    transactionEvent?: TransactionEventDelivery,
    onWritten?: () => void,
    intercepted = false,
  ): void {
    this._calls.send(
      action,
      messageId,
      payload,
      onDropped,
      transactionEvent,
      onWritten,
      intercepted,
    );
  }

  private handleIncomingMessage(
    messageType: OCPPMessageType,
    messageId: string,
    action: string,
    payload: unknown,
  ): void {
    if (messageType === OCPPMessageType.CALL) {
      // #349: the scenario mechanisms the 1.6 handler consults at this point —
      // the csmsCallTrigger event, inbound policies and one-shot response
      // overrides — apply on 2.0.1 too, through the one gate both handlers
      // share. Scenarios spell actions in either version's vocabulary; a
      // 2.0.1 CALL is looked up under its own name and its 1.6 alias
      // (RequestStartTransaction ← RemoteStartTransaction, …).
      // #396: the control plane announces the CALL under its wire name;
      // every answer below reports itself through the exchange.
      behaviorTapOf(this._chargePoint).observe({
        type: "callReceived",
        action,
        messageId,
        payload,
      });
      const gen = this._webSocket.currentGeneration();
      const exchange = this.openExchange(messageId, action, gen);
      if (this._gate.admit(exchange, payload).kind === "settled") return;

      const entry = this._inbound.get(action);
      if (entry) {
        if (!entry.validate(payload)) {
          // Part 4 §4.3 Table 8: the code names the kind of violation.
          const violation = inboundV2xViolation(
            action,
            payload,
            this._chargePoint.ocppVersion,
          );
          exchange.replyError(violation.errorCode, violation.description);
          return;
        }

        const ctx: V201InboundContext = {
          chargePoint: this._chargePoint,
          logger: this._logger,
          sendCall: (a, p) => this.send(a, this.generateMessageId(), p),
          hasTransactionEventsToDeliver: (id) =>
            this.hasTransactionEventsToDeliver(id),
          certificateSigning: this._certificates.certificateSigning,
          bootAccepted: () => this._bootStatus.status === "Accepted",
        };
        const fail = (error: unknown): void => {
          // The exchange refuses an answer on a connection that changed (and
          // runs no afterResult); that case needs no CALLERROR.
          if (exchange.state !== "open") return;
          // Same answer as the 1.6J handler: a failing handler is the
          // station's fault, so the CSMS gets InternalError instead of
          // waiting for its timeout (#399).
          this._logger.error(
            `[v2.0.1] Error handling ${action}: ${error}`,
            LogType.OCPP,
          );
          exchange.replyError(
            "InternalError",
            // OCPP-J 2.0.1 / 2.1 Part 4 §4.2.3: ErrorDescription is
            // string[255].
            (error instanceof Error ? error.message : String(error)).slice(
              0,
              255,
            ),
          );
        };
        const finish = ({
          response,
          afterResult,
          callError,
        }: V201HandlerResult): void => {
          if (callError) {
            exchange.replyError(callError.code, callError.description);
            return;
          }
          exchange.reply(response, {
            ...(afterResult ? { effect: afterResult } : {}),
          });
        };
        let handled: ReturnType<typeof entry.handle>;
        try {
          handled = entry.handle(payload, ctx);
        } catch (error) {
          fail(error);
          return;
        }
        // #456: await only a real thenable. An unconditional await would
        // defer every CALLRESULT by a microtask and reorder it against the
        // follow-up CALLs other code sends meanwhile. `Promise.resolve`
        // adopts any thenable, including one whose `then` returns nothing.
        if (isThenable(handled)) {
          Promise.resolve(handled)
            .then(finish, fail)
            .catch((error: unknown) =>
              this._logger.error(
                `[v2.0.1] Error answering ${action}: ${error}`,
                LogType.OCPP,
              ),
            );
          return;
        }
        finish(handled);
        return;
      }

      this._logger.warn(
        `[v2.0.1] Unsupported CSMS action ${action}`,
        LogType.OCPP,
      );
      exchange.replyError("NotImplemented", "This action is not supported");
    } else if (messageType === OCPPMessageType.CALLRESULT) {
      try {
        this.observeAnswer(messageId, "result", payload);
        this.handleCallResult(messageId, payload as V201ResponsePayload);
      } finally {
        this.settleDelivery(messageId);
        // The answer frees the §4.1.1 slot (#708), whatever handling it did.
        this._calls.releaseCall(messageId);
      }
    } else if (messageType === OCPPMessageType.CALLERROR) {
      try {
        this.handleCallError(messageId, payload);
      } finally {
        this.settleDelivery(messageId);
        this._calls.releaseCall(messageId);
      }
    }
  }

  private handleCallError(messageId: string, payload: unknown): void {
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
  private observeAnswer(
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

  private handleCallResult(
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

  public hasTransactionEventsToDeliver(transactionId?: string): boolean {
    return this._transactionEvents.hasTransactionEventsToDeliver(transactionId);
  }

  public sendBootNotification(
    bootPayload: BootNotification,
    reason: BootReason = "PowerUp",
  ): void {
    const messageId = this.generateMessageId();
    const payload: BootNotificationRequestV201 = {
      reason,
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
    // B01.FR.05 / G03 / G04 Note 2: StatusNotificationRequest reports
    // connector statuses only, and EVSEs and connectors are numbered from 1.
    // The station scope (connectorId 0, the OCPP 1.6 main controller) has no
    // StatusNotification on 2.x.
    if (connectorId === 0) {
      this._logger.debug(
        `[v2.0.1] StatusNotification for the station (connector 0) not sent: 2.x reports connector statuses only (${status})`,
        LogType.OCPP,
      );
      return;
    }
    const messageId = this.generateMessageId();
    const ev = v201StatusEvse(connectorId);
    const payload: StatusNotificationRequestV201 = {
      timestamp: (opts?.timestamp ?? new Date(this.clock.now())).toISOString(),
      connectorStatus: toV2ConnectorStatus(status),
      evseId: ev.evseId,
      connectorId: ev.connectorId,
    };
    if (this._webSocket.isConnected()) {
      this._statusAcks.set(messageId, { connectorId, status });
    }
    this.send("StatusNotification", messageId, payload);
    const chargingState = ocppStatusToTransactionChargingState(status);
    if (chargingState && !opts?.suppressChargingStateTransactionEvent) {
      this._transactionMessages.sendChargingStateChanged(
        connectorId,
        chargingState,
      );
    }
  }

  public authorize(
    tagId: string,
    idTokenType: IdTokenTypeName = DEFAULT_ID_TOKEN_TYPE,
    hooks?: AuthorizeSendHooks,
  ): void {
    if (idTokenType === "NoAuthorization") {
      // Nothing to authorize: the token is empty (IdTokenEnumType).
      this._logger.info(
        "[v2.0.1] IdToken type NoAuthorization: no Authorize sent",
        LogType.OCPP,
      );
      hooks?.onDropped?.("no_authorization");
      return;
    }
    const messageId = this.generateMessageId();
    const payload: AuthorizeRequestV201 = {
      idToken: this._transactionMessages.wireIdToken(tagId, idTokenType),
    };
    this.send(
      "Authorize",
      messageId,
      payload,
      hooks?.onDropped,
      undefined,
      hooks?.onWritten,
    );
  }

  public sendTransactionEvent(event: TransactionLifecycleEvent): void {
    this._transactionMessages.sendTransactionEvent(event);
  }

  public sendTransactionUpdate(
    connectorId: number,
    options: TransactionUpdateOptions,
  ): void {
    this._transactionMessages.sendTransactionUpdate(connectorId, options);
  }

  public sendMeterValue(
    transactionId: number | undefined,
    connectorId: number,
    context: ReadingContext = "Sample.Periodic",
    overrides: MeterSampleOverrides = {},
  ): void {
    this._transactionMessages.sendMeterValue(
      transactionId,
      connectorId,
      context,
      overrides,
    );
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
    originalRequest: OcppCallRequest,
  ): Promise<OcppCallOutcome> {
    let request = originalRequest;
    const warning =
      this._codec?.outgoingWarning(request.action, request.payload) ?? null;
    if (warning && !request.skipValidation) {
      throw new OcppCallRejectedError("invalid_payload", warning);
    }
    // The behaviors' beforeSend runs before the call is tracked, so the
    // frame shown to the caller is the one that goes out.
    const decision = behaviorTapOf(this._chargePoint).beforeSend(
      request.action,
      request.payload,
    );
    if ("drop" in decision) {
      throw new OcppCallNoAnswerError(
        "dropped",
        `OCPP call ${request.action} dropped (dropped_by_behavior)`,
      );
    }
    request = {
      ...request,
      payload: decision.payload as Record<string, unknown>,
    };
    const id = this.generateMessageId();
    const answer = this._expertCalls.start(id, request);
    // `send` logs the codec warning, if any, as for every CALL; with
    // skipValidation the payload is deliberately unchecked.
    this.send(
      request.action as V201Action,
      id,
      request.payload as unknown as V201RequestPayload,
      (reason) => this._expertCalls.onDropped(id, reason),
      undefined,
      undefined,
      true,
    );
    return answer;
  }

  /** The answer to `messageId` arrived: its delivery is complete (#664). */
  private settleDelivery(messageId: string): void {
    const delivery = this._unansweredDeliveries.get(messageId);
    if (delivery === undefined) return;
    this._unansweredDeliveries.delete(messageId);
    delivery.onAnswer();
  }

  public sendSecurityEventNotification(
    type: string,
    techInfo?: string,
  ): Promise<void> {
    return this._eventQueues.sendSecurityEventNotification(type, techInfo);
  }

  public sendSignCertificate(csr?: string): Promise<void> {
    return this._certificates.sendSignCertificate(csr);
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
    // L01: `Idle` (only sent for a TriggerMessage with no update in
    // progress) names no update, so it carries no requestId (#596).
    const effectiveRequestId =
      requestId ??
      (status === "Idle" ? undefined : this._chargePoint.lastFirmwareRequestId);
    const payload: FirmwareStatusNotificationRequestV201 = {
      status,
      ...(effectiveRequestId !== undefined
        ? { requestId: effectiveRequestId }
        : {}),
    };
    this.send("FirmwareStatusNotification", id, payload);
  }

  public sendNotifyEvent(events: readonly MonitoringEvent[]): void {
    this._eventQueues.sendNotifyEvent(events);
  }

  public queueNotifyEvent(events: readonly MonitoringEvent[]): void {
    this._eventQueues.queueNotifyEvent(events);
  }

  public highestQueuedNotifyEventId(): number {
    return this._eventQueues.highestQueuedNotifyEventId();
  }

  /**
   * H04.FR.01 / H01.FR.16-17 ReservationStatusUpdate.req (#712). Sent like
   * StatusNotification: while the socket is down it is dropped (the CSMS
   * learns the state of the station from the reconnect's boot and status
   * notifications, and an Expired or Removed reservation has nothing to
   * replay), see {@link send}.
   */
  public sendReservationStatusUpdate(
    reservationId: number,
    reservationUpdateStatus: "Expired" | "Removed",
  ): void {
    this.send("ReservationStatusUpdate", this.generateMessageId(), {
      reservationId,
      reservationUpdateStatus,
    });
  }

  /** N01 LogStatusNotification.req (#345); `requestId` as above, from the
   *  GetLog this station last accepted when the caller gives none. */
  public sendLogStatusNotification(
    status: UploadLogStatus,
    requestId?: number,
  ): void {
    const id = this.generateMessageId();
    // N01: as for FirmwareStatusNotification, `Idle` names no upload (#596).
    const effectiveRequestId =
      requestId ??
      (status === "Idle" ? undefined : this._chargePoint.lastLogRequestId);
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
    this._certificates.onBootStatus(status);
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

  public hasTransactionMessagesInFlight(): boolean {
    return this._transactionEvents.hasTransactionMessagesInFlight();
  }

  public onWebSocketClosed(): void {
    // #528, E11.FR.01 / E11.FR.07: every TransactionEvent the CSMS has not
    // settled goes to the offline queue, in creation order and once each —
    // written but unanswered (its `MessageTimeout` timer is cleared, #529),
    // still in the network-sim pipeline, or waiting out
    // `MessageAttemptInterval` for its resend (#490). Close, disconnect,
    // reset and dispose all reach here through ChargePoint.teardownAfterClose.
    // The Set holds them in creation order; queuing one removes it.
    //
    // #708: the CALLs still waiting for the §4.1.1 slot never reached the
    // wire. A TransactionEvent among them is one of the active messages
    // queued below; the others are told, as the socket tells a CALL it drops.
    this._calls.closeQueue();
    // #664: written but unanswered critical events and queued rows go back to
    // the E11 table (a row never left it; a live event is queued now).
    const unanswered = [...this._unansweredDeliveries.values()];
    this._unansweredDeliveries.clear();
    for (const delivery of unanswered) delivery.onLost();
    this._transactionEvents.queueUnsettled();
    this._outageHandled = true;
    for (const pending of this._pendingRequests.values()) {
      this.clearTimer(pending.timeout);
    }
    // Clear written-but-unanswered correlation entries on disconnect.
    // A disconnect must not leave stale correlation state.
    this._pendingRequests.clear();
    // A StatusNotification not answered by now is not known to the CSMS (#702).
    this._statusAcks.clear();
    this._expertCalls.onClosed();
    this._certificates.onConnectionClosed();
  }

  public flushPendingQueue(): void {
    this._offlineReplay.flushPendingQueue();
  }
}
