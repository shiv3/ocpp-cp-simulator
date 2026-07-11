/**
 * OCPP 1.6 Message Handler (Legacy V1 Implementation)
 *
 * NOTE: Smart Charging implementation uses simplified approach
 * See main implementation in src/cp/infrastructure/transport/handlers/call/SmartChargingHandlers.ts
 * for detailed documentation on non-compliant behaviors.
 *
 * Key simplifications:
 * - ConnectorId=0 profiles duplicated to all connectors
 * - No composite schedule merging with min() logic
 * - No ChargePointMaxProfile total station enforcement
 * - Adequate for simulator/testing purposes
 */

import type {
  AuthorizeRequestV16,
  AuthorizeResponseV16,
  BootNotificationRequestV16,
  BootNotificationResponseV16,
  CancelReservationRequestV16,
  ChangeAvailabilityRequestV16,
  ChangeAvailabilityResponseV16,
  ChangeConfigurationRequestV16,
  ChangeConfigurationResponseV16,
  ClearCacheRequestV16,
  ClearCacheResponseV16,
  ClearChargingProfileRequestV16,
  ClearChargingProfileResponseV16,
  DataTransferResponseV16,
  DiagnosticsStatusNotificationResponseV16,
  FirmwareStatusNotificationResponseV16,
  GetCompositeScheduleRequestV16,
  GetCompositeScheduleResponseV16,
  GetConfigurationRequestV16,
  GetConfigurationResponseV16,
  GetDiagnosticsRequestV16,
  GetDiagnosticsResponseV16,
  GetLocalListVersionRequestV16,
  HeartbeatRequestV16,
  HeartbeatResponseV16,
  MeterValuesRequestV16,
  MeterValuesResponseV16,
  RemoteStartTransactionRequestV16,
  RemoteStartTransactionResponseV16,
  RemoteStopTransactionRequestV16,
  RemoteStopTransactionResponseV16,
  ReserveNowRequestV16,
  ResetRequestV16,
  ResetResponseV16,
  SendLocalListRequestV16,
  SetChargingProfileRequestV16,
  SetChargingProfileResponseV16,
  StartTransactionRequestV16,
  StartTransactionResponseV16,
  StatusNotificationRequestV16,
  StatusNotificationResponseV16,
  StopTransactionRequestV16,
  StopTransactionResponseV16,
  TriggerMessageRequestV16,
  TriggerMessageResponseV16,
  UnlockConnectorRequestV16,
  UnlockConnectorResponseV16,
  UpdateFirmwareRequestV16,
} from "../../ocpp";
import {
  OcppMessageErrorPayload,
  OcppMessagePayload,
  OcppMessageRequestPayload,
  OcppMessageResponsePayload,
  OCPPWebSocket,
} from "./OCPPWebSocket";
import { ChargePoint } from "./ChargePoint";
import type { Connector } from "./Connector";
import { Transaction } from "./Transaction";
import { Logger } from "./Logger";
import {
  BootNotification,
  OCPPAction,
  ChargingProfilePurposeType,
  ChargingProfileKindType,
  ChargingRateUnitType,
  RecurrencyKindType,
  OcppConfigurationKey,
  OCPPErrorCode,
  OCPPMessageType,
  OCPPStatus,
} from "./OcppTypes";
import { UploadFile } from "./file_upload.ts";
import {
  ArrayConfigurationValue,
  BooleanConfigurationValue,
  Configuration,
  ConfigurationValue,
  defaultConfiguration,
  IntegerConfigurationValue,
  StringConfigurationValue,
} from "./Configuration.ts";

function applyProfileStatus(
  chargePoint: ChargePoint,
  connector: Connector,
): void {
  const activeProfile = connector.getActiveChargingProfile();
  const isPaused = activeProfile
    ? activeProfile.chargingSchedulePeriods.every((p) => p.limit === 0)
    : false;

  if (isPaused && connector.status === OCPPStatus.Charging) {
    chargePoint.updateConnectorStatus(connector.id, OCPPStatus.SuspendedEVSE);
  } else if (
    !isPaused &&
    connector.status === OCPPStatus.SuspendedEVSE &&
    connector.transaction != null
  ) {
    chargePoint.updateConnectorStatus(connector.id, OCPPStatus.Charging);
  }
}

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
  GetDiagnosticsRequestV16 | UpdateFirmwareRequestV16;

