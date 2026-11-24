import {
  DATA_TRANSFER_RESPONSE_TIMEOUT_MS,
  type DataTransferData,
  type DataTransferResult,
} from "../../domain/types/DataTransfer";
import { behaviorTapOf } from "./behaviorTap";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "../../domain/types/FirmwareLogStatus";
import type {
  AuthorizeRequestV16,
  DataTransferRequestV16,
  DiagnosticsStatusNotificationRequestV16,
  HeartbeatRequestV16,
  SignCertificateRequestV16,
  SignedFirmwareStatusNotificationRequestV16,
  StatusNotificationRequestV16,
} from "@ocpp-cp-simulator/ocpp";
import type {
  OcppMessageErrorPayload,
  OcppMessagePayload,
  OcppMessageRequestPayload,
  OCPPWebSocket,
} from "./OCPPWebSocket";
import { ResponseEffectQueue } from "./network-sim";
import type { ProtocolCodec } from "./profile/ProtocolProfile";
import { CallWaiters } from "./CallWaiters";
import { ExpertCalls } from "./ExpertCalls";
import {
  type OcppCallOutcome,
  type ResolvedOcppCallRequest,
} from "../../domain/types/OcppCall";
import {
  OcppCallNoAnswerError,
  OcppCallRejectedError,
} from "../../domain/errors/OcppCallErrors";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import { type TransactionUpdateOptions } from "../../domain/connector/Transaction";
import type {
  MeterSampleOverrides,
  ReadingContext,
} from "../../domain/connector/MeterValueBuilder";
import { PendingMessageQueue } from "../../domain/transport/PendingMessageQueue";
import { clockOf } from "../../shared/clock";
import type { SimClock } from "../../shared/clock";
import { systemRngStreams } from "../../shared/rng";
import type { Rng } from "../../shared/rng";
import type { TransactionLifecycleEvent } from "../../domain/transport/TransactionLifecycleEvent";
import type { MonitoringEvent } from "../../domain/monitoring/MonitorEvaluation";
import type { Logger } from "../../shared/Logger";
import { LogType } from "../../shared/Logger";
import type {
  BootNotification,
  ChargePointErrorCode,
} from "../../domain/types/OcppTypes";
import {
  OCPPAction,
  OCPPMessageType,
  type OCPPStatus,
} from "../../domain/types/OcppTypes";
import { BootGate } from "../../application/state/machines/BootGate";

// Import handler registry and handlers
import {
  MessageHandlerRegistry,
  buildV16CallHandlerRegistry,
  DataTransferHandler,
} from "./handlers";
import { InboundCallGate, ports16 } from "./inbound/InboundCallGate";
import { QUEUED_ON_OCPP16, RequestHistory } from "./v16/outboundRequestsV16";
import { SerialCallQueueV16 } from "./v16/serialCallQueueV16";
import { TransactionMessagesV16 } from "./v16/transactionMessagesV16";
import { SecurityEventQueueV16 } from "./v16/securityEventQueueV16";
import { InboundCallsV16 } from "./v16/inboundCallV16";
import { CallAnswersV16 } from "./v16/callAnswersV16";
import type {
  OcppMessagePayloadCall,
  OcppMessagePayloadCallResult,
} from "./v16/payloadTypesV16";

export class OCPPMessageHandler {
  private _chargePoint: ChargePoint;
  private _webSocket: OCPPWebSocket;
  private _logger: Logger;
  private readonly _codec: ProtocolCodec;
  private _requests: RequestHistory = new RequestHistory();
  private _registry: MessageHandlerRegistry = new MessageHandlerRegistry();
  // Stored as a field so scenarios / tests can register vendor responders
  // after construction via `getDataTransferHandler().registerVendor(...)`.
  private _dataTransferHandler: DataTransferHandler = new DataTransferHandler();
  /** Control-plane `data_transfer` callers waiting for the CSMS's answer
   *  (#348), keyed by CALL id. Settled by handleCallResult / handleCallError,
   *  rejected when the CALL is dropped, or by their own timer. */
  private readonly _dataTransferWaiters = new CallWaiters<DataTransferResult>(
    DATA_TRANSFER_RESPONSE_TIMEOUT_MS,
    (id) =>
      new Error(
        `DataTransfer ${id}: no answer within ${DATA_TRANSFER_RESPONSE_TIMEOUT_MS}ms`,
      ),
    () => this.clock,
  );

