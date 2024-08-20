import {OCPPWebSocket} from "./OCPPWebSocket";
import {ChargePoint} from "./ChargePoint";
import {Transaction} from "./Transaction";
import {Logger} from "./Logger";
import {OCPPMessageType, OCPPAction, OCPPStatus} from "./OcppTypes";

import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";

import {OcppMessagePayload} from "./OCPPWebSocket";

type OcppMessagePayloadCall =
  | request.RemoteStartTransactionRequest
  | request.RemoteStopTransactionRequest
  | request.ResetRequest
  | request.GetDiagnosticsRequest
  | request.TriggerMessageRequest;



type OcppMessagePayloadCallResult =
  | response.AuthorizeResponse
  | response.BootNotificationResponse
  | response.HeartbeatResponse
  | response.MeterValuesResponse
  | response.StartTransactionResponse
  | response.StatusNotificationResponse
  | response.StopTransactionResponse;



import {UploadFile} from "./file_upload.ts";

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
    logger: Logger
  ) {
    this._chargePoint = chargePoint;
    this._webSocket = webSocket;
    this._logger = logger;

    this._webSocket.setMessageHandler(this.handleIncomingMessage.bind(this));
  }

  public authorize(tagId: string): void {
    const messageId = this.generateMessageId();
    const payload: request.AuthorizeRequest = {idTag: tagId};
    this.sendRequest(
      OCPPMessageType.CALL,
      OCPPAction.Authorize,
      messageId,
      payload
    );
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
      OCPPMessageType.CALL,
      OCPPAction.StartTransaction,
      messageId,
      payload,
      connectorId
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
      OCPPMessageType.CALL,
      OCPPAction.StopTransaction,
      messageId,
      payload,
      connectorId
    );
  }

  public sendBootNotification(): void {
    const messageId = this.generateMessageId();
    const payload = {
      chargePointVendor: "Vendor",
      chargePointModel: "Model",
      chargePointSerialNumber: "12345",
    };
    this.sendRequest(
      OCPPMessageType.CALL,
      OCPPAction.BootNotification,
      messageId,
      payload
    );
  }

  public sendHeartbeat(): void {
    const messageId = this.generateMessageId();
    const payload: request.HeartbeatRequest = {};
    this.sendRequest(
      OCPPMessageType.CALL,
      OCPPAction.Heartbeat,
      messageId,
      payload
    );
  }

  public sendReset(): void {
    const messageId = this.generateMessageId();
    const payload: request.ResetRequest = {type: "Hard"};
    this.sendRequest(
      OCPPMessageType.CALL,
      OCPPAction.Reset,
      messageId,
      payload
    );
  }

  public sendMeterValue(connectorId: number, meterValue: number): void {
    const messageId = this.generateMessageId();
    const payload: request.MeterValuesRequest = {
      connectorId: connectorId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{value: meterValue.toString()}],
        },
      ],
    };
    this.sendRequest(
      OCPPMessageType.CALL,
      OCPPAction.MeterValues,
      messageId,
      payload
    );
  }

  public sendStatusNotification(connectorId: number, status: OCPPStatus): void {
    const messageId = this.generateMessageId();
    const payload: request.StatusNotificationRequest = {
      connectorId: connectorId,
      errorCode: "NoError",
      status: status,
    };
    this.sendRequest(
      OCPPMessageType.CALL,
      OCPPAction.StatusNotification,
      messageId,
      payload
    );
  }

  private sendRequest(
    type: OCPPMessageType,
    action: OCPPAction,
    id: string,
    payload: OcppMessagePayload,
    connectorId?: number
  ): void {
    this._requests.add({type, action, id, payload, connectorId});
    this._webSocket.send(type, id, action, payload);
  }

  private handleIncomingMessage(
    messageType: OCPPMessageType,
    messageId: string,
    action: OCPPAction,
    payload: OcppMessagePayload
  ): void {
    this._logger.log(
      `Handling incoming message: ${messageType}, ${messageId}, ${action}`
    );
    switch (messageType) {
      case OCPPMessageType.CALL:
        this.handleCall(messageId, action, payload as OcppMessagePayloadCall);
        break;
      case OCPPMessageType.CALL_RESULT:
        this.handleCallResult(messageId, payload as OcppMessagePayloadCallResult);
        break;
      case OCPPMessageType.CALL_ERROR:
        this.handleCallError(messageId, payload);
        break;
      default:
        this._logger.error(`Unknown message type: ${messageType}`);
    }
  }

  private handleCall(
    messageId: string,
    action: OCPPAction,
    payload: OcppMessagePayloadCall
  ): void {
    let response;
    switch (action) {
      case OCPPAction.RemoteStartTransaction:
        response = this.handleRemoteStartTransaction(
          payload as request.RemoteStartTransactionRequest
        );
        break;
      case OCPPAction.RemoteStopTransaction:
        response = this.handleRemoteStopTransaction(
          payload as request.RemoteStopTransactionRequest
        );
        break;
      case OCPPAction.Reset:
        response = this.handleReset(payload as request.ResetRequest);
        break;
      case OCPPAction.GetDiagnostics:
        response = this.handleGetDiagnostics(payload as request.GetDiagnosticsRequest);
        break;
      case OCPPAction.TriggerMessage:
        response = this.handleTriggerMessage(payload as request.TriggerMessageRequest);
        break;
      default:
        this._logger.error(`Unsupported action: ${action}`);
        this.sendCallError(
          messageId,
          "NotImplemented",
          "This action is not supported"
        );
        return;
    }
    this.sendCallResult(messageId, response);
  }

  private handleCallResult(
    messageId: string,
    payload: OcppMessagePayloadCallResult
  ): void {
    if (!this._requests || !this._requests.get(messageId)) {
      this._logger.log(`Received unexpected CallResult: ${messageId}`);
      return;
    }
    const request = this._requests.get(messageId);
    const action = request?.action;
    switch (action) {
      case OCPPAction.BootNotification:
        this.handleBootNotificationResponse(
          payload as response.BootNotificationResponse
        );
        break;
      case OCPPAction.Authorize:
        this.handleAuthorizeResponse(payload as response.AuthorizeResponse);
        break;
      case OCPPAction.StartTransaction:
        this.handleStartTransactionResponse(
          request?.connectorId || 1,
          payload as response.StartTransactionResponse
        );
        break;
      case OCPPAction.StopTransaction:
        this.handleStopTransactionResponse(
          request?.connectorId || 1,
          payload as response.StopTransactionResponse
        );
        break;
      case OCPPAction.Heartbeat:
        this.handleHeartbeatResponse(payload as response.HeartbeatResponse);
        break;
      case OCPPAction.MeterValues:
        this.handleMeterValuesResponse(payload as response.MeterValuesResponse);
        break;
      case OCPPAction.StatusNotification:
        this.handleStatusNotificationResponse(
          payload as response.StatusNotificationResponse
        );
        break;
      default:
        this._logger.log(`Unsupported action result: ${action}`);
    }

    this._requests.remove(messageId);
  }

  private handleCallError(messageId: string, error: OcppMessagePayload): void {
    this._logger.log(
      `Received error for message ${messageId}: ${JSON.stringify(error)}`
    );
    // Handle the error appropriately
    this._requests.remove(messageId);
  }

  private handleRemoteStartTransaction(
    payload: request.RemoteStartTransactionRequest
  ): response.RemoteStartTransactionResponse {
    const {idTag, connectorId} = payload;
    const connector = this._chargePoint.getConnector(connectorId || 1);

    if (connector && connector.availability == "Operative") {
      this._chargePoint.startTransaction(idTag, connectorId || 1);
      return {status: "Accepted"};
    } else {
      return {status: "Rejected"};
    }
  }

  private handleRemoteStopTransaction(
    payload: request.RemoteStopTransactionRequest
  ): response.RemoteStopTransactionResponse {
    const {transactionId} = payload;
    const connector = Array.from(this._chargePoint.connectors.values()).find(
      (c) => c.transaction && c.transaction.id === transactionId
    );

    if (connector) {
      const tagId = connector.transaction?.tagId || "";
      if (tagId === "") {
        throw new Error("Tag ID not found");
      }
      this._chargePoint.updateConnectorStatus(
        connector.id,
        OCPPStatus.SuspendedEVSE
      );
      this._chargePoint.stopTransaction(tagId, connector.id);
      return {status: "Accepted"};
    } else {
      return {status: "Rejected"};
    }
  }

  private handleReset(payload: request.ResetRequest): response.ResetResponse {
    this._logger.log(`Reset request received: ${payload.type}`);
    this._chargePoint.sendReset();
    return {status: "Accepted"};
  }

  private handleGetDiagnostics(
    payload: request.GetDiagnosticsRequest
  ): response.GetDiagnosticsResponse {
    this._logger.log(`Get diagnostics request received: ${payload.location}`); // e.g. `FTP
    const logs = this._logger.getLogs().join("\n");
    const blob = new Blob([logs], {type: "text/plain"});
    const file = new File([blob], "diagnostics.txt");
    (async () => await UploadFile(payload.location, file))();
    return {fileName: "diagnostics.txt"};
  }

  private handleTriggerMessage(
    payload: request.TriggerMessageRequest
  ): response.TriggerMessageResponse {
    this._logger.log(
      `Trigger message request received: ${payload.requestedMessage}`
    ); // e.g. `DiagnosticsStatusNotification`
    return {status: "Accepted"};
  }

  private handleBootNotificationResponse(
    payload: response.BootNotificationResponse
  ): void {
    this._logger.log("Boot notification successful");
    if (payload.status === "Accepted") {
      this._chargePoint.updateAllConnectorsStatus(OCPPStatus.Available);
      this._chargePoint.status = OCPPStatus.Available;
    } else {
      this._logger.error("Boot notification failed");
    }
  }

  private handleAuthorizeResponse(payload: response.AuthorizeResponse): void {
    const {idTagInfo} = payload;
    if (idTagInfo.status === "Accepted") {
      this._logger.log("Authorization successful");
    } else {
      this._logger.log("Authorization failed");
    }
  }

  private handleStartTransactionResponse(
    connectorId: number,
    payload: response.StartTransactionResponse
  ): void {
    const {transactionId, idTagInfo} = payload;
    const connector = this._chargePoint.getConnector(connectorId);
    if (idTagInfo.status === "Accepted") {
      if (connector) {
        connector.transactionId = transactionId;
        connector.status = OCPPStatus.Charging;
      }
    } else {
      this._logger.log("Failed to start transaction");
      if (connector) {
        connector.status = OCPPStatus.Faulted;
      }
    }
  }

  private handleStopTransactionResponse(
    connectorId: number,
    payload: response.StopTransactionResponse
  ): void {
    this._logger.log(
      `Transaction stopped successfully: ${JSON.stringify(payload)}`
    );
    const connector = this._chargePoint.getConnector(connectorId);
    if (connector) {
      connector.transaction = null;
      connector.transactionId = null;
      connector.status = OCPPStatus.Available;
    }
  }

  private handleHeartbeatResponse(payload: response.HeartbeatResponse): void {
    this._logger.log(`Received heartbeat response: ${payload.currentTime}`);
  }

  private handleMeterValuesResponse(payload: response.MeterValuesResponse): void {
    this._logger.log(`Meter values sent successfully: ${payload}`);
  }

  private handleStatusNotificationResponse(
    payload: response.StatusNotificationResponse
  ): void {
    this._logger.log(`Status notification sent successfully: ${payload}`);
  }

  private sendCallResult(messageId: string, payload: OcppMessagePayload): void {
    this._webSocket.send(
      OCPPMessageType.CALL_RESULT,
      messageId,
      "" as OCPPAction,
      payload
    );
  }

  private sendCallError(
    messageId: string,
    errorCode: string,
    errorDescription: string
  ): void {
    const errorDetails = {
      errorCode: errorCode,
      errorDescription: errorDescription,
    };
    this._webSocket.send(
      OCPPMessageType.CALL_ERROR,
      messageId,
      "" as OCPPAction,
      errorDetails
    );
  }

  private generateMessageId(): string {
    return crypto.randomUUID()
  }
}