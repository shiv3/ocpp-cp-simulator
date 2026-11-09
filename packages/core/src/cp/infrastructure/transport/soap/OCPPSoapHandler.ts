import {
  DATA_TRANSFER_RESPONSE_TIMEOUT_MS,
  type DataTransferData,
  type DataTransferResult,
} from "../../../domain/types/DataTransfer";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "../../../domain/types/FirmwareLogStatus";
import type {
  AuthorizeRequestV16,
  AuthorizeResponseV16,
  BootNotificationResponseV16,
  DataTransferRequestV16,
  DiagnosticsStatusNotificationRequestV16,
  HeartbeatRequestV16,
  HeartbeatResponseV16,
  MeterValuesResponseV16,
  StartTransactionResponseV16,
  StatusNotificationResponseV16,
  StopTransactionResponseV16,
} from "@ocpp-cp-simulator/ocpp/index";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  type OcppCallOutcome,
  type OcppCallRequest,
} from "../../../domain/types/OcppCall";
import { OcppCallRejectedError } from "../../../domain/errors/OcppCallErrors";
import type {
  MeterSampleOverrides,
  ReadingContext,
} from "../../../domain/connector/MeterValueBuilder";
import { buildSampledValues } from "../../../domain/connector/MeterValueBuilder";
import type {
  Transaction,
  TransactionUpdateOptions,
} from "../../../domain/connector/Transaction";
import { isRunningTransactionStartedBy } from "../../../domain/connector/Transaction";
import type { TransactionLifecycleEvent } from "../../../domain/transport/TransactionLifecycleEvent";
import type { MonitoringEvent } from "../../../domain/monitoring/MonitorEvaluation";
import type {
  BootNotification,
  ChargePointErrorCode,
} from "../../../domain/types/OcppTypes";
// OCPPStatus is a string enum: it must be a VALUE import so switch cases can
// use enum members — string-literal cases do not narrow an enum-typed value.
import { type OCPPAction, OCPPStatus } from "../../../domain/types/OcppTypes";
import {
  BootGate,
  type BootGateStatus,
} from "../../../application/state/machines/BootGate";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type { IChargePointMessageHandler } from "../../../domain/transport/IChargePointMessageHandler";
import { DataTransferHandler } from "../handlers";
import {
  AuthorizeResultHandler,
  BootNotificationResultHandler,
  HeartbeatResultHandler,
  MeterValuesResultHandler,
  StartTransactionResultHandler,
  StatusNotificationResultHandler,
  StopTransactionResultHandler,
} from "../handlers";
import {
  buildSoapEnvelope,
  parseSoapFaultEnvelope,
  parseSoapEnvelope,
  SoapFaultError,
  soapContentTypeForOperation,
  WSA_ANONYMOUS_ADDRESS,
  type ParsedSoapEnvelope,
  type SoapOperation,
  type SoapParsedPayload,
  type SoapPayload,
} from "./soapEnvelope";
import type { SoapDialect } from "./dialect";
import { OCPP15_DIALECT } from "./dialect";
import { OCPP_1_2, OCPP_1_6_SOAP } from "../../../domain/types/OcppVersion";
import {
  idTagInfoFromPayload,
  numericValue,
  recordValue,
  soapPayload,
  textValue,
} from "./soapConverters";
import {
  OCPP12_WIRE_PROFILE,
  OCPP15_WIRE_PROFILE,
  OCPP16_WIRE_PROFILE,
  type ClientWireProfile,
} from "./soapWireProfiles";
import type {
  Ocpp15StopTransactionRequest,
  Ocpp16StopTransactionRequest,
} from "./soapWireTypes";
import {
  OPERATION_ACTION,
  SoapHttpStatusError,
  SoapRequestQueue,
} from "./soapRequestQueue";

export interface OCPPSoapHandlerOptions {
  readonly centralSystemUrl: string;
  readonly soapCallbackUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly dialect?: SoapDialect;
}

export const DEFAULT_SOAP_REQUEST_TIMEOUT_MS = 30_000;

// Raw HTTP response bodies (e.g. an HTML error page from a misbehaving
// proxy/CSMS) are embedded in error messages/log lines for diagnosis (#178
// B-i) — truncate them to a sane length so a large body doesn't blow up logs.
const RAW_RESPONSE_LOG_LIMIT = 240;