  /** Expert calls (#389) in flight; their answers are routed here first. */
  private readonly _expertCalls = new ExpertCalls(
    (id) => this._delivery.withdrawQueued(id),
    () => this.clock,
  );

  // §4.2 boot gate. Until a BootNotification.conf with status=Accepted
  // arrives we restrict outgoing CALLs. The BootNotification.req itself
  // is exempt so the handshake can complete.
  private _bootGate: BootGate;

  // §4.7/§4.8/§4.10 + errata 3.18: transaction-related messages that fail
  // to deliver are queued and retried. Persists across reboots so power
  // outages don't lose StartTransaction.req for an in-flight transaction.
  private _pendingQueue: PendingMessageQueue;

  // Response effect queue for deferred handler side effects
  private _responseEffectQueue: ResponseEffectQueue;
  private _gate: InboundCallGate;

  /** #565: the start outcomes the delivery records and reads (see
   *  SerialCallQueueV16); held here so the handler's state stays inspectable. */
  private readonly _startOutcomes = new Map<string, number>();

  /** §4.1.1 serial queue, #565 hold and #527 resends of outbound CALLs. */
  private readonly _delivery: SerialCallQueueV16;

  /** StartTransaction / StopTransaction / MeterValues builders. */
  private readonly _transactionMessages: TransactionMessagesV16;

  /** SecurityEventNotification.req and its A04.FR.02 offline queue. */
  private readonly _securityEvents: SecurityEventQueueV16;

  /** Inbound CSMS CALLs: gate, registry, validation, answer (#877). */
  private readonly _inboundCalls: InboundCallsV16;

  /** CALLRESULT / CALLERROR answers to the station's CALLs (#877). */
  private readonly _answers: CallAnswersV16;

  constructor(
    chargePoint: ChargePoint,
    webSocket: OCPPWebSocket,
    logger: Logger,
    codec: ProtocolCodec,
  ) {
    this._chargePoint = chargePoint;
    this._webSocket = webSocket;
    this._logger = logger;
    this._codec = codec;
    this._bootGate = new BootGate(chargePoint.clock);
    this._pendingQueue = new PendingMessageQueue(
      chargePoint.pendingMessages,
      new Set([...QUEUED_ON_OCPP16, OCPPAction.SecurityEventNotification]),
      chargePoint.clock,
    );
    // #528: `cp.update` can switch ocppVersion over the same --state-db,
    // leaving rows (e.g. TransactionEvent) a 1.6 CSMS does not know.
    const dropped = this._pendingQueue.droppedOnLoad;
    if (dropped.length > 0) {
      this._logger.warn(
        `Dropped ${dropped.length} queued message(s) not replayed on OCPP 1.6: ${dropped.join(", ")}`,
        LogType.OCPP,
      );
    }
    this._delivery = new SerialCallQueueV16({
      chargePoint,
      webSocket,
      logger,
      codec,
      bootGate: this._bootGate,
      pendingQueue: this._pendingQueue,
      requests: this._requests,
      startOutcomes: this._startOutcomes,
      generateMessageId: () => this.generateMessageId(),
    });
    this._transactionMessages = new TransactionMessagesV16({
      chargePoint,
      logger,
      delivery: this._delivery,
      generateMessageId: () => this.generateMessageId(),
    });
    this._securityEvents = new SecurityEventQueueV16({
      chargePoint,
      webSocket,
      logger,
      bootGate: this._bootGate,
      pendingQueue: this._pendingQueue,
      delivery: this._delivery,
      generateMessageId: () => this.generateMessageId(),
    });

    // Initialize response effect queue with deps
    this._responseEffectQueue = new ResponseEffectQueue({
      isGenerationCurrent: (gen) =>
        gen.gen === this._webSocket.currentGeneration().gen,
      defer: (run) => queueMicrotask(run),
      log: (message) => this._logger.info(message, LogType.OCPP),
    });
    this._gate = new InboundCallGate({
      ports: ports16(chargePoint),
      registry: chargePoint.behaviors,
      silenced: () => this._bootGate.isInboundSilenced(),
      info: (message) => this._logger.info(message, LogType.OCPP),
      warn: (message) => this._logger.warn(message, LogType.OCPP),
    });

    // Register close-transaction callback for effect flushing (if available)
    if (this._webSocket.onCloseTransaction) {
      this._webSocket.onCloseTransaction((finalized) => {
        this._gate.abandonAll();
        this._responseEffectQueue.flushAfterCloseFinalization(finalized);
      });
    }

    this._inboundCalls = new InboundCallsV16({
      chargePoint,
      webSocket,
      logger,
      registry: () => this._registry,
      gate: this._gate,
      responseEffectQueue: this._responseEffectQueue,
    });
    this._answers = new CallAnswersV16({
      chargePoint,
      logger,
      registry: () => this._registry,
      requests: this._requests,
      expertCalls: this._expertCalls,
      dataTransferWaiters: this._dataTransferWaiters,
      delivery: this._delivery,
    });

    this._webSocket.setMessageHandler(this.handleIncomingMessage.bind(this));
    this.initializeHandlers();
  }

