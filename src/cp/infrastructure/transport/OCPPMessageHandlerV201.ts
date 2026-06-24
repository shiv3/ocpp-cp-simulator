import type {
  BootNotificationRequestV201,
  HeartbeatRequestV201,
  HeartbeatResponseV201,
  BootNotificationResponseV201,
  StatusNotificationRequestV201,
  StatusNotificationResponseV201,
  TransactionEventRequestV201,
  TransactionEventResponseV201,
  MeterValuesRequestV201,
  MeterValuesResponseV201,
  AuthorizeRequestV201,
  AuthorizeResponseV201,
} from "@cshil/ocpp-tools";
import type { OCPPWebSocket } from "./OCPPWebSocket";
import { Logger, LogType } from "../../shared/Logger";
import {
  BootNotification,
  ChargePointErrorCode,
  type OCPPErrorCode,
  OCPPMessageType,
  OCPPStatus,
} from "../../domain/types/OcppTypes";
import type {
  StopTransactionReason,
  Transaction,
} from "../../domain/connector/Transaction";
import {
  buildSampledValues,
  type ReadingContext,
} from "../../domain/connector/MeterValueBuilder";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { IChargePointMessageHandler } from "./IChargePointMessageHandler";
import { DataTransferHandler } from "./handlers";
import {
  v201MeterEvseId,
  v201StatusEvse,
  v201TransactionEvse,
} from "./v201/topologyWireV201";

type V201Action =
  | "BootNotification"
  | "Heartbeat"
  | "StatusNotification"
  | "TransactionEvent"
  | "MeterValues"
  | "Authorize";

type V201RequestPayload =
  | BootNotificationRequestV201
  | HeartbeatRequestV201
  | StatusNotificationRequestV201
  | TransactionEventRequestV201
  | MeterValuesRequestV201
  | AuthorizeRequestV201;

type V201ResponsePayload =
  | BootNotificationResponseV201
  | HeartbeatResponseV201
  | StatusNotificationResponseV201
  | TransactionEventResponseV201
  | MeterValuesResponseV201
  | AuthorizeResponseV201;

type V201StoppedReason = NonNullable<
  TransactionEventRequestV201["transactionInfo"]["stoppedReason"]
>;
type V201MeterValuesSampledValue =
  MeterValuesRequestV201["meterValue"][number]["sampledValue"][number];

function toV201StoppedReason(
  reason: StopTransactionReason | undefined,
): V201StoppedReason {
  switch (reason) {
    case undefined:
      return "Local";
    case "DeAuthorized":
    case "EmergencyStop":
    case "EVDisconnected":
    case "Local":
    case "Other":
    case "PowerLoss":
    case "Reboot":
    case "Remote":
      return reason;
    case "HardReset":
      return "ImmediateReset";
    case "SoftReset":
      return "Reboot";
    case "UnlockCommand":
      return "Other";
    default:
      return "Other";
  }
}

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

export class OCPPMessageHandlerV201 implements IChargePointMessageHandler {
  private readonly _chargePoint: ChargePoint;
  private readonly _webSocket: OCPPWebSocket;
  private readonly _logger: Logger;
  private readonly _dataTransferHandler: DataTransferHandler =
    new DataTransferHandler();
  private _bootStatus:
    | { status: "Idle" }
    | { status: "Accepted" }
    | { status: "Pending" }
    | { status: "Rejected"; retryAfter: Date } = { status: "Idle" };
  // TODO: Persist v201 seqNo/transaction IDs across restarts in a later persistence phase.
  private _seqNo = 0;
  private readonly _transactionIds = new Map<number, string>();

  constructor(
    chargePoint: ChargePoint,
    webSocket: OCPPWebSocket,
    logger: Logger,
  ) {
    this._chargePoint = chargePoint;
    this._webSocket = webSocket;
    this._logger = logger;

    this._webSocket.setMessageHandler(this.handleIncomingMessage.bind(this));
  }

  private generateMessageId(): string {
    return crypto.randomUUID();
  }

  private nextSeqNo(): number {
    return this._seqNo++;
  }

  private getOrCreateTransactionId(numericId: number): string {
    let id = this._transactionIds.get(numericId);
    if (!id) {
      id = crypto.randomUUID();
      this._transactionIds.set(numericId, id);
    }
    return id;
  }

  private send(
    action: V201Action,
    messageId: string,
    payload: V201RequestPayload,
  ): void {
    if (!this._webSocket.isConnected()) {
      this._logger.warn(
        `[v2.0.1] Not connected, dropping ${action}`,
        LogType.WEBSOCKET,
      );
      return;
    }
    const sent = this._webSocket.sendAction(messageId, action, payload);
    if (sent) {
      this._chargePoint.notifyOutgoingCall(action === "Heartbeat");
    }
  }