function truncateForLog(text: string): string {
  return text.length > RAW_RESPONSE_LOG_LIMIT
    ? `${text.slice(0, RAW_RESPONSE_LOG_LIMIT)}…`
    : text;
}

export class OCPPSoapHandler implements IChargePointMessageHandler {
  private readonly _dataTransferHandler = new DataTransferHandler();
  private readonly _bootGate: BootGate;
  private readonly _dialect: SoapDialect;
  private readonly _wireProfile: ClientWireProfile;
  private readonly _requests: SoapRequestQueue;

  constructor(
    private readonly _chargePoint: ChargePoint,
    private readonly _logger: Logger,
    private readonly _options: OCPPSoapHandlerOptions,
  ) {
    this._bootGate = new BootGate(this._chargePoint.clock);
    this._dialect = this._options.dialect ?? OCPP15_DIALECT;
    this._wireProfile = this.selectWireProfile(this._dialect.version);
    this._requests = new SoapRequestQueue({
      chargePoint: this._chargePoint,
      logger: this._logger,
      dialect: this._dialect,
      bootGate: this._bootGate,
      postSoap: (operation, payload) => this.postSoap(operation, payload),
    });
  }

  private selectWireProfile(version: string): ClientWireProfile {
    if (version === OCPP_1_2) {
      return OCPP12_WIRE_PROFILE;
    }
    if (version === OCPP_1_6_SOAP) {
      return OCPP16_WIRE_PROFILE;
    }
    // Default to 1.5 for any SOAP version we haven't explicitly specialized.
    return OCPP15_WIRE_PROFILE;
  }

  public sendBootNotification(bootPayload: BootNotification): void {
    this._requests.enqueueRequest(
      "BootNotification",
      soapPayload(bootPayload),
      (env) => this.handleBootNotificationResponse(env.payload),
    );
  }

  public sendHeartbeat(): void {
    const payload: HeartbeatRequestV16 = {};
    this._requests.enqueueRequest("Heartbeat", soapPayload(payload), (env) => {
      new HeartbeatResultHandler().handle(
        this.heartbeatResponseFromPayload(env.payload),
        this.handlerContext(),
      );
    });
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
    // The SOAP body emits elements in object-key order, so the keys MUST follow
    // the version's statusNotificationRequest XSD sequence. For OCPP 1.5:
    // connectorId, status, errorCode, info, timestamp, vendorId, vendorErrorCode.
    // For OCPP 1.2: connectorId, status, errorCode (no info/timestamp/vendor fields).
    // SteVe's JAXB binding is sequence-sensitive.
    const payload = this._wireProfile.toStatusNotificationRequest(
      connectorId,
      status,
      opts,
    );
    this._requests.enqueueRequest("StatusNotification", payload, (env) => {
      new StatusNotificationResultHandler().handle(
        env.payload as StatusNotificationResponseV16,
        this.handlerContext(),
      );
    });
  }

  public authorize(tagId: string): void {
    const payload: AuthorizeRequestV16 = { idTag: tagId };
    this._requests.enqueueRequest("Authorize", soapPayload(payload), (env) => {
      new AuthorizeResultHandler(payload).handle(
        this.authorizeResponseFromPayload(env.payload),
        this.handlerContext(),
      );
    });
  }

  public sendTransactionEvent(event: TransactionLifecycleEvent): void {
    if (event.phase === "started") {
      this.sendStartTransaction(event.transaction, event.connectorId);
    } else {
      this.sendStopTransaction(event.transaction, event.connectorId);
    }
  }

  public sendTransactionUpdate(
    connectorId: number,
    options: TransactionUpdateOptions,
  ): void {
    // Every SOAP dialect is OCPP 1.x: there is no TransactionEvent, so refuse
    // it the way the 1.6 WebSocket handler does rather than throw (#374).
    this._logger.warn(
      `[${this._dialect.version}] transaction_event (${options.triggerReason}) on connector ${connectorId} ignored: TransactionEvent is an OCPP 2.x message`,
      LogType.TRANSACTION,
    );
  }