  /**
   * Initialize all message handlers using the registry pattern
   */
  private initializeHandlers(): void {
    // Use the shared factory to populate the registry with all OCPP 1.6
    // CALL and CALLRESULT handlers. This factory creates stateless handler
    // instances that can be reused by multiple transports (WebSocket, SOAP).
    this._registry = buildV16CallHandlerRegistry();

    // Register the instance-specific DataTransferHandler so scenarios can
    // register vendor responders via getDataTransferHandler().
    // §4.3/§5.6: DataTransfer is a Core message. Without this handler the
    // registry returns NotImplemented, which is wrong — CSMS-side
    // DataTransfer should be answered with UnknownVendorId at minimum.
    this._registry.registerCallHandler(
      OCPPAction.DataTransfer,
      this._dataTransferHandler,
    );
  }

  /** Expose the DataTransfer handler so scenarios can register vendor
   *  responders without reaching into the private registry. */
  public getDataTransferHandler(): DataTransferHandler {
    return this._dataTransferHandler;
  }

  /** Update the boot gate. Called by BootNotificationResultHandler. */
  public setBootStatus(
    status:
      | { status: "Accepted" }
      | { status: "Pending" }
      | { status: "Rejected"; retryAfter: Date },
  ): void {
    this._bootGate.set(status);
    if (status.status === "Accepted") {
      // Drain anything that was queued behind the boot gate while we
      // waited for BootNotification.conf. Microtask so the BootNotification
      // CALLRESULT flow finishes settling before we start sending.
      queueMicrotask(() => this._delivery.pumpSerialQueue());
    }
  }

  /**
   * §4.2: outgoing CALLs are restricted while BootNotification has not yet
   * been Accepted. BootNotification itself + the CALLRESULT replies are
   * always permitted (they're how the handshake unblocks).
   *
   * - Pending: only allow BootNotification (e.g. TriggerMessage-driven
   *   resend). Other CALLs are dropped with a warning.
   * - Rejected: nothing goes out at all until retryAfter elapses.
   * - Idle (pre-handshake): allow BootNotification only.
   */
  /** §4.2: CALLs made inside `fn` are the answer to a TriggerMessage. */
  public runTriggered<T>(fn: () => T): T {
    return this._bootGate.runTriggered(fn);
  }

  private isCallAllowed(action: OCPPAction): boolean {
    return this._bootGate.isCallAllowed(action);
  }

  public authorize(tagId: string): void {
    const messageId = this.generateMessageId();
    const payload: AuthorizeRequestV16 = { idTag: tagId };
    this._delivery.sendRequest(OCPPAction.Authorize, messageId, payload);
  }

