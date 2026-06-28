import type {
  BootNotificationRequestV201,
  HeartbeatRequestV201,
  HeartbeatResponseV201,
  BootNotificationResponseV201,
  DataTransferRequestV201,
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
  TransactionChargingState,
} from "../../domain/connector/Transaction";
import {
  buildSampledValues,
  type ReadingContext,
} from "../../domain/connector/MeterValueBuilder";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
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

export class OCPPMessageHandlerV201 implements IChargePointMessageHandler {
  private readonly _chargePoint: ChargePoint;
  private readonly _webSocket: OCPPWebSocket;
  private readonly _logger: Logger;
  private readonly _codec?: ProtocolCodec;
  private readonly _dataTransferHandler: DataTransferHandler =
    new DataTransferHandler();
  private readonly _inbound: V201InboundRegistry;
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

    this._webSocket.setMessageHandler(this.handleIncomingMessage.bind(this));
  }

  private generateMessageId(): string {
    return crypto.randomUUID();
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
    const warning = this._codec?.outgoingWarning(action, payload);
    if (warning) {
      this._logger.warn(warning, LogType.OCPP);
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
      const entry = this._inbound.get(action);
      if (entry) {
        if (!entry.validate(payload)) {
          this._webSocket.sendError(messageId, {
            errorCode: "FormationViolation" as OCPPErrorCode,
            errorDescription: `Invalid ${action} payload`,
            errorDetails: {},
          });
          return;
        }

        const ctx: V201InboundContext = {
          chargePoint: this._chargePoint,
          logger: this._logger,
          sendCall: (a, p) => this.send(a, this.generateMessageId(), p),
        };
        const { response, afterResult } = entry.handle(payload, ctx);
        this._webSocket.sendResult(messageId, response);
        afterResult?.();
        return;
      }

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
    const messageId = this.generateMessageId();
    const seqNo = transaction.cpNextSeqNo ?? 0;
    transaction.cpNextSeqNo = seqNo + 1;
    transaction.cpLastTransactionEventChargingState = "Charging";
    const payload: TransactionEventRequestV201 = {
      eventType: "Started",
      timestamp: transaction.startTime.toISOString(),
      triggerReason: transaction.startTriggerReason ?? "Authorized",
      seqNo,
      transactionInfo: {
        transactionId,
        chargingState: "Charging",
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
    const messageId = this.generateMessageId();
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
    this.send("TransactionEvent", messageId, payload);
  }

  private sendStopTransaction(
    transaction: Transaction,
    connectorId: number,
  ): void {
    const transactionId = transaction.cpTransactionId ?? crypto.randomUUID();
    const messageId = this.generateMessageId();
    const timestamp = (transaction.stopTime ?? new Date()).toISOString();
    const seqNo = transaction.cpNextSeqNo ?? 0;
    transaction.cpNextSeqNo = seqNo + 1;
    const payload: TransactionEventRequestV201 = {
      eventType: "Ended",
      timestamp,
      triggerReason: transaction.stopTriggerReason ?? "StopAuthorized",
      seqNo,
      transactionInfo: {
        transactionId,
        stoppedReason: toV201StoppedReason(transaction.stopReason),
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
  }

  public sendTransactionEvent(event: TransactionLifecycleEvent): void {
    if (event.phase === "started")
      this.sendStartTransaction(event.transaction, event.connectorId);
    else this.sendStopTransaction(event.transaction, event.connectorId);
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
    vendorId: string,
    messageId?: string,
    data?: string,
  ): void {
    const id = this.generateMessageId();
    const payload = {
      vendorId,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(data !== undefined ? { data } : {}),
    } as unknown as DataTransferRequestV201;
    this.send("DataTransfer", id, payload);
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

  public onWebSocketClosed(): void {}

  public flushPendingQueue(): void {
    // OCPP 2.0.1: pending queue handled by TransactionEvent seqNo mechanism
  }
}