  public sendMeterValue(
    transactionId: number | undefined,
    connectorId: number,
    context: ReadingContext = "Sample.Periodic",
    overrides: MeterSampleOverrides = {},
  ): void {
    // Connector 0 is the station main meter, when the station has one (#617).
    const mainMeter =
      connectorId === 0 ? this._chargePoint.mainMeter : undefined;
    const connector = mainMeter
      ? undefined
      : this._chargePoint.getConnector(connectorId);
    if (!connector && !mainMeter) {
      this._logger.warn(
        `sendMeterValue: connector ${connectorId} not found`,
        LogType.METER_VALUE,
      );
      return;
    }

    const measurands =
      overrides.measurands ??
      this._chargePoint.configuration.meterValuesSampledData();
    const sampledValue = mainMeter
      ? mainMeter.sampledValues(measurands, context)
      : buildSampledValues(connector!, measurands, context);
    if (mainMeter && sampledValue.length === 0) return;
    // The sender is the tick owner: announce a schedule crossing after the
    // read, so this sample describes the state before the status flip (#327).
    connector?.announceScheduleCrossingNow();
    const payload = this._wireProfile.toMeterValuesRequest(
      connectorId,
      transactionId,
      sampledValue,
      overrides.timestamp ?? new Date(),
    );
    if (!payload) {
      // The dialect defines none of the configured measurands, so the request
      // would carry no samples — and an empty MeterValues.req is rejected
      // outright, which is worse than not sending one. Warned rather than
      // silent: from the CSMS side "no MeterValues at all" and "MeterValues
      // the CP could not express" look identical, so the operator needs the
      // reason here (#301).
      this._logger.warn(
        `MeterValues not sent for connector ${connectorId}: ${this._dialect.version} supports none of the configured measurands (${measurands.join(", ")})`,
        LogType.METER_VALUE,
      );
      return;
    }
    this._requests.enqueueRequest(
      "MeterValues",
      payload,
      (env) => {
        new MeterValuesResultHandler(connectorId).handle(
          env.payload as MeterValuesResponseV16,
          this.handlerContext(),
        );
      },
      transactionId === undefined
        ? undefined
        : {
            action: "MeterValues",
            connectorId,
            transactionId: String(transactionId),
          },
    );
  }

  /** SOAP envelopes are built per operation: there is no arbitrary-action
   *  path (#389). `ChargePoint.sendOcppCall` refuses first; this is the
   *  handler's own answer. */
  public async sendOcppCall(
    _request: OcppCallRequest,
  ): Promise<OcppCallOutcome> {
    throw new OcppCallRejectedError(
      "unsupported_transport",
      "Expert OCPP calls are not available over SOAP",
    );
  }

