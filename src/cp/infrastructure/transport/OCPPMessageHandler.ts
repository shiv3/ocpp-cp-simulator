import type {
  AuthorizeRequestV16,
  AuthorizeResponseV16,
  BootNotificationResponseV16,
  CancelReservationRequestV16,
  ChangeAvailabilityRequestV16,
  ChangeConfigurationRequestV16,
  ChangeConfigurationResponseV16,
  ClearCacheRequestV16,
  ClearChargingProfileRequestV16,
  DataTransferRequestV16,
  DataTransferResponseV16,
  DiagnosticsStatusNotificationRequestV16,
  DiagnosticsStatusNotificationResponseV16,
  FirmwareStatusNotificationRequestV16,
  FirmwareStatusNotificationResponseV16,
  GetCompositeScheduleRequestV16,
  GetConfigurationRequestV16,
  GetDiagnosticsRequestV16,
  GetLocalListVersionRequestV16,
  HeartbeatRequestV16,
  HeartbeatResponseV16,
  MeterValuesRequestV16,
  MeterValuesResponseV16,
  RemoteStartTransactionRequestV16,
  RemoteStopTransactionRequestV16,
  ReserveNowRequestV16,
  ResetRequestV16,
  SendLocalListRequestV16,
  SetChargingProfileRequestV16,
  StartTransactionRequestV16,
  StartTransactionResponseV16,
  StatusNotificationRequestV16,
  StatusNotificationResponseV16,
  StopTransactionRequestV16,
  StopTransactionResponseV16,
  TriggerMessageRequestV16,
  UnlockConnectorRequestV16,
  UpdateFirmwareRequestV16,
} from "@cshil/ocpp-tools";
import type {
  OcppMessageErrorPayload,
  OcppMessagePayload,
  OcppMessageRequestPayload,
  OcppMessageResponsePayload,
  OCPPWebSocket,
} from "./OCPPWebSocket";
import type { ProtocolCodec } from "./profile/ProtocolProfile";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import { Transaction } from "../../domain/connector/Transaction";
import {
  buildSampledValues,
  type ReadingContext,
} from "../../domain/connector/MeterValueBuilder";
import { PendingMessageQueue } from "../../domain/transport/PendingMessageQueue";
import { Logger, LogType } from "../../shared/Logger";
import {
  BootNotification,
  ChargePointErrorCode,
  OCPPAction,
  OCPPErrorCode,
  OCPPMessageType,
  OCPPStatus,
} from "../../domain/types/OcppTypes";

// Import handler registry and handlers
import {
  MessageHandlerRegistry,
  HandlerContext,
  RemoteStartTransactionHandler,
  RemoteStopTransactionHandler,
  ResetHandler,
  GetDiagnosticsHandler,
  GetConfigurationHandler,
  ChangeConfigurationHandler,
  TriggerMessageHandler,
  ClearCacheHandler,
  UnlockConnectorHandler,
  ReserveNowHandler,
  CancelReservationHandler,
  SetChargingProfileHandler,
  ClearChargingProfileHandler,
  GetCompositeScheduleHandler,
  BootNotificationResultHandler,
  StartTransactionResultHandler,
  StopTransactionResultHandler,
  AuthorizeResultHandler,
  HeartbeatResultHandler,
  MeterValuesResultHandler,
  StatusNotificationResultHandler,
  DataTransferResultHandler,
  DataTransferHandler,
  ChangeAvailabilityHandler,
  GetLocalListVersionHandler,
  SendLocalListHandler,
  UpdateFirmwareHandler,
} from "./handlers";

type CoreOcppMessagePayloadCall =
  | ChangeAvailabilityRequestV16
  | ChangeConfigurationRequestV16
  | ClearCacheRequestV16
  | GetConfigurationRequestV16
  | RemoteStartTransactionRequestV16
  | RemoteStopTransactionRequestV16
  | ResetRequestV16
  | UnlockConnectorRequestV16;

