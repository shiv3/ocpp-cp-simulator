import type {
  AuthorizeRequestV16,
  AuthorizeResponseV16,
  BootNotificationResponseV16,
  DataTransferRequestV16,
  DiagnosticsStatusNotificationRequestV16,
  FirmwareStatusNotificationRequestV16,
  HeartbeatRequestV16,
  HeartbeatResponseV16,
  MeterValuesRequestV16,
  MeterValuesResponseV16,
  StartTransactionRequestV16,
  StartTransactionResponseV16,
  StatusNotificationRequestV16,
  StatusNotificationResponseV16,
  StopTransactionRequestV16,
  StopTransactionResponseV16,
} from "../../../../ocpp";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ReadingContext } from "../../../domain/connector/MeterValueBuilder";
import { buildSampledValues } from "../../../domain/connector/MeterValueBuilder";
import type { Transaction } from "../../../domain/connector/Transaction";
import type { TransactionLifecycleEvent } from "../../../domain/transport/TransactionLifecycleEvent";
import type {
  BootNotification,
  ChargePointErrorCode,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import { OCPPAction } from "../../../domain/types/OcppTypes";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type { IChargePointMessageHandler } from "../IChargePointMessageHandler";
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
  type ParsedSoapEnvelope,
  type SoapOperation,
  type SoapParsedPayload,
  type SoapParsedValue,
  type SoapPayload,
} from "./soapEnvelope";

export interface OCPPSoapHandlerOptions {
  readonly centralSystemUrl: string;
  readonly soapCallbackUrl: string;
  readonly requestTimeoutMs?: number;
}

type BootStatus =
  | { status: "Idle" }
  | { status: "Accepted" }
  | { status: "Pending" }
  | { status: "Rejected"; retryAfter: Date };

type IdTagInfoStatus =
  | "Accepted"
  | "Blocked"
  | "Expired"
  | "Invalid"
  | "ConcurrentTx";

type IdTagInfo = {
  expiryDate?: string;
  parentIdTag?: string;
  status: IdTagInfoStatus;
};

type Ocpp15StopTransactionRequest = Omit<StopTransactionRequestV16, "reason">;

const OPERATION_ACTION: Record<SoapOperation, OCPPAction | null> = {
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
  GetConfiguration: OCPPAction.GetConfiguration,
  GetDiagnostics: OCPPAction.GetDiagnostics,
  GetLocalListVersion: OCPPAction.GetLocalListVersion,
  RemoteStartTransaction: OCPPAction.RemoteStartTransaction,
  RemoteStopTransaction: OCPPAction.RemoteStopTransaction,
  ReserveNow: OCPPAction.ReserveNow,
  Reset: OCPPAction.Reset,
  SendLocalList: OCPPAction.SendLocalList,
  UnlockConnector: OCPPAction.UnlockConnector,
  UpdateFirmware: OCPPAction.UpdateFirmware,
};

export const DEFAULT_SOAP_REQUEST_TIMEOUT_MS = 30_000;

