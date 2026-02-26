import {
  OcppMessageErrorPayload,
  OcppMessagePayload,
  OcppMessageRequestPayload,
  OcppMessageResponsePayload,
  OCPPWebSocket,
} from "./OCPPWebSocket";
import { ChargePoint } from "../../domain/charge-point/ChargePoint";
import { Transaction } from "../../domain/connector/Transaction";
import { Logger, LogType } from "../../shared/Logger";
import {
  BootNotification,
  OCPPAction,
  OCPPErrorCode,
  OCPPMessageType,
  OCPPStatus,
} from "../../domain/types/OcppTypes";

import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";

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
} from "./handlers";

type CoreOcppMessagePayloadCall =
  | request.ChangeAvailabilityRequest
  | request.ChangeConfigurationRequest
  | request.ClearCacheRequest
  | request.GetConfigurationRequest
  | request.RemoteStartTransactionRequest
  | request.RemoteStopTransactionRequest
  | request.ResetRequest
  | request.UnlockConnectorRequest;

type FirmwareManagementOcppMessagePayloadCall =
  | request.GetDiagnosticsRequest
  | request.UpdateFirmwareRequest;

type LocalAuthListManagementOcppMessagePayloadCall =
  | request.GetLocalListVersionRequest
  | request.SendLocalListRequest;

type ReservationOcppMessagePayloadCall =
  | request.CancelReservationRequest
  | request.ReserveNowRequest;

type SmartChargingOcppMessagePayloadCall =
  | request.ClearChargingProfileRequest
  | request.GetCompositeScheduleRequest
  | request.SetChargingProfileRequest;

type RemoteTriggerOcppMessagePayloadCall = request.TriggerMessageRequest;

type OcppMessagePayloadCall =
  | CoreOcppMessagePayloadCall
  | FirmwareManagementOcppMessagePayloadCall
  | LocalAuthListManagementOcppMessagePayloadCall
  | ReservationOcppMessagePayloadCall
  | SmartChargingOcppMessagePayloadCall
  | RemoteTriggerOcppMessagePayloadCall;

type CoreOcppMessagePayloadCallResult =
  | response.AuthorizeResponse
  | response.BootNotificationResponse
  | response.ChangeConfigurationResponse
  | response.DataTransferResponse
  | response.HeartbeatResponse
  | response.MeterValuesResponse
  | response.StartTransactionResponse
  | response.StatusNotificationResponse
  | response.StopTransactionResponse;

type FirmwareManagementOcppMessagePayloadCallResult =
  | response.DiagnosticsStatusNotificationResponse
  | response.FirmwareStatusNotificationResponse;

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
  private _registry: MessageHandlerRegistry = new MessageHandlerRegistry();

  constructor(
    chargePoint: ChargePoint,
    webSocket: OCPPWebSocket,
    logger: Logger,
  ) {
    this._chargePoint = chargePoint;
    this._webSocket = webSocket;
    this._logger = logger;

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

  public authorize(tagId: string): void {
    const messageId = this.generateMessageId();
    const payload: request.AuthorizeRequest = { idTag: tagId };
    this.sendRequest(OCPPAction.Authorize, messageId, payload);
  }

  public startTransaction(transaction: Transaction, connectorId: number): void {
    const messageId = this.generateMessageId();
    const payload: request.StartTransactionRequest = {
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
    const payload: request.StopTransactionRequest = {
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
    // bootPayload is already in the correct format (BootNotificationRequest from ts-ocpp)
    this.sendRequest(OCPPAction.BootNotification, messageId, bootPayload);
  }

  public sendHeartbeat(): void {
    const messageId = this.generateMessageId();
    const payload: request.HeartbeatRequest = {};
    this.sendRequest(OCPPAction.Heartbeat, messageId, payload);
  }

  public sendMeterValue(
    transactionId: number | undefined,
    connectorId: number,
    meterValue: number,
    soc?: number,
  ): void {
    const messageId = this.generateMessageId();

    // Build sampled values array
    const sampledValue: Array<{
      value: string;
      measurand?: string;
      unit?: string;
    }> = [
      {
        value: meterValue.toString(),
        measurand: "Energy.Active.Import.Register",
        unit: "Wh",
      },
    ];

    // Add SoC if available
    if (soc !== undefined) {
      sampledValue.push({
        value: soc.toString(),
        measurand: "SoC",
        unit: "Percent",
      });
    }

    const payload: request.MeterValuesRequest = {
      transactionId: transactionId,
      connectorId: connectorId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue,
        },
      ],
    };
    this.sendRequest(OCPPAction.MeterValues, messageId, payload);
  }

  public sendStatusNotification(connectorId: number, status: OCPPStatus): void {
    const messageId = this.generateMessageId();
    const payload: request.StatusNotificationRequest = {
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
          request.payload as request.MeterValuesRequest,
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