  /** StartTransaction.req or StopTransaction.req (TransactionMessagesV16). */
  public sendTransactionEvent(event: TransactionLifecycleEvent): void {
    this._transactionMessages.sendTransactionEvent(event);
  }

  public sendTransactionUpdate(
    connectorId: number,
    options: TransactionUpdateOptions,
  ): void {
    // OCPP 1.6 has no TransactionEvent; in-transaction state is carried by
    // StatusNotification and MeterValues (#335). Refuse loudly rather than
    // emit a frame the CSMS cannot parse.
    this._logger.warn(
      `[v1.6] transaction_event (${options.triggerReason}) on connector ${connectorId} ignored: TransactionEvent is an OCPP 2.x message`,
      LogType.TRANSACTION,
    );
  }

  public sendBootNotification(bootPayload: BootNotification): void {
    const messageId = this.generateMessageId();
    // bootPayload is already in the correct format (BootNotificationRequest from ts-ocpp)
    this._delivery.sendRequest(
      OCPPAction.BootNotification,
      messageId,
      bootPayload,
    );
  }

  public sendHeartbeat(): void {
    const messageId = this.generateMessageId();
    const payload: HeartbeatRequestV16 = {};
    this._delivery.sendRequest(OCPPAction.Heartbeat, messageId, payload);
  }

  /**
   * §4.3 CP-initiated DataTransfer.req. The vendor / message id / payload
   * semantics are entirely vendor-specific; the CP just packages them and
   * lets the CSMS respond with Accepted / Rejected / UnknownVendorId /
   * UnknownMessageId.
   */
  public sendDataTransfer(
    vendorId: string,
    messageId?: string,
    data?: DataTransferData,
  ): Promise<DataTransferResult> {
    // sendRequest suppresses a gated CALL with a warning and nothing else;
    // a caller waiting for an answer needs the refusal as a rejection.
    if (!this.isCallAllowed(OCPPAction.DataTransfer)) {
      return Promise.reject(
        new Error(
          "DataTransfer blocked by the boot gate — BootNotification not yet Accepted",
        ),
      );
    }
    const id = this.generateMessageId();
    // 1.6 §7.18: `data` is a string. An object from a 2.0.1-shaped caller is
    // JSON-encoded rather than refused, so one command shape serves both.
    const wireData =
      data === undefined
        ? undefined
        : typeof data === "string"
          ? data
          : JSON.stringify(data);
    const payload: DataTransferRequestV16 = {
      vendorId,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(wireData !== undefined ? { data: wireData } : {}),
    };
    const answer = this._dataTransferWaiters.register(id);
    this._delivery.sendRequest(
      OCPPAction.DataTransfer,
      id,
      payload,
      undefined,
      (reason) =>
        this._dataTransferWaiters.reject(
          id,
          new Error(`DataTransfer ${id} dropped (${reason})`),
        ),
    );
    return answer;
  }

  /** Expert OCPP call (#389). Rides the §4.1.1 serial queue like any CALL,
   *  but its answer goes to the caller, and to the result handlers only
   *  when `applyResponse` is set. */
  public async sendOcppCall(
    originalRequest: ResolvedOcppCallRequest,
  ): Promise<OcppCallOutcome> {
    let request = originalRequest;
    // ChargePoint.sendOcppCall checked the action against the 1.6 catalog,
    // every entry of which is an OCPPAction.
    const action = request.action as OCPPAction;
    if (!this.isCallAllowed(action)) {
      throw new OcppCallRejectedError(
        "boot_gate",
        `${action} blocked by the boot gate — BootNotification not yet Accepted`,
      );
    }
    const warning = this._codec.outgoingWarning(action, request.payload);
    if (warning && !request.skipValidation) {
      throw new OcppCallRejectedError("invalid_payload", warning);
    }
    // The behaviors' beforeSend runs before the call is tracked, so the
    // frame shown to the caller is the one that goes out.
    const decision = behaviorTapOf(this._chargePoint).beforeSend(
      action,
      request.payload,
    );
    if ("drop" in decision) {
      throw new OcppCallNoAnswerError(
        "dropped",
        `OCPP call ${action} dropped (dropped_by_behavior)`,
      );
    }
    request = {
      ...request,
      payload: decision.payload as Record<string, unknown>,
    };
    const id = this.generateMessageId();
    const answer = this._expertCalls.start(id, request);
    // Deliberately unchecked when skipValidation is set: sendRequest logs the
    // codec warning, as for every CALL.
    this._delivery.sendRequest(
      action,
      id,
      request.payload as unknown as OcppMessageRequestPayload,
      this.connectorOf(request.payload),
      (reason) => this._expertCalls.onDropped(id, reason),
      undefined,
      true,
    );
    return answer;
  }