  public sendDataTransfer(
    vendorId: string,
    messageId?: string,
    data?: DataTransferData,
  ): Promise<DataTransferResult> {
    // SOAP 1.6: `data` is a string; a non-string is JSON-encoded (#348).
    const wireData =
      data === undefined
        ? undefined
        : typeof data === "string"
          ? data
          : JSON.stringify(data);
    const payload: DataTransferRequestV16 = {
      vendorId,
      ...(messageId ? { messageId } : {}),
      ...(wireData !== undefined ? { data: wireData } : {}),
    };
    if (this._dialect.version === OCPP_1_2) {
      const message = `OCPP 1.2 has no DataTransfer operation; ignoring: ${JSON.stringify(payload)}`;
      this._logger.warn(message, LogType.OCPP);
      return Promise.reject(new Error(message));
    }
    if (this._dialect.version !== OCPP_1_6_SOAP) {
      const message = `${this._dialect.version} SOAP does not support DataTransfer: ${JSON.stringify(payload)}`;
      this._logger.warn(message, LogType.OCPP);
      return Promise.reject(new Error(message));
    }
    const action = OPERATION_ACTION.DataTransfer;
    if (action && !this.isCallAllowed(action)) {
      // enqueueRequest would suppress it with a warning and no callback.
      return Promise.reject(
        new Error(
          "DataTransfer blocked by the boot gate — BootNotification not yet Accepted",
        ),
      );
    }
    return new Promise<DataTransferResult>((resolve, reject) => {
      // A failed POST is logged by the request chain and never reaches the
      // response callback, so the caller's wait is bounded here.
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `DataTransfer: no answer within ${DATA_TRANSFER_RESPONSE_TIMEOUT_MS}ms`,
            ),
          ),
        DATA_TRANSFER_RESPONSE_TIMEOUT_MS,
      );
      this._requests.enqueueRequest(
        "DataTransfer",
        soapPayload(payload),
        (env) => {
          clearTimeout(timer);
          this._logger.info(
            `DataTransfer response: ${JSON.stringify(env.payload)}`,
            LogType.OCPP,
          );
          const answer = env.payload as {
            status?: DataTransferResult["status"];
            data?: unknown;
          };
          resolve({
            status: answer.status ?? "Rejected",
            ...(answer.data !== undefined ? { data: answer.data } : {}),
          });
        },
      );
    });
  }

  public sendDiagnosticsStatusNotification(status: DiagnosticsStatus): void {
    const payload: DiagnosticsStatusNotificationRequestV16 = { status };
    if (this._dialect.version === OCPP_1_6_SOAP) {
      // For 1.6S, actually send the DiagnosticsStatusNotification request
      this._requests.enqueueRequest(
        "DiagnosticsStatusNotification",
        soapPayload(payload),
        (env) => {
          this._logger.info(
            `DiagnosticsStatusNotification response: ${JSON.stringify(env.payload)}`,
            LogType.OCPP,
          );
        },
      );
    } else {
      this._logger.warn(
        `${this._dialect.version} SOAP DiagnosticsStatusNotification is not implemented in this client slice: ${JSON.stringify(payload)}`,
        LogType.OCPP,
      );
    }
  }

  public sendFirmwareStatusNotification(
    status: FirmwareStatus,
    _requestId?: number,
  ): void {
    // SOAP 1.x FirmwareStatusNotification carries no requestId, and a
    // 2.0.1-only status is sent as given, as on the 1.6 WebSocket wire.
    const payload = { status };
    if (this._dialect.version === OCPP_1_6_SOAP) {
      // For 1.6S, actually send the FirmwareStatusNotification request
      this._requests.enqueueRequest(
        "FirmwareStatusNotification",
        soapPayload(payload),
        (env) => {
          this._logger.info(
            `FirmwareStatusNotification response: ${JSON.stringify(env.payload)}`,
            LogType.OCPP,
          );
        },
      );
    } else {
      this._logger.warn(
        `${this._dialect.version} SOAP FirmwareStatusNotification is not implemented in this client slice: ${JSON.stringify(payload)}`,
        LogType.OCPP,
      );
    }
  }

  public sendSecurityEventNotification(
    type: string,
    techInfo?: string,
  ): Promise<void> {
    this._logger.warn(
      `${this._dialect.version} SOAP has no security extension; ignoring SecurityEventNotification ${JSON.stringify({ type, techInfo })}`,
      LogType.OCPP,
    );
    return Promise.resolve();
  }

  public sendLogStatusNotification(
    status: UploadLogStatus,
    requestId?: number,
  ): void {
    this._logger.warn(
      `${this._dialect.version} SOAP has no security extension; ignoring LogStatusNotification ${JSON.stringify({ status, requestId })}`,
      LogType.OCPP,
    );
  }

  public sendSignedFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    this._logger.warn(
      `${this._dialect.version} SOAP has no security extension; ignoring SignedFirmwareStatusNotification ${JSON.stringify({ status, requestId })}`,
      LogType.OCPP,
    );
  }

  /** NotifyEvent is OCPP 2.x only (#457); SOAP stations never send it. */
  public sendNotifyEvent(_events: readonly MonitoringEvent[]): void {
    this._logger.debug(
      `${this._dialect.version} SOAP has no NotifyEvent; ignoring it`,
      LogType.OCPP,
    );
  }

  /** Same as above: nothing to queue on SOAP (#538). */
  public queueNotifyEvent(events: readonly MonitoringEvent[]): void {
    this.sendNotifyEvent(events);
  }

  public highestQueuedNotifyEventId(): number {
    return 0;
  }

  public sendSignCertificate(_csr?: string): Promise<void> {
    this._logger.warn(
      `${this._dialect.version} SOAP has no security extension; ignoring SignCertificate`,
      LogType.OCPP,
    );
    return Promise.resolve();
  }

  public setBootStatus(status: BootGateStatus): void {
    this._bootGate.set(status);
  }

  public getDataTransferHandler(): DataTransferHandler {
    return this._dataTransferHandler;
  }

  public onWebSocketClosed(): void {
    this._requests.onConnectionClosed();
  }

  public flushPendingQueue(): void {
    // SOAP B2a has no persistent reconnect queue; every call is a bounded
    // HTTP request/response exchange.
  }

  private sendStartTransaction(
    transaction: Transaction,
    connectorId: number,
  ): void {
    const payload = this._wireProfile.toStartTransactionRequest(
      transaction,
      connectorId,
    );
    const startedBy = {
      idTag: transaction.tagId,
      timestamp: transaction.startTime.toISOString(),
    };
    const startedTransaction = (): Transaction | null => {
      const current = this._chargePoint.getConnector(connectorId)?.transaction;
      return isRunningTransactionStartedBy(current, startedBy) ? current : null;
    };
    this._requests.enqueueRequest(
      "StartTransaction",
      payload,
      (env) => {
        new StartTransactionResultHandler(
          connectorId,
          transaction.tagId,
          transaction.startTime.toISOString(),
        ).handle(
          this.startTransactionResponseFromPayload(env.payload),
          this.handlerContext(),
        );
      },
      {
        action: "StartTransaction",
        connectorId,
        transactionId: "0",
        startedTransaction,
        proceedWithoutConf: () => {
          const connector = this._chargePoint.getConnector(connectorId);
          if (
            connector?.status === OCPPStatus.Preparing &&
            isRunningTransactionStartedBy(connector.transaction, startedBy)
          ) {
            this._chargePoint.updateConnectorStatus(
              connectorId,
              OCPPStatus.Charging,
            );
          }
        },
      },
    );
  }

  private sendStopTransaction(
    transaction: Transaction,
    connectorId: number,
  ): void {
    if (transaction.id === null || transaction.id === undefined) {
      this._logger.warn(
        `StopTransaction skipped: transaction id is missing for connector ${connectorId}`,
        LogType.TRANSACTION,
      );
      return;
    }
    if (transaction.meterStop === null || transaction.meterStop === undefined) {
      this._logger.warn(
        `StopTransaction skipped: meterStop is missing for connector ${connectorId}`,
        LogType.TRANSACTION,
      );
      return;
    }
    if (!transaction.stopTime) {
      this._logger.warn(
        `StopTransaction skipped: stopTime is missing for connector ${connectorId}`,
        LogType.TRANSACTION,
      );
      return;
    }

    const payload: Ocpp15StopTransactionRequest | Ocpp16StopTransactionRequest =
      this._dialect.version === OCPP_1_6_SOAP
        ? {
            transactionId: transaction.id,
            idTag: transaction.tagId,
            timestamp: transaction.stopTime.toISOString(),
            meterStop: transaction.meterStop,
            ...(transaction.stopReason
              ? { reason: transaction.stopReason }
              : {}),
          }
        : {
            transactionId: transaction.id,
            idTag: transaction.tagId,
            timestamp: transaction.stopTime.toISOString(),
            meterStop: transaction.meterStop,
          };
    this._requests.enqueueRequest(
      "StopTransaction",
      soapPayload(payload),
      (env) => {
        new StopTransactionResultHandler(connectorId, payload.idTag).handle(
          this.stopTransactionResponseFromPayload(env.payload),
          this.handlerContext(),
        );
      },
      {
        action: "StopTransaction",
        connectorId,
        transactionId: String(transaction.id),
      },
    );
  }

  private async postSoap(
    operation: SoapOperation,
    payload: SoapPayload,
  ): Promise<ParsedSoapEnvelope> {
    const messageId = this.generateMessageId();
    const xml = buildSoapEnvelope({
      operation,
      chargeBoxIdentity: this._chargePoint.id,
      messageId,
      from: this._options.soapCallbackUrl ?? WSA_ANONYMOUS_ADDRESS,
      to: this._options.centralSystemUrl,
      payload,
      dialect: this._dialect,
    });
    const contentType = soapContentTypeForOperation(
      operation,
      "request",
      this._dialect,
    );

    this._logger.info(`SOAP POST ${operation}: ${xml}`, LogType.OCPP);
    this._chargePoint.notifyOutgoingCall(operation === "Heartbeat");

    const timeoutMs =
      this._options.requestTimeoutMs ?? DEFAULT_SOAP_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let responseText: string;
    try {
      response = await fetch(this._options.centralSystemUrl, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
        },
        body: xml,
        signal: controller.signal,
      });
      responseText = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`SOAP ${operation} timed out after ${timeoutMs}ms`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const fault = this.parseFaultResponse(responseText, response.status);
    if (fault) {
      // A Fault is the CSMS's answer, and the JSON transport counts its
      // CALLERROR equivalent. Logged before the throw so the log-derived
      // observers (`--trace-output`, `/metrics`) see the exchange complete
      // rather than a request with no reply.
      this._logger.info(
        `SOAP response ${operation}: ${responseText}`,
        LogType.OCPP,
      );
      throw fault;
    }

    if (!response.ok) {
      this._logger.info(
        `SOAP response ${operation}: ${responseText}`,
        LogType.OCPP,
      );
      throw new SoapHttpStatusError(
        response.status,
        `HTTP ${response.status} ${response.statusText}: ${truncateForLog(responseText)}`,
      );
    }
    this._logger.info(
      `SOAP response ${operation}: ${responseText}`,
      LogType.OCPP,
    );

    const envelope = parseSoapEnvelope(responseText, this._dialect);
    if (envelope.kind !== "response") {
      throw new Error(`SOAP ${operation} expected a response envelope`);
    }
    if (envelope.operation !== operation) {
      throw new Error(
        `SOAP ${operation} received ${envelope.operation} response`,
      );
    }
    if (envelope.relatesTo !== messageId) {
      throw new Error(`SOAP ${operation} response RelatesTo mismatch`);
    }
    if (
      envelope.chargeBoxIdentity !== undefined &&
      envelope.chargeBoxIdentity !== this._chargePoint.id
    ) {
      throw new Error(
        `SOAP ${operation} response chargeBoxIdentity mismatch: ${envelope.chargeBoxIdentity}`,
      );
    }
    return envelope;
  }

  private parseFaultResponse(
    responseText: string,
    status: number,
  ): SoapFaultError | null {
    try {
      const fault = parseSoapFaultEnvelope(responseText);
      return fault ? new SoapFaultError(fault, status) : null;
    } catch (error) {
      if (status >= 200 && status < 300) {
        // The response body itself failed to parse as SOAP (e.g. the
        // DOCTYPE/ENTITY XXE guard tripped on a non-SOAP HTML error page
        // from SteVe/a proxy). Previously the raw body was captured in a
        // local variable and then discarded here, leaving the failure
        // undiagnosable (#178 B-i). Fold the HTTP status, the parse error,
        // and a truncated copy of the raw response into the thrown error so
        // it reaches the caller's log line (`enqueueRequest`'s catch).
        const parseMessage =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `SOAP response parse failed (HTTP ${status}): ${parseMessage} — raw response: ${truncateForLog(responseText)}`,
          { cause: error },
        );
      }
      return null;
    }
  }

  private handleBootNotificationResponse(payload: SoapParsedPayload): void {
    const status = textValue(payload.status);
    const response: BootNotificationResponseV16 = {
      status:
        status === "Accepted" || status === "Pending" || status === "Rejected"
          ? status
          : "Rejected",
      currentTime: textValue(payload.currentTime) ?? new Date().toISOString(),
      // OCPP 1.2/1.5 name this field "heartbeatInterval"; 1.6 renamed it to
      // "interval" (verified live against SteVe 1.6S). Read whichever is present.
      interval:
        numericValue(payload.interval) ??
        numericValue(payload.heartbeatInterval) ??
        0,
    };
    new BootNotificationResultHandler().handle(response, this.handlerContext());
  }

  private heartbeatResponseFromPayload(
    payload: SoapParsedPayload,
  ): HeartbeatResponseV16 {
    return {
      currentTime: textValue(payload.currentTime) ?? new Date().toISOString(),
    };
  }

  private authorizeResponseFromPayload(
    payload: SoapParsedPayload,
  ): AuthorizeResponseV16 {
    return { idTagInfo: idTagInfoFromPayload(payload.idTagInfo) };
  }

  private startTransactionResponseFromPayload(
    payload: SoapParsedPayload,
  ): StartTransactionResponseV16 {
    return {
      transactionId: numericValue(payload.transactionId) ?? 0,
      idTagInfo: idTagInfoFromPayload(payload.idTagInfo),
    };
  }

  private stopTransactionResponseFromPayload(
    payload: SoapParsedPayload,
  ): StopTransactionResponseV16 {
    const idTagInfo = recordValue(payload.idTagInfo);
    return idTagInfo ? { idTagInfo: idTagInfoFromPayload(idTagInfo) } : {};
  }

  private handlerContext() {
    return {
      chargePoint: this._chargePoint,
      logger: this._logger,
    };
  }

  private isCallAllowed(action: OCPPAction): boolean {
    return this._bootGate.isCallAllowed(action);
  }

  private generateMessageId(): string {
    return `uuid:${crypto.randomUUID()}`;
  }
}