type LocalAuthListManagementOcppMessagePayloadCall =
  GetLocalListVersionRequestV16 | SendLocalListRequestV16;

type ReservationOcppMessagePayloadCall =
  CancelReservationRequestV16 | ReserveNowRequestV16;

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
  private _requests: RequestHistory = new RequestHistory();

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
    const payload: StopTransactionRequestV16 = {
      transactionId: transaction.id!,
      idTag: transaction.tagId,
      meterStop: transaction.meterStop!,
      timestamp: transaction.stopTime!.toISOString(),
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
    const payload: BootNotificationRequestV16 = {
      chargePointVendor: bootPayload.ChargePointVendor,
      chargePointModel: bootPayload.ChargePointModel,
      chargePointSerialNumber: bootPayload.ChargePointSerialNumber,
      chargeBoxSerialNumber: bootPayload.ChargeBoxSerialNumber,
      firmwareVersion: bootPayload.FirmwareVersion,
      iccid: bootPayload.Iccid,
      imsi: bootPayload.Imsi,
      meterType: bootPayload.MeterType,
      meterSerialNumber: bootPayload.MeterSerialNumber,
    };
    this.sendRequest(OCPPAction.BootNotification, messageId, payload);
  }

  public sendHeartbeat(): void {
    const messageId = this.generateMessageId();
    const payload: HeartbeatRequestV16 = {};
    this.sendRequest(OCPPAction.Heartbeat, messageId, payload);
  }

  public sendMeterValue(
    transactionId: number | undefined,
    connectorId: number,
    meterValue: number,
  ): void {
    const messageId = this.generateMessageId();
    const payload: MeterValuesRequestV16 = {
      transactionId: transactionId,
      connectorId: connectorId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ value: meterValue.toString() }],
        },
      ],
    };
    this.sendRequest(OCPPAction.MeterValues, messageId, payload);
  }

  public sendStatusNotification(connectorId: number, status: OCPPStatus): void {
    const messageId = this.generateMessageId();
    const payload: StatusNotificationRequestV16 = {
      connectorId: connectorId,
      errorCode: "NoError",
      status: status,
    };
    this.sendRequest(OCPPAction.StatusNotification, messageId, payload);
  }

  private sendRequest(
    action: OCPPAction,
    id: string,
    payload: OcppMessageRequestPayload,
    connectorId?: number,
  ): void {
    this._requests.add({
      type: OCPPMessageType.CALL,
      action,
      id,
      payload,
      connectorId,
    });
    this._webSocket.sendAction(id, action, payload);
  }

  private handleIncomingMessage(
    messageType: OCPPMessageType,
    messageId: string,
    action: OCPPAction,
    payload: OcppMessagePayload,
  ): void {
    this._logger.log(
      `Handling incoming message: ${messageType}, ${messageId}, ${action}`,
    );
    switch (messageType) {
      case OCPPMessageType.CALL:
        this.handleCall(messageId, action, payload as OcppMessagePayloadCall);
        break;
      case OCPPMessageType.CALL_RESULT:
        this.handleCallResult(
          messageId,
          payload as OcppMessagePayloadCallResult,
        );
        break;
      case OCPPMessageType.CALL_ERROR:
        this.handleCallError(messageId, payload as OcppMessageErrorPayload);
        break;
      default:
        this._logger.error(`Unknown message type: ${messageType}`);
    }
  }

  private handleCall(
    messageId: string,
    action: OCPPAction,
    payload: OcppMessagePayloadCall,
  ): void {
    let response: OcppMessageResponsePayload;
    switch (action) {
      case OCPPAction.RemoteStartTransaction:
        response = this.handleRemoteStartTransaction(
          payload as RemoteStartTransactionRequestV16,
        );
        break;
      case OCPPAction.RemoteStopTransaction:
        response = this.handleRemoteStopTransaction(
          payload as RemoteStopTransactionRequestV16,
        );
        break;
      case OCPPAction.Reset:
        response = this.handleReset(payload as ResetRequestV16);
        break;
      case OCPPAction.GetDiagnostics:
        response = this.handleGetDiagnostics(
          payload as GetDiagnosticsRequestV16,
        );
        break;
      case OCPPAction.TriggerMessage:
        response = this.handleTriggerMessage(
          payload as TriggerMessageRequestV16,
        );
        break;
      case OCPPAction.GetConfiguration:
        response = this.handleGetConfiguration(
          payload as GetConfigurationRequestV16,
        );
        break;
      case OCPPAction.ChangeConfiguration:
        response = this.handleChangeConfiguration(
          payload as ChangeConfigurationRequestV16,
        );
        break;
      case OCPPAction.ClearCache:
        response = this.handleClearCache(payload as ClearCacheRequestV16);
        break;
      case OCPPAction.UnlockConnector:
        response = this.handleUnlockConnector(
          payload as UnlockConnectorRequestV16,
        );
        break;
      case OCPPAction.SetChargingProfile:
        response = this.handleSetChargingProfile(
          payload as SetChargingProfileRequestV16,
        );
        break;
      case OCPPAction.ClearChargingProfile:
        response = this.handleClearChargingProfile(
          payload as ClearChargingProfileRequestV16,
        );
        break;
      case OCPPAction.GetCompositeSchedule:
        response = this.handleGetCompositeSchedule(
          payload as GetCompositeScheduleRequestV16,
        );
        break;
      default:
        this._logger.error(`Unsupported action: ${action}`);
        this.sendCallError(
          messageId,
          "NotImplemented",
          "This action is not supported",
        );
        return;
    }
    this.sendCallResult(messageId, response);
  }

  private handleCallResult(
    messageId: string,
    payload: OcppMessagePayloadCallResult,
  ): void {
    if (!this._requests || !this._requests.get(messageId)) {
      this._logger.log(`Received unexpected CallResult: ${messageId}`);
      return;
    }
    const request = this._requests.get(messageId);
    const action = request?.action;
    switch (action) {
      case OCPPAction.ChangeAvailability:
        this.handleChangeAvailability(payload as ChangeAvailabilityRequestV16);
        break;
      case OCPPAction.BootNotification:
        this.handleBootNotificationResponse(
          payload as BootNotificationResponseV16,
        );
        break;
      case OCPPAction.Authorize:
        this.handleAuthorizeResponse(payload as AuthorizeResponseV16);
        break;
      case OCPPAction.StartTransaction:
        this.handleStartTransactionResponse(
          request?.connectorId || 1,
          payload as StartTransactionResponseV16,
        );
        break;
      case OCPPAction.StopTransaction:
        this.handleStopTransactionResponse(
          request?.connectorId || 1,
          payload as StopTransactionResponseV16,
        );
        break;
      case OCPPAction.Heartbeat:
        this.handleHeartbeatResponse(payload as HeartbeatResponseV16);
        break;
      case OCPPAction.MeterValues:
        this.handleMeterValuesResponse(
          payload as MeterValuesResponseV16,
          request?.payload as MeterValuesRequestV16,
        );
        break;
      case OCPPAction.StatusNotification:
        this.handleStatusNotificationResponse(
          payload as StatusNotificationResponseV16,
        );
        break;
      case OCPPAction.DataTransfer:
        this.handleDataTransferResponse(payload as DataTransferResponseV16);
        break;
      default:
        this._logger.log(`Unsupported action result: ${action}`);
    }

    this._requests.remove(messageId);
  }

  private handleCallError(
    messageId: string,
    error: OcppMessageErrorPayload,
  ): void {
    this._logger.log(
      `Received error for message ${messageId}: ${JSON.stringify(error)}`,
    );
    // Handle the error appropriately
    this._requests.remove(messageId);
  }

  private handleRemoteStartTransaction(
    payload: RemoteStartTransactionRequestV16,
  ): RemoteStartTransactionResponseV16 {
    const { idTag, connectorId } = payload;
    const connector = this._chargePoint.getConnector(connectorId || 1);

    if (connector && connector.availability == "Operative") {
      this._chargePoint.startTransaction(idTag, connectorId || 1);
      return { status: "Accepted" };
    } else {
      return { status: "Rejected" };
    }
  }

  private handleRemoteStopTransaction(
    payload: RemoteStopTransactionRequestV16,
  ): RemoteStopTransactionResponseV16 {
    const { transactionId } = payload;
    const connector = Array.from(this._chargePoint.connectors.values()).find(
      (c) => c.transaction && c.transaction.id === transactionId,
    );

    if (connector) {
      this._chargePoint.updateConnectorStatus(
        connector.id,
        OCPPStatus.SuspendedEVSE,
      );
      this._chargePoint.stopTransaction(connector);
      return { status: "Accepted" };
    } else {
      return { status: "Rejected" };
    }
  }

  private handleReset(payload: ResetRequestV16): ResetResponseV16 {
    this._logger.log(`Reset request received: ${payload.type}`);
    setTimeout(() => {
      this._logger.log(`Reset chargePoint: ${this._chargePoint.id}`);
      if (payload.type === "Hard") {
        this._chargePoint.reset();
      } else {
        this._chargePoint.boot();
      }
    }, 5_000);
    return { status: "Accepted" };
  }

  private handleGetDiagnostics(
    payload: GetDiagnosticsRequestV16,
  ): GetDiagnosticsResponseV16 {
    this._logger.log(`Get diagnostics request received: ${payload.location}`); // e.g. `FTP
    const logs = this._logger.getLogs().join("\n");
    const blob = new Blob([logs], { type: "text/plain" });
    const file = new File([blob], "diagnostics.txt");
    (async () => await UploadFile(payload.location, file))();
    return { fileName: "diagnostics.txt" };
  }

  private handleGetConfiguration(
    payload: GetConfigurationRequestV16,
  ): GetConfigurationResponseV16 {
    this._logger.log(
      `Get configuration request received: ${JSON.stringify(payload.key)}`,
    );
    const configuration = OCPPMessageHandler.mapConfiguration(
      defaultConfiguration(this._chargePoint),
    );
    if (!payload.key || payload.key.length === 0) {
      return {
        configurationKey: configuration,
      };
    }
    const filteredConfig = configuration.filter((c) =>
      payload.key?.includes(c.key),
    );
    const configurationKeys = configuration.map((c) => c.key);
    const unknownKeys = payload.key.filter(
      (c) => !configurationKeys.includes(c),
    );
    return {
      configurationKey: filteredConfig,
      unknownKey: unknownKeys,
    };
  }

  private static mapConfiguration(
    config: Configuration,
  ): OcppConfigurationKey[] {
    return config.map((c) => ({
      key: c.key.name,
      readonly: c.key.readonly,
      value: OCPPMessageHandler.mapValue(c),
    }));
  }

  private static mapValue(value: ConfigurationValue): string {
    switch (value.key.type) {
      case "string":
        return (value as StringConfigurationValue).value;
      case "boolean":
        return String((value as BooleanConfigurationValue).value);
      case "integer":
        return String((value as IntegerConfigurationValue).value);
      case "array":
        return (value as ArrayConfigurationValue).value.join(",");
    }
  }

  private handleChangeConfiguration(
    payload: ChangeConfigurationRequestV16,
  ): ChangeConfigurationResponseV16 {
    this._logger.log(
      `Change configuration request received: ${JSON.stringify(payload.key)}: ${JSON.stringify(payload.value)}`,
    );
    switch (payload.key) {
      default:
        return {
          status: "NotSupported",
        };
    }
  }

  private handleTriggerMessage(
    payload: TriggerMessageRequestV16,
  ): TriggerMessageResponseV16 {
    this._logger.log(
      `Trigger message request received: ${payload.requestedMessage}`,
    ); // e.g. `DiagnosticsStatusNotification`
    return { status: "Accepted" };
  }

  private handleChangeAvailability(
    payload: ChangeAvailabilityRequestV16,
  ): ChangeAvailabilityResponseV16 {
    this._logger.log(
      `Change availability request received: ${JSON.stringify(payload)}`,
    );
    const updated = this._chargePoint.updateConnectorAvailability(
      payload.connectorId,
      payload.type,
    );
    if (updated) {
      return { status: "Accepted" };
    } else {
      return { status: "Rejected" };
    }
  }

  private handleClearCache(
    payload: ClearCacheRequestV16,
  ): ClearCacheResponseV16 {
    this._logger.log(
      `Clear cache request received: ${JSON.stringify(payload)}`,
    );
    return { status: "Accepted" };
  }

  private handleUnlockConnector(
    payload: UnlockConnectorRequestV16,
  ): UnlockConnectorResponseV16 {
    this._logger.log(
      `Unlock connector request received: ${JSON.stringify(payload)}`,
    );
    return { status: "NotSupported" };
  }

  private handleSetChargingProfile(
    payload: SetChargingProfileRequestV16,
  ): SetChargingProfileResponseV16 {
    const { connectorId, csChargingProfiles } = payload;
    this._logger.log(
      `SetChargingProfile received for connector ${connectorId}: profileId=${csChargingProfiles.chargingProfileId}, purpose=${csChargingProfiles.chargingProfilePurpose}`,
    );

    const periods = csChargingProfiles.chargingSchedule.chargingSchedulePeriod;
    if (!periods || periods.length === 0) {
      this._logger.log("SetChargingProfile rejected: no schedule periods");
      return { status: "Rejected" };
    }

    if (
      csChargingProfiles.chargingProfilePurpose ===
        ChargingProfilePurposeType.TxProfile &&
      connectorId === 0
    ) {
      this._logger.log(
        "SetChargingProfile rejected: TxProfile on connectorId 0",
      );
      return { status: "Rejected" };
    }

    if (
      csChargingProfiles.chargingProfileKind ===
        ChargingProfileKindType.Recurring &&
      !csChargingProfiles.recurrencyKind
    ) {
      this._logger.log(
        "SetChargingProfile rejected: Recurring profile missing recurrencyKind",
      );
      return { status: "Rejected" };
    }

    const profile = {
      chargingProfileId: csChargingProfiles.chargingProfileId,
      connectorId,
      stackLevel: csChargingProfiles.stackLevel,
      chargingProfilePurpose:
        csChargingProfiles.chargingProfilePurpose as ChargingProfilePurposeType,
      chargingProfileKind:
        csChargingProfiles.chargingProfileKind as ChargingProfileKindType,
      chargingRateUnit: csChargingProfiles.chargingSchedule
        .chargingRateUnit as ChargingRateUnitType,
      recurrencyKind: csChargingProfiles.recurrencyKind as
        RecurrencyKindType | undefined,
      validFrom: csChargingProfiles.validFrom,
      validTo: csChargingProfiles.validTo,
      chargingSchedulePeriods: periods,
    };

    if (connectorId === 0) {
      this._chargePoint.connectors.forEach((connector) => {
        connector.addChargingProfile({ ...profile, connectorId: connector.id });
        applyProfileStatus(this._chargePoint, connector);
      });
    } else {
      const connector = this._chargePoint.getConnector(connectorId);
      if (!connector) return { status: "Rejected" };
      connector.addChargingProfile(profile);
      applyProfileStatus(this._chargePoint, connector);
    }

    return { status: "Accepted" };
  }

  private handleClearChargingProfile(
    payload: ClearChargingProfileRequestV16,
  ): ClearChargingProfileResponseV16 {
    this._logger.log(
      `ClearChargingProfile received: id=${payload.id}, connectorId=${payload.connectorId}`,
    );

    const criteria: Parameters<Connector["removeChargingProfiles"]>[0] = {};
    if (payload.id != null) criteria.profileId = payload.id;
    if (payload.chargingProfilePurpose != null) {
      criteria.purpose =
        payload.chargingProfilePurpose as ChargingProfilePurposeType;
    }
    if (payload.stackLevel != null) criteria.stackLevel = payload.stackLevel;

    if (payload.connectorId != null) {
      const connector = this._chargePoint.getConnector(payload.connectorId);
      if (connector) {
        connector.removeChargingProfiles(criteria);
        applyProfileStatus(this._chargePoint, connector);
      }
    } else {
      this._chargePoint.connectors.forEach((connector) => {
        connector.removeChargingProfiles(criteria);
        applyProfileStatus(this._chargePoint, connector);
      });
    }

    return { status: "Accepted" };
  }

  private handleGetCompositeSchedule(
    payload: GetCompositeScheduleRequestV16,
  ): GetCompositeScheduleResponseV16 {
    this._logger.log(
      `GetCompositeSchedule received: connectorId=${payload.connectorId}, duration=${payload.duration}`,
    );

    const connector = this._chargePoint.getConnector(payload.connectorId);
    if (!connector) return { status: "Rejected" };

    const activeProfile = connector.getActiveChargingProfile();
    if (!activeProfile) return { status: "Rejected" };

    if (
      payload.chargingRateUnit &&
      payload.chargingRateUnit !== activeProfile.chargingRateUnit
    ) {
      return { status: "Rejected" };
    }

    return {
      status: "Accepted",
      connectorId: payload.connectorId,
      scheduleStart: activeProfile.validFrom || new Date().toISOString(),
      chargingSchedule: {
        duration: payload.duration,
        startSchedule: activeProfile.validFrom || new Date().toISOString(),
        chargingRateUnit: activeProfile.chargingRateUnit,
        chargingSchedulePeriod: activeProfile.chargingSchedulePeriods.map(
          (period) => ({
            startPeriod: period.startPeriod,
            limit: period.limit,
            numberPhases: period.numberPhases,
          }),
        ),
      },
    };
  }

  private handleBootNotificationResponse(
    payload: BootNotificationResponseV16,
  ): void {
    this._logger.log("Boot notification successful");
    if (payload.status === "Accepted") {
      this._chargePoint.updateAllConnectorsStatus(OCPPStatus.Available);
      this._chargePoint.status = OCPPStatus.Available;
    } else {
      this._logger.error("Boot notification failed");
    }
  }

  private handleAuthorizeResponse(payload: AuthorizeResponseV16): void {
    const { idTagInfo } = payload;
    if (idTagInfo.status === "Accepted") {
      this._logger.log("Authorization successful");
    } else {
      this._logger.log("Authorization failed");
    }
  }

  private handleStartTransactionResponse(
    connectorId: number,
    payload: StartTransactionResponseV16,
  ): void {
    const { transactionId, idTagInfo } = payload;
    const connector = this._chargePoint.getConnector(connectorId);
    if (idTagInfo.status === "Accepted") {
      if (connector) {
        connector.transactionId = transactionId;
        this._chargePoint.updateConnectorStatus(
          connectorId,
          OCPPStatus.Charging,
        );
      }
    } else {
      this._logger.log("Failed to start transaction");
      if (connector) {
        connector.status = OCPPStatus.Faulted;
        if (connector.transaction && connector.transaction.meterSent) {
          this._chargePoint.stopTransaction(connector);
        } else {
          this._chargePoint.cleanTransaction(connector);
        }
      } else {
        this._chargePoint.cleanTransaction(connectorId);
      }
      this._chargePoint.updateConnectorStatus(
        connectorId,
        OCPPStatus.Available,
      );
    }
  }

  private handleStopTransactionResponse(
    connectorId: number,
    payload: StopTransactionResponseV16,
  ): void {
    this._logger.log(
      `Transaction stopped successfully: ${JSON.stringify(payload)}`,
    );
    const connector = this._chargePoint.getConnector(connectorId);
    if (connector) {
      connector.transaction = null;
      connector.transactionId = null;
      connector.status = OCPPStatus.Available;
    }
  }

  private handleHeartbeatResponse(payload: HeartbeatResponseV16): void {
    this._logger.log(`Received heartbeat response: ${payload.currentTime}`);
  }

  private handleMeterValuesResponse(
    payload: MeterValuesResponseV16,
    request?: MeterValuesRequestV16,
  ): void {
    if (request) {
      const connector = this._chargePoint.getConnector(request.connectorId);
      if (connector && connector.transaction) {
        connector.transaction.meterSent = true;
      }
    }
    this._logger.log(
      `Meter values sent successfully: ${JSON.stringify(payload)}`,
    );
  }

  private handleStatusNotificationResponse(
    payload: StatusNotificationResponseV16,
  ): void {
    this._logger.log(
      `Status notification sent successfully: ${JSON.stringify(payload)}`,
    );
  }

  private handleDataTransferResponse(payload: DataTransferResponseV16): void {
    this._logger.log(
      `Data transfer sent successfully: ${JSON.stringify(payload)}`,
    );
  }

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