  /** The connector an expert call concerns, for the result handlers that
   *  key on it when `applyResponse` is set: the payload's `connectorId`
   *  (StartTransaction, MeterValues, StatusNotification), else the connector
   *  running its `transactionId` (StopTransaction). */
  private connectorOf(payload: Record<string, unknown>): number | undefined {
    if (typeof payload.connectorId === "number") return payload.connectorId;
    if (typeof payload.transactionId !== "number") return undefined;
    for (const connector of this._chargePoint.connectors.values()) {
      if (connector.transaction?.id === payload.transactionId) {
        return connector.id;
      }
    }
    return undefined;
  }

  /** OCPP 1.6 Security Whitepaper: CP-initiated security event
   *  (SecurityEventQueueV16). */
  public sendSecurityEventNotification(
    type: string,
    techInfo?: string,
  ): Promise<void> {
    return this._securityEvents.sendSecurityEventNotification(type, techInfo);
  }

  /** #734: see SecurityEventQueueV16.queueSecurityEventNotification. */
  public queueSecurityEventNotification(type: string, techInfo?: string): void {
    this._securityEvents.queueSecurityEventNotification(type, techInfo);
  }

  /** #734: see SecurityEventQueueV16.flushQueuedSecurityEvents. */
  public flushQueuedSecurityEvents(): void {
    this._securityEvents.flushQueuedSecurityEvents();
  }

  /** Generate or forward a CSR for the charge point certificate signing flow. */
  public async sendSignCertificate(csr?: string): Promise<void> {
    const cpoName = this._chargePoint.configuration.getString("CpoName") ?? "";
    const quirks = this._chargePoint.certificateQuirks;

    let payloadCsr: string;
    if (csr) {
      payloadCsr = csr;
      // #732: a CertificateSigned is matched against it like a generated one
      // (a CSR that does not parse is only forwarded).
      this._chargePoint.certificateStore.recordPendingCsr(
        "ChargingStationCertificate",
        csr,
      );
    } else {
      // Log when a non-default key algorithm is used
      if (quirks.csrKeyAlgorithm === "RSA") {
        this._logger.info(
          "SignCertificate: generating RSA CSR (certificate quirk)",
          LogType.OCPP,
        );
      }

      payloadCsr = await this._chargePoint.certificateStore.generateNewCsr(
        this._chargePoint.id,
        cpoName,
        {
          keyAlgorithm: quirks.csrKeyAlgorithm,
          pemLineEndings: quirks.csrPemLineEndings,
        },
      );
    }

    const messageId = this.generateMessageId();
    const payload: SignCertificateRequestV16 = { csr: payloadCsr };
    this._delivery.sendRequest(OCPPAction.SignCertificate, messageId, payload);
  }

  /**
   * §4.4 DiagnosticsStatusNotification.req. `Idle` is sent only in
   * response to TriggerMessage when no upload is in progress; other
   * statuses (Uploading/Uploaded/UploadFailed) fire from GetDiagnostics
   * progression.
   */
  public sendDiagnosticsStatusNotification(status: DiagnosticsStatus): void {
    const messageId = this.generateMessageId();
    const payload: DiagnosticsStatusNotificationRequestV16 = { status };
    this._delivery.sendRequest(
      OCPPAction.DiagnosticsStatusNotification,
      messageId,
      payload,
    );
  }