type FirmwareManagementOcppMessagePayloadCall =
  | GetDiagnosticsRequestV16
  | UpdateFirmwareRequestV16;

type LocalAuthListManagementOcppMessagePayloadCall =
  | GetLocalListVersionRequestV16
  | SendLocalListRequestV16;

type ReservationOcppMessagePayloadCall =
  | CancelReservationRequestV16
  | ReserveNowRequestV16;

type SmartChargingOcppMessagePayloadCall =
  | ClearChargingProfileRequestV16
  | GetCompositeScheduleRequestV16
  | SetChargingProfileRequestV16;

type RemoteTriggerOcppMessagePayloadCall = TriggerMessageRequestV16;

type OcppMessagePayloadCall =
  | CoreOcppMessagePayloadCall
  | FirmwareManagementOcppMessagePayloadCall
  | LocalAuthListManagementOcppMessagePayloadCall
  | ReservationOcppMessagePayloadCall
  | SmartChargingOcppMessagePayloadCall
  | RemoteTriggerOcppMessagePayloadCall;

type CoreOcppMessagePayloadCallResult =
  | AuthorizeResponseV16
  | BootNotificationResponseV16
  | ChangeConfigurationResponseV16
  | DataTransferResponseV16
  | HeartbeatResponseV16
  | MeterValuesResponseV16
  | StartTransactionResponseV16
  | StatusNotificationResponseV16
  | StopTransactionResponseV16;

type FirmwareManagementOcppMessagePayloadCallResult =
  | DiagnosticsStatusNotificationResponseV16
  | FirmwareStatusNotificationResponseV16;

type OcppMessagePayloadCallResult =
  | CoreOcppMessagePayloadCallResult
  | FirmwareManagementOcppMessagePayloadCallResult;

interface OCPPRequest {
  type: OCPPMessageType;
  action: OCPPAction;
  id: string;
  payload: OcppMessagePayload;
  connectorId?: number | null;
}

/**
 * Predicate for "is this CALL a transaction-related message that must be
 * queued on offline" (§4.7/§4.8/§4.10). MeterValues without a transaction
 * id are informational and intentionally NOT queued — see §4.7.
 */
function isTransactionRelated(action: OCPPAction): boolean {
  return (
    action === OCPPAction.StartTransaction ||
    action === OCPPAction.StopTransaction ||
    action === OCPPAction.MeterValues
  );
}

class RequestHistory {
  private _currentId: string = "";
  private _requests: Map<string, OCPPRequest> = new Map();

  public add(request: OCPPRequest): void {
    this._currentId = request.id;
    this._requests.set(request.id, request);
  }

  public current(): OCPPRequest | undefined {
    return this._requests.get(this._currentId);
  }

  public get(id: string): OCPPRequest | undefined {
    return this._requests.get(id);
  }

