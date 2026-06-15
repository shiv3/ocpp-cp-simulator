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
import { OCPPWebSocket } from "./OCPPWebSocket";
import { Logger, LogType } from "../../shared/Logger";
import {
  BootNotification,
  ChargePointErrorCode,
  OCPPMessageType,
  OCPPStatus,
} from "../../domain/types/OcppTypes";
import { Transaction } from "../../domain/connector/Transaction";
import {
  buildSampledValues,
  type ReadingContext,
} from "../../domain/connector/MeterValueBuilder";
import { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { IChargePointMessageHandler } from "./IChargePointMessageHandler";
import { DataTransferHandler } from "./handlers";

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
    this._webSocket.sendAction(messageId, action as never, payload as never);
  }

  private handleIncomingMessage(
    messageType: OCPPMessageType,
    messageId: string,
    _action: string,
    payload: unknown,
  ): void {
    if (messageType === OCPPMessageType.CALLRESULT) {
      this.handleCallResult(messageId, payload as V201ResponsePayload);
    } else if (messageType === OCPPMessageType.CALLERROR) {
      this._logger.warn(`[v2.0.1] CALLERROR for ${messageId}`, LogType.OCPP);
    }
  }

  private handleCallResult(
    messageId: string,
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
    _opts?: {
      errorCode?: ChargePointErrorCode;
      info?: string;
      vendorErrorCode?: string;
      vendorId?: string;
      timestamp?: Date;
    },
  ): void {
    if (connectorId === 0) return;

    const messageId = this.generateMessageId();
    const payload: StatusNotificationRequestV201 = {
      timestamp: new Date().toISOString(),
      connectorStatus: ocppStatusToV201(status),
      evseId: connectorId,
      connectorId: 1,
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
      transaction: {
        transactionId,
        chargingState: "Charging",
      },
      idToken: { idToken: transaction.tagId, type: "ISO14443" },
      evse: { id: connectorId, connectorId: 1 },
      meterValue: [
        {
          timestamp: transaction.startTime.toISOString(),
          sampledValue: [
            {
              value: String(transaction.meterStart / 1000),
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
    const payload: TransactionEventRequestV201 = {
      eventType: "Ended",
      timestamp: new Date().toISOString(),
      triggerReason: "StopAuthorized",
      seqNo: this.nextSeqNo(),
      transaction: {
        transactionId,
        stoppedReason: "Local",
      },
      evse: { id: connectorId, connectorId: 1 },
      meterValue:
        transaction.meterStop !== null
          ? [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: String(transaction.meterStop / 1000),
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

    const measurands = this._chargePoint.configuration.getArray(
      "MeterValuesSampledData",
    ) ?? ["Energy.Active.Import.Register"];
    const sampledValues = buildSampledValues(connector, measurands, context);

    const payload: MeterValuesRequestV201 = {
      evseId: connectorId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: sampledValues.map((sv) => ({
            value: String(sv.value),
            measurand:
              sv.measurand as MeterValuesRequestV201["meterValue"][0]["sampledValue"][0]["measurand"],
            unitOfMeasure: sv.unit ? { unit: sv.unit } : undefined,
          })),
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