  /**
   * §4.5 FirmwareStatusNotification.req. Same semantics as
   * DiagnosticsStatusNotification — `Idle` only in response to
   * TriggerMessage; other statuses (Downloading/Downloaded/Installing/
   * Installed/...) fire from UpdateFirmware progression.
   */
  public sendFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    // 1.6 §6.24 FirmwareStatusNotification.req has no requestId (only the
    // Whitepaper's Signed variant does), and its status set is the first
    // seven of 2.0.1's. Anything wider is sent as given: the codec's
    // outgoing check warns, and a CSMS that rejects it is the honest
    // answer for a 2.0.1-only status on a 1.6 wire (#345).
    if (requestId !== undefined) {
      this._logger.debug(
        `FirmwareStatusNotification carries no requestId on OCPP 1.6; dropping requestId=${requestId}`,
        LogType.OCPP,
      );
    }
    const messageId = this.generateMessageId();
    const payload = { status };
    this._delivery.sendRequest(
      OCPPAction.FirmwareStatusNotification,
      messageId,
      payload,
    );
  }

  /**
   * OCPP 1.6 Security Whitepaper LogStatusNotification.req. `requestId`
   * carries the id from the triggering GetLog.req (TriggerMessage-driven
   * `Idle` sends have none). The 2.0.1-only `AcceptedCanceled` is sent as
   * given, as for firmware above.
   */
  public sendLogStatusNotification(
    status: UploadLogStatus,
    requestId?: number,
  ): void {
    const messageId = this.generateMessageId();
    const payload = {
      status,
      ...(requestId !== undefined ? { requestId } : {}),
    };
    this._delivery.sendRequest(
      OCPPAction.LogStatusNotification,
      messageId,
      payload,
    );
  }

  /**
   * OCPP 1.6 Security Whitepaper SignedFirmwareStatusNotification.req —
   * the signed counterpart to FirmwareStatusNotification, carrying the
   * `requestId` from the triggering SignedUpdateFirmware.req.
   */
  public sendSignedFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    const messageId = this.generateMessageId();
    const payload: SignedFirmwareStatusNotificationRequestV16 = {
      status,
      ...(requestId !== undefined ? { requestId } : {}),
    };
    this._delivery.sendRequest(
      OCPPAction.SignedFirmwareStatusNotification,
      messageId,
      payload,
    );
  }

  /** OCPP 1.6 has no NotifyEvent; 2.x variable monitoring never runs on
   *  1.6, so nothing reaches this (#457). */
  public sendNotifyEvent(_events: readonly MonitoringEvent[]): void {
    this._logger.debug(
      "NotifyEvent is OCPP 2.x only; ignoring it on OCPP 1.6",
      LogType.OCPP,
    );
  }

  /** Same as above: nothing to queue on 1.6 (#538). */
  public queueNotifyEvent(events: readonly MonitoringEvent[]): void {
    this.sendNotifyEvent(events);
  }

  public highestQueuedNotifyEventId(): number {
    return 0;
  }

  /** §4.7 MeterValues.req (TransactionMessagesV16.sendMeterValue). */
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

  /**
   * §4.9 StatusNotification.req. `errorCode` defaults to NoError when the
   * status is Operative; for Faulted (or warnings during Preparing/Suspended
   * /Finishing) pass the appropriate ChargePointErrorCode via `opts`.
   */
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
    const payload: StatusNotificationRequestV16 = {
      connectorId,
      errorCode: opts?.errorCode ?? "NoError",
      status,
      ...(opts?.info ? { info: opts.info } : {}),
      ...(opts?.vendorErrorCode
        ? { vendorErrorCode: opts.vendorErrorCode }
        : {}),
      ...(opts?.vendorId ? { vendorId: opts.vendorId } : {}),
      ...(opts?.timestamp ? { timestamp: opts.timestamp.toISOString() } : {}),
    };
    this._delivery.sendRequest(
      OCPPAction.StatusNotification,
      messageId,
      payload,
    );
  }

  /** Called by the ChargePoint after the WebSocket has closed (during teardown,
   *  after the pipeline drain in Task 7 ordering). Cancels the in-flight timer,
   *  salvages unsent queued CALLs, and clears the queue. The written-but-unanswered
   *  in-flight CALL is not salvaged here (it keeps existing discard behavior);
   *  it was already handled via onSerialSettled during the drain when the
   *  settlement fired (socket_closed). */
  public onWebSocketClosed(): void {
    this._delivery.clearInFlightOnClose();
    // No answer can reach a waiter over a closed socket; say so now rather
    // than at the timer.
    this._dataTransferWaiters.rejectAll(
      (id) => new Error(`DataTransfer ${id} dropped (socket_closed)`),
    );
    this._expertCalls.onClosed();
    this._delivery.salvageOnClose();
  }

  /** See {@link SerialCallQueueV16.queueUnansweredTransactionCall}: §3.7 /
   *  errata 3.36, called by a graceful daemon shutdown. Returns whether a
   *  CALL was queued. */
  public queueUnansweredTransactionCall(): boolean {
    return this._delivery.queueUnansweredTransactionCall();
  }

  /**
   * Re-attempt delivery of every queued transaction-related message.
   * Called from `ChargePoint.connect`'s onopen handler after a successful
   * BootNotification round-trip. A message resent after a CALLERROR before
   * it was queued goes on with its count (#527, §3.7.1), which
   * `onTransactionMessageCallError` and `discardResendPastLimit` hold to
   * `TransactionMessageAttempts`.
   */
  public flushPendingQueue(): void {
    if (this._pendingQueue.size() === 0) return;
    this.flushQueuedSecurityEvents();
    if (this._pendingQueue.size() === 0) return;
    this._delivery.replayPendingQueue();
  }

  private handleIncomingMessage(
    messageType: OCPPMessageType,
    messageId: string,
    action: OCPPAction,
    payload: OcppMessagePayload,
  ): void {
    this._logger.info(
      `Handling incoming message: ${messageType}, ${messageId}, ${action}`,
      LogType.OCPP,
    );
    switch (messageType) {
      case OCPPMessageType.CALL:
        // Not awaited: each CALL starts at once, without waiting for the
        // previous one's answer; handleCall awaits `handler.handle()`
        // internally. An async handler (InstallCertificate and
        // CertificateSigned hash via WebCrypto) can therefore be overtaken
        // by a later CALL. Handlers that need the order keep it themselves:
        // the certificate handlers run through CertificateStore, which
        // completes its operations one at a time (#456).
        void this._inboundCalls.handleCall(
          messageId,
          action,
          payload as OcppMessagePayloadCall,
        );
        break;
      case OCPPMessageType.CALLRESULT:
        this.observeAnswer(messageId, "result", payload);
        this._answers.handleCallResult(
          messageId,
          payload as OcppMessagePayloadCallResult,
        );
        break;
      case OCPPMessageType.CALLERROR:
        this.observeAnswer(messageId, "error", payload);
        this._answers.handleCallError(
          messageId,
          payload as OcppMessageErrorPayload,
        );
        break;
      default:
        this._logger.error(
          `Unknown message type: ${messageType}`,
          LogType.OCPP,
        );
    }
  }

  /** Tell the behaviors' `callResult` hooks the CSMS answered one of our CALLs. */
  private observeAnswer(
    messageId: string,
    outcome: "result" | "error",
    payload: unknown,
  ): void {
    const request = this._requests.get(messageId);
    if (!request) return;
    behaviorTapOf(this._chargePoint).observe({
      type: "callResult",
      action: request.action,
      messageId,
      outcome,
      payload,
    });
  }

  // All handler methods have been moved to individual handler classes
  // See packages/core/src/cp/handlers/ directory

  /** The charge point's clock (the platform clock for a stand-in without one). */
  private get clock(): SimClock {
    return clockOf(this._chargePoint);
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
}