  public remove(id: string): void {
    this._requests.delete(id);
  }
}

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

  // §4.2 boot gate. Until a BootNotification.conf with status=Accepted
  // arrives we restrict outgoing CALLs. The BootNotification.req itself
  // is exempt so the handshake can complete.
  private _bootStatus:
    | { status: "Idle" }
    | { status: "Accepted" }
    | { status: "Pending" }
    | { status: "Rejected"; retryAfter: Date } = { status: "Idle" };

  // §4.7/§4.8/§4.10 + errata 3.18: transaction-related messages that fail
  // to deliver are queued and retried. Persists across reboots so power
  // outages don't lose StartTransaction.req for an in-flight transaction.
  private _pendingQueue: PendingMessageQueue;

  // OCPP-J §4.1.1 (Synchronicity): "A Charge Point or Central System
  // SHOULD NOT send a CALL message to the other party unless all the
  // CALL messages it sent before have been responded to or have timed
  // out." We serialize outgoing CALLs through this queue so only one is
  // in-flight at a time. Without this, real CSMS implementations drop
  // post-Boot StatusNotification fan-outs at the application layer and
  // then issue TriggerMessage to recover (observed in dev env).
  private _serialQueue: Array<{
    action: OCPPAction;
    id: string;
    payload: OcppMessageRequestPayload;
    connectorId?: number;
  }> = [];
  private _serialInFlight: {
    action: OCPPAction;
    id: string;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  // §4.1.1 lets the implementation pick the CALL timeout. 30s is a common
  // CSMS default and roughly matches Configuration's default
  // TransactionMessageRetryInterval (60s).
  private static readonly SERIAL_CALL_TIMEOUT_MS = 30_000;

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
    this._pendingQueue = new PendingMessageQueue(
      chargePoint.id,
      chargePoint.database,
    );

    this._webSocket.setMessageHandler(this.handleIncomingMessage.bind(this));
    this.initializeHandlers();
  }

  /**
   * Initialize all message handlers using the registry pattern
   */
  private initializeHandlers(): void {
    // Register CALL handlers (incoming requests from central system)
    this._registry.registerCallHandler(
      OCPPAction.RemoteStartTransaction,
      new RemoteStartTransactionHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.RemoteStopTransaction,
      new RemoteStopTransactionHandler(),
    );
    this._registry.registerCallHandler(OCPPAction.Reset, new ResetHandler());
    this._registry.registerCallHandler(
      OCPPAction.GetDiagnostics,
      new GetDiagnosticsHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.TriggerMessage,
      new TriggerMessageHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.GetConfiguration,
      new GetConfigurationHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.ChangeConfiguration,
      new ChangeConfigurationHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.ClearCache,
      new ClearCacheHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.UnlockConnector,
      new UnlockConnectorHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.ReserveNow,
      new ReserveNowHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.CancelReservation,
      new CancelReservationHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.SetChargingProfile,
      new SetChargingProfileHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.ClearChargingProfile,
      new ClearChargingProfileHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.GetCompositeSchedule,
      new GetCompositeScheduleHandler(),
    );
    // §4.3/§5.6: DataTransfer is a Core message. Without this handler the
    // registry returns NotImplemented, which is wrong — CSMS-side
    // DataTransfer should be answered with UnknownVendorId at minimum.
    this._registry.registerCallHandler(
      OCPPAction.DataTransfer,
      this._dataTransferHandler,
    );
    // §5.2: ChangeAvailability is Core. Without this, CSMS can't put the
    // CP or any connector into maintenance.
    this._registry.registerCallHandler(
      OCPPAction.ChangeAvailability,
      new ChangeAvailabilityHandler(),
    );
    // §9 LocalAuthListManagement
    this._registry.registerCallHandler(
      OCPPAction.GetLocalListVersion,
      new GetLocalListVersionHandler(),
    );
    this._registry.registerCallHandler(
      OCPPAction.SendLocalList,
      new SendLocalListHandler(),
    );
    // §6.19 FirmwareManagement: UpdateFirmware. (GetDiagnostics is
    // registered above; the matching outbound status notifications fire
    // from inside ChargePoint.simulateFirmwareUpdate / the GetDiagnostics
    // handler — there is no CALLRESULT counterpart to register.)
    this._registry.registerCallHandler(
      OCPPAction.UpdateFirmware,
      new UpdateFirmwareHandler(),
    );

    // Register CALLRESULT handlers (incoming responses from central system)
    this._registry.registerCallResultHandler(
      OCPPAction.BootNotification,
      new BootNotificationResultHandler(),
    );
    this._registry.registerCallResultHandler(
      OCPPAction.Authorize,
      new AuthorizeResultHandler(),
    );
    this._registry.registerCallResultHandler(
      OCPPAction.Heartbeat,
      new HeartbeatResultHandler(),
    );
    this._registry.registerCallResultHandler(
      OCPPAction.StatusNotification,
      new StatusNotificationResultHandler(),
    );
    this._registry.registerCallResultHandler(
      OCPPAction.DataTransfer,
      new DataTransferResultHandler(),
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
    this._bootStatus = status;
    if (status.status === "Accepted") {
      // Drain anything that was queued behind the boot gate while we
      // waited for BootNotification.conf. Microtask so the BootNotification
      // CALLRESULT flow finishes settling before we start sending.
      queueMicrotask(() => this.pumpSerialQueue());
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
  private isCallAllowed(action: OCPPAction): boolean {
    if (action === OCPPAction.BootNotification) return true;
    switch (this._bootStatus.status) {
      case "Accepted":
        return true;
      case "Pending":
        return false;
      case "Rejected":
        return Date.now() >= this._bootStatus.retryAfter.getTime();
      case "Idle":
        return false;
    }
  }

  public authorize(tagId: string): void {
    const messageId = this.generateMessageId();
    const payload: AuthorizeRequestV16 = { idTag: tagId };
    this.sendRequest(OCPPAction.Authorize, messageId, payload);
  }

  public startTransaction(transaction: Transaction, connectorId: number): void {
    const messageId = this.generateMessageId();
    const payload: StartTransactionRequestV16 = {
      connectorId: connectorId,
      idTag: transaction.tagId,
      meterStart: transaction.meterStart,
      timestamp: transaction.startTime.toISOString(),
      // §4.8 MUST: include reservationId when this transaction ends a
      // reservation. Domain layer populates this on the Transaction.
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
    };
    this.sendRequest(
      OCPPAction.StartTransaction,
      messageId,
      payload,
      connectorId,
    );
  }

  public stopTransaction(transaction: Transaction, connectorId: number): void {
    const messageId = this.generateMessageId();
    // §4.10: reason MAY be omitted when "Local" (the default), but SHOULD
    // be set to a correct value otherwise. The domain layer assigns
    // transaction.stopReason in non-default stop paths (Remote / Reset /
    // EVDisconnected / UnlockCommand / DeAuthorized / …).
    const reason = transaction.stopReason;
    const payload: StopTransactionRequestV16 = {
      transactionId: transaction.id!,
      idTag: transaction.tagId,
      meterStop: transaction.meterStop!,
      timestamp: transaction.stopTime!.toISOString(),
      ...(reason && reason !== "Local" ? { reason } : {}),
    };
    this.sendRequest(
      OCPPAction.StopTransaction,
      messageId,
      payload,
      connectorId,
    );
  }

  public sendBootNotification(bootPayload: BootNotification): void {
    const messageId = this.generateMessageId();
    // bootPayload is already in the correct format (BootNotificationRequest from ts-ocpp)
    this.sendRequest(OCPPAction.BootNotification, messageId, bootPayload);
  }

  public sendHeartbeat(): void {
    const messageId = this.generateMessageId();
    const payload: HeartbeatRequestV16 = {};
    this.sendRequest(OCPPAction.Heartbeat, messageId, payload);
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
    data?: string,
  ): void {
    const id = this.generateMessageId();
    const payload: DataTransferRequestV16 = {
      vendorId,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(data !== undefined ? { data } : {}),
    };
    this.sendRequest(OCPPAction.DataTransfer, id, payload);
  }

  /**
   * §4.4 DiagnosticsStatusNotification.req. `Idle` is sent only in
   * response to TriggerMessage when no upload is in progress; other
   * statuses (Uploading/Uploaded/UploadFailed) fire from GetDiagnostics
   * progression.
   */
  public sendDiagnosticsStatusNotification(
    status: "Idle" | "Uploaded" | "UploadFailed" | "Uploading",
  ): void {
    const messageId = this.generateMessageId();
    const payload: DiagnosticsStatusNotificationRequestV16 = { status };
    this.sendRequest(
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
    status:
      | "Downloaded"
      | "DownloadFailed"
      | "Downloading"
      | "Idle"
      | "InstallationFailed"
      | "Installing"
      | "Installed",
  ): void {
    const messageId = this.generateMessageId();
    const payload: FirmwareStatusNotificationRequestV16 = { status };
    this.sendRequest(OCPPAction.FirmwareStatusNotification, messageId, payload);
  }

  /**
   * §4.7 MeterValues.req. The measurand list is driven by the
   * `MeterValuesSampledData` Configuration key (defaults to
   * `Energy.Active.Import.Register`). Synthesized values are produced by
   * `MeterValueBuilder` so CSMS sees Voltage / Current / Power / SoC etc.
   * alongside the energy register.
   */
  public sendMeterValue(
    transactionId: number | undefined,
    connectorId: number,
    context: ReadingContext = "Sample.Periodic",
  ): void {
    const messageId = this.generateMessageId();
    const connector = this._chargePoint.getConnector(connectorId);
    if (!connector) {
      this._logger.warn(
        `sendMeterValue: connector ${connectorId} not found`,
        LogType.METER_VALUE,
      );
      return;
    }

    const measurands = this._chargePoint.configuration.meterValuesSampledData();
    const sampledValue = buildSampledValues(connector, measurands, context);

    const payload: MeterValuesRequestV16 = {
      transactionId,
      connectorId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          // The builder produces a structurally-compatible SampledValue
          // shape, but its `unit` is a plain `string` whereas ts-ocpp's
          // generated type is a strict union. Cast at this boundary
          // rather than mirror the entire enum.
          sampledValue:
            sampledValue as unknown as MeterValuesRequestV16["meterValue"][0]["sampledValue"],
        },
      ],
    };
    this.sendRequest(OCPPAction.MeterValues, messageId, payload);
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
    this.sendRequest(OCPPAction.StatusNotification, messageId, payload);
  }

  private sendRequest(
    action: OCPPAction,
    id: string,
    payload: OcppMessageRequestPayload,
    connectorId?: number,
  ): void {
    if (!this.isCallAllowed(action)) {
      this._logger.warn(
        `Suppressing ${action}: blocked by boot gate (status=${this._bootStatus.status})`,
        LogType.OCPP,
      );
      return;
    }
    const warning = this._codec.outgoingWarning(action, payload);
    if (warning) {
      this._logger.warn(warning, LogType.OCPP);
    }
    // §4.1.1: queue here, pumpSerialQueue does the actual `ws.sendAction`
    // one CALL at a time. The previous CALL's CALLRESULT/CALLERROR (or
    // timeout) releases the slot via `settleSerialInFlight`.
    this._serialQueue.push({ action, id, payload, connectorId });
    this.pumpSerialQueue();
  }

  /**
   * Drain one CALL off `_serialQueue` and put it in flight. No-op when
   * another CALL is already in flight; the eventual CALLRESULT/CALLERROR/
   * timeout will pump us again.
   */
  private pumpSerialQueue(): void {
    if (this._serialInFlight) return;
    while (this._serialQueue.length > 0) {
      const head = this._serialQueue[0];
      if (!this.isCallAllowed(head.action)) {
        // Boot gate currently blocks this action — leave it at the front
        // of the queue. `setBootStatus` re-pumps us when the gate opens.
        return;
      }
      this._serialQueue.shift();

      this._requests.add({
        type: OCPPMessageType.CALL,
        action: head.action,
        id: head.id,
        payload: head.payload,
        connectorId: head.connectorId,
      });
      const sent = this._webSocket.sendAction(
        head.id,
        head.action,
        head.payload,
      );
      if (!sent) {
        // WebSocket isn't open: transaction-related messages get retried
        // via PendingMessageQueue on reconnect; others (Heartbeat /
        // StatusNotification / DataTransfer / …) are informational and
        // safe to drop. Loop to try the next entry — no point holding the
        // queue if WS is gone, the next iteration will fail too and
        // either retry or drop.
        if (isTransactionRelated(head.action)) {
          this._pendingQueue.enqueue({
            action: head.action,
            payload: head.payload,
            connectorId: head.connectorId,
          });
          this._logger.warn(
            `WS send failed; queued ${head.action} (PendingQueue size=${this._pendingQueue.size()})`,
            LogType.OCPP,
          );
        } else {
          this._logger.warn(
            `WS send failed; dropping ${head.action} (informational)`,
            LogType.OCPP,
          );
        }
        continue;
      }

      // §4.6: any outgoing CALL resets the heartbeat idle timer. Stamp
      // lastSentAt only when the CALL is itself a Heartbeat — that way
      // BootNotification/StatusNotification/etc. count as activity but
      // don't pretend to be heartbeats in the UI.
      this._chargePoint.notifyOutgoingCall(
        head.action === OCPPAction.Heartbeat,
      );

      const timer = setTimeout(
        () => this.handleSerialTimeout(head.id),
        OCPPMessageHandler.SERIAL_CALL_TIMEOUT_MS,
      );
      this._serialInFlight = { action: head.action, id: head.id, timer };
      return;
    }
  }

  /** Release the serialization slot when a response settles the in-flight
   *  CALL. The caller is responsible for invoking this from
   *  handleCallResult / handleCallError. */
  private settleSerialInFlight(messageId: string): void {
    const cur = this._serialInFlight;
    if (!cur || cur.id !== messageId) return;
    clearTimeout(cur.timer);
    this._serialInFlight = null;
    this.pumpSerialQueue();
  }

  /** Per-CALL watchdog. §4.1.1 says implementations choose the timeout;
   *  on expiry we proceed to the next CALL so a stuck CSMS doesn't deadlock
   *  the queue forever. The dead CALL is dropped (transaction-related
   *  ones are also tracked via the persistent PendingMessageQueue). */
  private handleSerialTimeout(messageId: string): void {
    const cur = this._serialInFlight;
    if (!cur || cur.id !== messageId) return;
    this._logger.warn(
      `CALL ${messageId} (${cur.action}) timed out after ${OCPPMessageHandler.SERIAL_CALL_TIMEOUT_MS}ms — releasing serialization slot`,
      LogType.OCPP,
    );
    this._serialInFlight = null;
    this.pumpSerialQueue();
  }

  /** Called by the ChargePoint after the WebSocket has closed. Cancels the
   *  in-flight timer and discards anything still queued — those CALLs would
   *  reference a dead connection. Transaction-related messages survive via
   *  PendingMessageQueue (already persisted on send-fail). */
  public onWebSocketClosed(): void {
    if (this._serialInFlight) {
      clearTimeout(this._serialInFlight.timer);
      this._serialInFlight = null;
    }
    this._serialQueue = [];
  }

  /**
   * Re-attempt delivery of every queued transaction-related message.
   * Called from `ChargePoint.connect`'s onopen handler after a successful
   * BootNotification round-trip. Respects `TransactionMessageAttempts`
   * from Configuration; messages exceeding that count are dropped.
   */
  public flushPendingQueue(): void {
    if (this._pendingQueue.size() === 0) return;
    const maxAttempts =
      this._chargePoint.configuration.transactionMessageAttempts();
    // Route flushed messages through `sendRequest` so they take the same
    // §4.1.1 serialization path as fresh CALLs. The PendingMessageQueue's
    // `flush` callback returns true for every entry (we're handing
    // delivery to the serializer); it'll re-enqueue on actual send
    // failure via the path in `pumpSerialQueue` below.
    const delivered = this._pendingQueue.flush((message) => {
      const messageId = this.generateMessageId();
      this.sendRequest(
        message.action,
        messageId,
        message.payload as OcppMessageRequestPayload,
        message.connectorId,
      );
      return true;
    }, maxAttempts);
    if (delivered > 0) {
      this._logger.info(
        `Flushed ${delivered} queued transaction message(s)`,
        LogType.OCPP,
      );
    }
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
        this.handleCall(messageId, action, payload as OcppMessagePayloadCall);
        break;
      case OCPPMessageType.CALLRESULT:
        this.handleCallResult(
          messageId,
          payload as OcppMessagePayloadCallResult,
        );
        break;
      case OCPPMessageType.CALLERROR:
        this.handleCallError(messageId, payload as OcppMessageErrorPayload);
        break;
      default:
        this._logger.error(
          `Unknown message type: ${messageType}`,
          LogType.OCPP,
        );
    }
  }

  private handleCall(
    messageId: string,
    action: OCPPAction,
    payload: OcppMessagePayloadCall,
  ): void {
    // Use registry to get handler
    const handler = this._registry.getCallHandler(action);

    if (!handler) {
      this._logger.error(`Unsupported action: ${action}`, LogType.OCPP);
      this.sendCallError(
        messageId,
        "NotImplemented",
        "This action is not supported",
      );
      return;
    }

    try {
      const context: HandlerContext = {
        chargePoint: this._chargePoint,
        logger: this._logger,
      };
      const response = handler.handle(payload, context);
      this.sendCallResult(messageId, response);
    } catch (error) {
      this._logger.error(`Error handling ${action}: ${error}`, LogType.OCPP);
      this.sendCallError(messageId, "InternalError", String(error));
    }
  }

  private handleCallResult(
    messageId: string,
    payload: OcppMessagePayloadCallResult,
  ): void {
    const request = this._requests.get(messageId);
    if (!request) {
      this._logger.warn(
        `Received unexpected CallResult: ${messageId}`,
        LogType.OCPP,
      );
      return;
    }

    const action = request.action;
    let handler = this._registry.getCallResultHandler(action);

    // For transaction-related handlers that need connector info, create them dynamically
    if (!handler) {
      if (action === OCPPAction.StartTransaction) {
        handler = new StartTransactionResultHandler(request.connectorId || 1);
      } else if (action === OCPPAction.StopTransaction) {
        handler = new StopTransactionResultHandler(request.connectorId || 1);
      } else if (action === OCPPAction.MeterValues) {
        handler = new MeterValuesResultHandler(
          request.payload as MeterValuesRequestV16,
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

    this._requests.remove(messageId);
    // §4.1.1: response received — release the serialization slot so the
    // next queued CALL can go out.
    this.settleSerialInFlight(messageId);
  }

  private handleCallError(
    messageId: string,
    error: OcppMessageErrorPayload,
  ): void {
    const request = this._requests.get(messageId);
    this._logger.error(
      `Received CALLERROR for message ${messageId} (action=${request?.action ?? "unknown"}): ${JSON.stringify(error)}`,
      LogType.OCPP,
    );

    // Recover connector state when StartTransaction fails
    if (request?.action === OCPPAction.StartTransaction) {
      const connectorId = request.connectorId ?? 1;
      this._logger.info(
        `Recovering connector ${connectorId} after StartTransaction CALLERROR`,
        LogType.TRANSACTION,
      );
      this._chargePoint.cleanTransaction(connectorId);
      this._chargePoint.updateConnectorStatus(
        connectorId,
        OCPPStatus.Available,
      );
    }

    this._requests.remove(messageId);
    // §4.1.1: CALLERROR also settles the in-flight CALL.
    this.settleSerialInFlight(messageId);
  }

  // All handler methods have been moved to individual handler classes
  // See src/cp/handlers/ directory

  private sendCallResult(
    messageId: string,
    payload: OcppMessageResponsePayload,
  ): void {
    this._webSocket.sendResult(messageId, payload);
  }

  private sendCallError(
    messageId: string,
    errorCode: OCPPErrorCode,
    errorDescription: string,
  ): void {
    const errorDetails = {
      errorCode: errorCode,
      errorDescription: errorDescription,
    };
    this._webSocket.sendError(messageId, errorDetails);
  }

  private generateMessageId(): string {
    return crypto.randomUUID();
  }
}