function textValue(value: SoapParsedValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function numericValue(value: SoapParsedValue | undefined): number | undefined {
  const text = textValue(value);
  if (text === undefined || text.trim() === "") return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recordValue(
  value: SoapParsedValue | undefined,
): Record<string, SoapParsedValue> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return undefined;
}

function idTagInfoFromPayload(value: SoapParsedValue | undefined): IdTagInfo {
  const record = recordValue(value);
  const rawStatus = textValue(record?.status);
  const status: IdTagInfoStatus =
    rawStatus === "Accepted" ||
    rawStatus === "Blocked" ||
    rawStatus === "Expired" ||
    rawStatus === "Invalid" ||
    rawStatus === "ConcurrentTx"
      ? rawStatus
      : "Invalid";
  return {
    status,
    ...(textValue(record?.expiryDate)
      ? { expiryDate: textValue(record?.expiryDate) }
      : {}),
    ...(textValue(record?.parentIdTag)
      ? { parentIdTag: textValue(record?.parentIdTag) }
      : {}),
  };
}

function soapPayload(payload: object): SoapPayload {
  return payload as unknown as SoapPayload;
}

export class OCPPSoapHandler implements IChargePointMessageHandler {
  private readonly _dataTransferHandler = new DataTransferHandler();
  private _bootStatus: BootStatus = { status: "Idle" };
  private _requestChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly _chargePoint: ChargePoint,
    private readonly _logger: Logger,
    private readonly _options: OCPPSoapHandlerOptions,
  ) {}

  public sendBootNotification(bootPayload: BootNotification): void {
    this.enqueueRequest("BootNotification", soapPayload(bootPayload), (env) =>
      this.handleBootNotificationResponse(env.payload),
    );
  }

  public sendHeartbeat(): void {
    const payload: HeartbeatRequestV16 = {};
    this.enqueueRequest("Heartbeat", soapPayload(payload), (env) => {
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
    this.enqueueRequest("StatusNotification", soapPayload(payload), (env) => {
      new StatusNotificationResultHandler().handle(
        env.payload as StatusNotificationResponseV16,
        this.handlerContext(),
      );
    });
  }

  public authorize(tagId: string): void {
    const payload: AuthorizeRequestV16 = { idTag: tagId };
    this.enqueueRequest("Authorize", soapPayload(payload), (env) => {
      new AuthorizeResultHandler().handle(
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

  public sendMeterValue(
    transactionId: number | undefined,
    connectorId: number,
    context: ReadingContext = "Sample.Periodic",
  ): void {
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
          sampledValue:
            sampledValue as unknown as MeterValuesRequestV16["meterValue"][0]["sampledValue"],
        },
      ],
    };
    this.enqueueRequest("MeterValues", soapPayload(payload), (env) => {
      new MeterValuesResultHandler(payload).handle(
        env.payload as MeterValuesResponseV16,
        this.handlerContext(),
      );
    });
  }

  public sendDataTransfer(
    vendorId: string,
    messageId?: string,
    data?: string,
  ): void {
    const payload: DataTransferRequestV16 = {
      vendorId,
      ...(messageId ? { messageId } : {}),
      ...(data !== undefined ? { data } : {}),
    };
    this._logger.warn(
      `OCPP 1.5 SOAP DataTransfer is not implemented in this client slice: ${JSON.stringify(payload)}`,
      LogType.OCPP,
    );
  }

  public sendDiagnosticsStatusNotification(status: string): void {
    const payload: DiagnosticsStatusNotificationRequestV16 = {
      status: status as DiagnosticsStatusNotificationRequestV16["status"],
    };
    this._logger.warn(
      `OCPP 1.5 SOAP DiagnosticsStatusNotification is not implemented in this client slice: ${JSON.stringify(payload)}`,
      LogType.OCPP,
    );
  }

  public sendFirmwareStatusNotification(status: string): void {
    const payload: FirmwareStatusNotificationRequestV16 = {
      status: status as FirmwareStatusNotificationRequestV16["status"],
    };
    this._logger.warn(
      `OCPP 1.5 SOAP FirmwareStatusNotification is not implemented in this client slice: ${JSON.stringify(payload)}`,
      LogType.OCPP,
    );
  }

  public setBootStatus(status: BootStatus): void {
    this._bootStatus = status;
  }

  public getDataTransferHandler(): DataTransferHandler {
    return this._dataTransferHandler;
  }

  public onWebSocketClosed(): void {
    this._requestChain = Promise.resolve();
  }

  public flushPendingQueue(): void {
    // SOAP B2a has no persistent reconnect queue; every call is a bounded
    // HTTP request/response exchange.
  }

  private sendStartTransaction(
    transaction: Transaction,
    connectorId: number,
  ): void {
    const payload: StartTransactionRequestV16 = {
      connectorId,
      idTag: transaction.tagId,
      meterStart: transaction.meterStart,
      timestamp: transaction.startTime.toISOString(),
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
    };
    this.enqueueRequest("StartTransaction", soapPayload(payload), (env) => {
      new StartTransactionResultHandler(connectorId).handle(
        this.startTransactionResponseFromPayload(env.payload),
        this.handlerContext(),
      );
    });
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

    const payload: Ocpp15StopTransactionRequest = {
      transactionId: transaction.id,
      idTag: transaction.tagId,
      meterStop: transaction.meterStop,
      timestamp: transaction.stopTime.toISOString(),
    };
    this.enqueueRequest("StopTransaction", soapPayload(payload), (env) => {
      new StopTransactionResultHandler(connectorId).handle(
        this.stopTransactionResponseFromPayload(env.payload),
        this.handlerContext(),
      );
    });
  }

  private enqueueRequest(
    operation: SoapOperation,
    payload: SoapPayload,
    onResponse: (envelope: ParsedSoapEnvelope) => void,
  ): void {
    const action = OPERATION_ACTION[operation];
    if (action && !this.isCallAllowed(action)) {
      this._logger.warn(
        `Suppressing ${operation}: blocked by boot gate (status=${this._bootStatus.status})`,
        LogType.OCPP,
      );
      return;
    }

    const run = async () => {
      const response = await this.postSoap(operation, payload);
      onResponse(response);
    };
    this._requestChain = this._requestChain
      .catch(() => undefined)
      .then(run)
      .catch((error) => {
        this._logger.error(
          `SOAP ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
          LogType.OCPP,
        );
      });
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
      from: this._options.soapCallbackUrl,
      to: this._options.centralSystemUrl,
      payload,
    });
    const contentType = soapContentTypeForOperation(operation);

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
        throw new Error(`SOAP ${operation} timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const fault = this.parseFaultResponse(responseText, response.status);
    if (fault) throw fault;

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}: ${responseText.slice(0, 240)}`,
      );
    }
    this._logger.info(
      `SOAP response ${operation}: ${responseText}`,
      LogType.OCPP,
    );

    const envelope = parseSoapEnvelope(responseText);
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
      if (status >= 200 && status < 300) throw error;
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
      interval: numericValue(payload.heartbeatInterval) ?? 0,
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

  private generateMessageId(): string {
    return `uuid:${crypto.randomUUID()}`;
  }
}