  private handleIncomingMessage(
    messageType: OCPPMessageType,
    messageId: string,
    action: string,
    payload: unknown,
  ): void {
    if (messageType === OCPPMessageType.CALL) {
      this._logger.warn(
        `[v2.0.1] Unsupported CSMS action ${action}`,
        LogType.OCPP,
      );
      this._webSocket.sendError(messageId, {
        errorCode: "NotImplemented" as OCPPErrorCode,
        errorDescription: "This action is not supported",
        errorDetails: {},
      });
    } else if (messageType === OCPPMessageType.CALLRESULT) {
      this.handleCallResult(messageId, payload as V201ResponsePayload);
    } else if (messageType === OCPPMessageType.CALLERROR) {
      this._logger.warn(`[v2.0.1] CALLERROR for ${messageId}`, LogType.OCPP);
    }
  }

  private handleCallResult(
    _messageId: string,
    payload: V201ResponsePayload,
  ): void {
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
      if (bootResult.status === "Accepted") {
        this._chargePoint.onBootNotificationAccepted(
          bootResult.currentTime,
          bootResult.interval,
        );
      } else if (bootResult.status === "Pending") {
        this._chargePoint.onBootNotificationPending(bootResult.interval);
      } else {
        this._chargePoint.onBootNotificationRejected(bootResult.interval);
      }
    }
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
  }

  public authorize(tagId: string): void {
    const messageId = this.generateMessageId();
    const payload: AuthorizeRequestV201 = {
      idToken: { idToken: tagId, type: "ISO14443" },
    };
    this.send("Authorize", messageId, payload);
  }

  public startTransaction(transaction: Transaction, connectorId: number): void {
    const transactionId = this.getOrCreateTransactionId(connectorId);
    const messageId = this.generateMessageId();
    const payload: TransactionEventRequestV201 = {
      eventType: "Started",
      timestamp: transaction.startTime.toISOString(),
      triggerReason: "Authorized",
      seqNo: this.nextSeqNo(),
      transactionInfo: {
        transactionId,
        chargingState: "Charging",
      },
      idToken: { idToken: transaction.tagId, type: "ISO14443" },
      evse: v201TransactionEvse(connectorId),
      meterValue: [
        {
          timestamp: transaction.startTime.toISOString(),
          sampledValue: [
            {
              value: transaction.meterStart / 1000,
              measurand: "Energy.Active.Import.Register",
              unitOfMeasure: { unit: "kWh" },
            },
          ],
        },
      ],
    };
    this.send("TransactionEvent", messageId, payload);
  }

  public stopTransaction(transaction: Transaction, connectorId: number): void {
    const transactionId = this.getOrCreateTransactionId(connectorId);
    const messageId = this.generateMessageId();
    const timestamp = (transaction.stopTime ?? new Date()).toISOString();
    const payload: TransactionEventRequestV201 = {
      eventType: "Ended",
      timestamp,
      triggerReason: "StopAuthorized",
      seqNo: this.nextSeqNo(),
      transactionInfo: {
        transactionId,
        stoppedReason: toV201StoppedReason(transaction.stopReason),
      },
      evse: v201TransactionEvse(connectorId),
      meterValue:
        transaction.meterStop !== null
          ? [
              {
                timestamp,
                sampledValue: [
                  {
                    value: transaction.meterStop / 1000,
                    measurand: "Energy.Active.Import.Register",
                    unitOfMeasure: { unit: "kWh" },
                  },
                ],
              },
            ]
          : undefined,
    };
    this.send("TransactionEvent", messageId, payload);
    this._transactionIds.delete(connectorId);
  }

  public sendMeterValue(
    _transactionId: number | undefined,
    connectorId: number,
    context: ReadingContext = "Sample.Periodic",
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

    const measurands = this._chargePoint.configuration.meterValuesSampledData();
    const sampledValues = buildSampledValues(connector, measurands, context);
    if (sampledValues.length === 0) {
      this._logger.debug(
        `[v2.0.1] sendMeterValue: no sampled values for connector ${connectorId}`,
        LogType.METER_VALUE,
      );
      return;
    }

    const sampledValue = sampledValues.map((sv) => ({
      value: Number(sv.value),
      measurand: sv.measurand as V201MeterValuesSampledValue["measurand"],
      unitOfMeasure: sv.unit ? { unit: sv.unit } : undefined,
    })) as [V201MeterValuesSampledValue, ...V201MeterValuesSampledValue[]];

    const payload: MeterValuesRequestV201 = {
      evseId: v201MeterEvseId(connectorId),
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue,
        },
      ],
    };
    this.send("MeterValues", messageId, payload);
  }

  public sendDataTransfer(
    _vendorId: string,
    _messageId: string,
    _data?: string,
  ): void {
    this._logger.warn(
      "[v2.0.1] DataTransfer not supported in OCPP 2.0.1",
      LogType.OCPP,
    );
  }

  public sendDiagnosticsStatusNotification(_status: string): void {
    this._logger.warn(
      "[v2.0.1] DiagnosticsStatusNotification not supported in OCPP 2.0.1",
      LogType.OCPP,
    );
  }

  public sendFirmwareStatusNotification(_status: string): void {
    this._logger.warn(
      "[v2.0.1] FirmwareStatusNotification not supported in OCPP 2.0.1",
      LogType.OCPP,
    );
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
    this._seqNo = 0;
  }

  public flushPendingQueue(): void {
    // OCPP 2.0.1: pending queue handled by TransactionEvent seqNo mechanism
  }
}
