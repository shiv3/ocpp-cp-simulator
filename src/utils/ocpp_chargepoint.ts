import * as localocpp from "./ocpp_constants";
import {
  MessageTrigger,
  OCPPAction,
  OCPPGetDiagnosticsRequest,
  OCPPMessageType,
  OCPPTriggerMessageRequest,
  OCPPTriggerMessageResponse,
} from "./ocpp_constants";
import {
  ChargePoint,
  getConnector,
  getLatestTransaction,
  getMeterValue,
  getTransaction,
  getTransactionByTagId,
  getTransactionByTransactionId,
  setAllConnectorsStatus,
  setChargePoint,
  setConnectorStatus,
  setMeterValue,
  setTransaction
} from "./storage";
import {UploadFile} from "./file_upload";

import {
  BootNotificationRequest,
  GetDiagnosticsRequest,
  RemoteStartTransactionRequest,
  RemoteStopTransactionRequest, StartTransactionRequest,
  StopTransactionRequest, TriggerMessageRequest
} from "@voltbras/ts-ocpp/dist/messages/json/request";


import {
  GetDiagnosticsResponse, MeterValuesResponse,
  RemoteStartTransactionResponse,
  RemoteStopTransactionResponse,
  StartTransactionResponse,
  StopTransactionResponse,
  TriggerMessageResponse,
} from "@voltbras/ts-ocpp/dist/messages/json/response";

export interface OCPPChargePointInterface {
  setStatusChangeCallback: (
    callback: (status: string, message?: string) => void
  ) => void;
  setLoggingCallback: (callback: (message: string) => void) => void;
  setConnectorTransactionIDChangeCallback: (connectorId: number, callback: (transactionId: number) => void) => void;
  setConnectorStatusChangeCallback: (connectorId: number, callback: (status: string) => void) => void;
  setAvailabilityChangeCallback: (connectorId: number, callback: (availability: string) => void) => void;
  setTransactionID: (connectorId: number, transactionId: number) => void;
  wsConnect: (url: string, cpid: string) => void;
  wsDisconnect: () => void;
  authorize: (tagId: string) => void;
  startTransaction: (
    tagId: string,
    connectorId: number,
    reservationId: number
  ) => void;
  stopTransaction: (tagId: string) => void;
  sendHeartbeat: () => void;
  sendMeterValue: (connectorId: number) => void;
  setConnectorStatus: (
    connectorId: number,
    status: string,
    updateServer?: boolean
  ) => void;
  connectorStatus: (connectorId: number) => string;
  availability: (connectorId?: number) => string;
  setConnectorAvailability: (connectorId: number, availability: string) => void;
  meterValue: (connectorId: number) => number;
  setMeterValue: (connectorId: number, value: number, updateServer?: boolean) => void;
}

interface OCPPRequest {
  type: OCPPMessageType,
  action: OCPPAction,
  tagId: string,
  id: string,
  payload: StartTransactionRequest | StopTransactionRequest | TriggerMessageRequest
}

export default class OCPPChargePoint implements OCPPChargePointInterface {
  private _websocket: WebSocket | null = null;
  connectorNumber: number = 2;
  wsURL: string = "";
  cpid: string = "";

  //   private _heartbeat: NodeJS.Timeout | null = null;

  private _lastRequest: OCPPRequest | null = null;
  private _statusChangeCb: ((status: string, message?: string) => void) | null = null;
  private _connectorTransactionIDChangeCbs: Map<number, ((message: number) => void) | null> | null = null;
  private _connectorStatusChangeCbs: Map<number, ((status: string) => void) | null> | null = null;
  private _availabilityChangeCbs: Map<number, ((availability: string) => void)> | null = null;
  private _loggingCb: ((message: string) => void) | null = null;
  private _logList: string[] = [];
  private _heartbeat: number | null = null;

  constructor(
    connectorNumber: number = 2,
    wsURL: string = "",
    cpid: string = ""
  ) {
    this.connectorNumber = connectorNumber;
    this.wsURL = wsURL;
    this.cpid = cpid;

    const connectors = [];
    for (let i = 1; i <= connectorNumber; i++) {
      connectors.push({
        id: i,
        status: localocpp.OCPPStatus.Unavailable,
        availability: localocpp.AVAILABITY_OPERATIVE,
        transaction: null,
        meterValue: 0,
      });
    }
    const cp = {
      id: cpid,
      connectorNumber: connectorNumber,
      connectors: connectors,
    } as ChargePoint
    setChargePoint(cp);
  }

  setStatusChangeCallback(
    callback: (status: string, message?: string) => void
  ): void {
    this._statusChangeCb = callback;
  }

  setConnectorStatusChangeCallback(
    connectorId: number,
    callback: (status: string) => void
  ): void {
    if (!this._connectorStatusChangeCbs) {
      this._connectorStatusChangeCbs = new Map();
    }
    this._connectorStatusChangeCbs.set(connectorId, callback);
  }

  setConnectorTransactionIDChangeCallback(
    connectorId: number,
    callback: (transactionId: number) => void
  ): void {
    if (!this._connectorTransactionIDChangeCbs) {
      this._connectorTransactionIDChangeCbs = new Map();
    }
    this._connectorTransactionIDChangeCbs.set(connectorId, callback);
  }

  setLoggingCallback(callback: (message: string) => void): void {
    this._loggingCb = callback;
  }

  setAvailabilityChangeCallback(
    connectorId: number,
    callback: (availability: string) => void
  ): void {
    if (!this._availabilityChangeCbs) {
      this._availabilityChangeCbs = new Map();
    }
    this._availabilityChangeCbs.set(connectorId, callback);
  }

  private logMsg(msg: string): void {
    if (this._loggingCb) {
      this._loggingCb("[OCPP] " + msg);
      this.addLogList(msg);
    }
  }

  private addLogList(msg: string): void {
    this._logList.push(msg);
  }

  private setAllConnectorStatus(status: string, msg: string = ""): void {
    setAllConnectorsStatus(status);
    if (this._statusChangeCb) {
      this._statusChangeCb(status, msg);
      console.log("Status: " + status + " (" + msg + ")");
    }
    if (this._connectorStatusChangeCbs) {
      for (let i = 1; i <= this.connectorNumber; i++) {
        this._connectorStatusChangeCbs.get(i)?.(status);
      }
    }
  }

  setTransactionID(connectorId: number, transactionId: number): void {
    if (this._connectorTransactionIDChangeCbs) {
      this._connectorTransactionIDChangeCbs.get(connectorId)?.(transactionId);
    }
  }

  wsConnect(): void {
    const url = this.wsURL;
    const cpid = this.cpid;
    if (this._websocket) {
      this.setAllConnectorStatus(
        localocpp.OCPPStatus.Faulted,
        "Socket already opened. Closing it. Retry later"
      );
      this._websocket.close(3001);
    } else {
      this._websocket = new WebSocket(url + cpid, ["ocpp1.6", "ocpp1.5"]);

      this._websocket.onopen = () => {
        this.setAllConnectorStatus(localocpp.OCPPStatus.Available);
        this.sendBootNotification();
        this.sendAllConnectorsStatusNotification(localocpp.CONN_AVAILABLE);
      };

      this._websocket.onerror = (evt: Event) => {
        this.setAllConnectorStatus(localocpp.OCPPStatus.Faulted, "WebSocket error: " + evt.type);
      };

      this._websocket.onmessage = (msg: MessageEvent) => {
        console.log("RECEIVE: " + msg.data);
        const data = JSON.parse(msg.data);
        switch (data[0]) {
          case OCPPMessageType.CALL: // CALL
            this.handleCallRequest(data[1], data[2], data[3]);
            break;
          case OCPPMessageType.CALL_RESULT: // CALLRESULT
            this.handleCallResult(data[2]);
            break;
          case OCPPMessageType.CALL_ERROR: // CALLERROR
            this.handleCallError(data[2], data[3]);
            break;
        }
      };

      this._websocket.onclose = (evt: CloseEvent) => {
        if (evt.code === 3001) {
          this.setAllConnectorStatus(localocpp.OCPPStatus.Unavailable);
          this.logMsg("Connection closed");
        } else {
          this.setAllConnectorStatus(localocpp.OCPPStatus.Faulted, "Connection error: " + evt.code + " (" + evt.reason + ")");
        }
        this._websocket = null;
      };
    }
  }

  wsDisconnect(): void {
    if (this._websocket) {
      this._websocket.close(3001);
    }
    this.setAllConnectorStatus(localocpp.OCPPStatus.Unavailable);
  }

  private wsSendData(data: string): void {
    console.log("SEND: " + data);
    if (this._websocket) {
      this._websocket.send(data);
    } else {
      this.setAllConnectorStatus(localocpp.OCPPStatus.Faulted, "No connection to OCPP server");
    }
  }

  authorize(tagId: string): void {
    this.setLastAction("Authorize");
    this.logMsg("Requesting authorization for tag " + tagId);
    const id = this.generateId();
    const Auth = JSON.stringify([
      2,
      id,
      "Authorize",
      {
        idTag: tagId,
      },
    ]);
    this.wsSendData(Auth);
  }

  startTransaction(
    tagId: string,
    connectorId: number,
    reservationId: number = 0
  ): void {
    this.setLastAction("startTransaction");
    this.setConnectorStatus(connectorId, localocpp.OCPPStatus.Charging);
    const id = this.generateId();
    setTransaction(connectorId, {
      id: null,
      tagId: tagId,
      connectorId: connectorId,
      meterStart: this.meterValue(connectorId),
      startTime: this.formatDate(new Date()),
      stopTime: null,
    })
    const mv = this.meterValue(connectorId);
    this._lastRequest =
      {
        type: OCPPMessageType.CALL,
        action: OCPPAction.StartTransaction,
        tagId: tagId,
        id: id,
        payload: {
          connectorId: connectorId,
          idTag: tagId,
          reservationId: reservationId,
          meterStart: mv,
          timestamp: this.formatDate(new Date()),
        } as StartTransactionRequest
      }
    const strtT = JSON.stringify([
      this._lastRequest.type,
      this._lastRequest.id,
      this._lastRequest.action,
      this._lastRequest.payload
    ]);
    this.logMsg(
      "Starting Transaction for tag " +
      tagId +
      " (connector:" +
      connectorId +
      ", meter value=" +
      mv +
      ")"
    );
    this.wsSendData(strtT);
    this.setConnectorStatus(connectorId, localocpp.CONN_CHARGING);
  }

  stopTransaction(tagId: string): void {
    const transactionId = getTransactionByTagId(tagId)?.id || null;
    if (!transactionId) {
      throw new Error("Transaction not found");
    }
    this.stopTransactionWithId(transactionId, tagId);
  }

  private stopTransactionWithId(
    transactionId: number,
    tagId: string = "DEADBEEF"
  ): void {
    this.setLastAction("stopTransaction");
    const transaction = getTransactionByTransactionId(transactionId)
    if (!transaction) {
      throw new Error("Transaction not found");
    }
    const connector = getConnector(transaction.connectorId);
    if (!connector) {
      throw new Error("Connector not found");
    }
    const mv = this.meterValue(connector.id);
    this.logMsg(
      "Stopping Transaction with id " +
      transactionId +
      " (meterValue=" +
      mv +
      ")"
    );
    const id = this.generateId();
    this._lastRequest = {
      type: OCPPMessageType.CALL,
      action: OCPPAction.StopTransaction,
      tagId: tagId,
      id: id,
      payload: {
        transactionId: Number(transactionId),
        timestamp: this.formatDate(new Date()),
        meterStop: Number(mv),
        idTag: tagId,
      } as StopTransactionRequest
    }
    const stpT = JSON.stringify([
      this._lastRequest.type,
      this._lastRequest.id,
      this._lastRequest.action,
      this._lastRequest.payload
    ]);
    this.wsSendData(stpT);
    this.setConnectorStatus(connector.id, localocpp.CONN_AVAILABLE);
  }

  sendHeartbeat(): void {
    this.setLastAction("Heartbeat");
    const id = this.generateId();
    const HB = JSON.stringify([2, id, "Heartbeat", {}]);
    this.logMsg("Heartbeat");
    this.wsSendData(HB);
  }

  startHeartbeat(period: number): void {
    this.setHeartbeat(period);
  }

  stopHeartbeat(): void {
    if (this._heartbeat) {
      console.log("Stopping heartbeat");
      clearInterval(this._heartbeat);
    }
  }

  sendMeterValue(connectorId: number): void {
    this.setLastAction("MeterValues");
    const meter = getMeterValue(connectorId);
    const id = this.generateId();
    const ssid = getTransaction(connectorId).id;
    const mvreq = JSON.stringify([
      2,
      id,
      "MeterValues",
      {
        connectorId: connectorId,
        transactionId: Number(ssid),
        meterValue: [
          {
            timestamp: this.formatDate(new Date()),
            sampledValue: [{value: meter.toString()}],
          },
        ],
      },
    ]);
    this.logMsg(
      "Send Meter Values: " + meter + " (connector " + connectorId + ")"
    );
    this.wsSendData(mvreq);
  }

  setConnectorStatus(
    connectorId: number,
    newStatus: string,
    updateServer: boolean = false
  ): void {
    setConnectorStatus(connectorId, newStatus);
    if (this._connectorStatusChangeCbs) {
      this._connectorStatusChangeCbs.get(connectorId)?.(newStatus);
    }
    if (updateServer) {
      this.sendStatusNotification(connectorId, newStatus);
    }
  }

  connectorStatus(connectorId: number): string {
    return getConnector(connectorId)?.status || localocpp.OCPPStatus.Unavailable;
  }

  availability(connectorId: number = 0): string {
    return getConnector(connectorId)?.availability || localocpp.AVAILABITY_INOPERATIVE
  }

  setConnectorAvailability(connectorId: number, newAvailability: string): void {
    setConnectorStatus(connectorId, newAvailability);
    if (newAvailability === localocpp.AVAILABITY_INOPERATIVE) {
      this.setConnectorStatus(connectorId, localocpp.CONN_UNAVAILABLE, true);
    } else if (newAvailability === localocpp.AVAILABITY_OPERATIVE) {
      this.setConnectorStatus(connectorId, localocpp.CONN_AVAILABLE, true);
    }
    if (this._availabilityChangeCbs) {
      this._availabilityChangeCbs.get(connectorId)?.(newAvailability);
    }
    if (connectorId === 0) {
      for (let i = 1; i <= this.connectorNumber; i++) {
        this.setConnectorAvailability(i, newAvailability);
      }
    }
  }

  meterValue(connectorId: number): number {
    return Number(getMeterValue(connectorId));
  }

  setMeterValue(connectorId: number, value: number, updateServer: boolean = false): void {
    setMeterValue(connectorId, value);
    if (updateServer) {
      this.sendMeterValue(connectorId);
    }
  }

  private handleRemoteStartTransaction(payload: RemoteStartTransactionRequest): RemoteStartTransactionResponse {
    const connectorId = payload.connectorId ?? 1;
    this.startTransaction(payload.idTag, connectorId);
    setTransaction(connectorId, {
      id: null,
      tagId: payload.idTag,
      connectorId: connectorId,
      meterStart: this.meterValue(connectorId),
      startTime: this.formatDate(new Date()),
      stopTime: null,
    })
    return {
      status: "Accepted"
    };
  }

  private handleRemoteStopTransaction(payload: RemoteStopTransactionRequest): RemoteStopTransactionResponse {
    this.stopTransactionWithId(payload.transactionId);
    return {
      status: "Accepted",
    };
  }

  private handleGetDiagnostics(payload: GetDiagnosticsRequest): GetDiagnosticsResponse {
    console.log("Received GetDiagnostics request:", payload);
    (async () => {
      const logs = this._logList;
      const blob = new Blob([logs.join("\n")], {type: "text/plain"});
      UploadFile(payload.location, new File([blob], "diagnostics.zip")).then((response) => {
        console.log("Upload response:", response);
      })
    })();

    return {
      fileName: "diagnostics.zip",
    };
  }

  private handleTriggerMessage(payload: TriggerMessageRequest): TriggerMessageResponse {
    const connectorId = payload.connectorId ?? 1;
    switch (payload.requestedMessage) {
      case MessageTrigger.BootNotification:
        this.sendBootNotification();
        break;
      case MessageTrigger.Heartbeat:
        this.sendHeartbeat();
        break;
      case MessageTrigger.StatusNotification:
        this.sendStatusNotification(connectorId, this.connectorStatus(connectorId));
        break;
      default:
        throw new Error("Unsupported message");
    }
    return {
      status: "Accepted",
    };
  }


  private handleCallRequest(
    id: string,
    action: string,
    payload: RemoteStartTransactionRequest | RemoteStopTransactionRequest | GetDiagnosticsRequest | OCPPTriggerMessageRequest
  ): void {
    let responsePayload: RemoteStopTransactionResponse | GetDiagnosticsResponse | OCPPTriggerMessageResponse;
    console.log("Received action:", action, payload);
    switch (action) {
      case OCPPAction.REMOTE_START_TRANSACTION:
        responsePayload = this.handleRemoteStartTransaction(payload as RemoteStartTransactionRequest);
        break;
      case OCPPAction.REMOTE_STOP_TRANSACTION:
        responsePayload = this.handleRemoteStopTransaction(payload as RemoteStopTransactionRequest);
        break;
      case OCPPAction.GET_DIAGNOSTICS:
        responsePayload = this.handleGetDiagnostics(payload as OCPPGetDiagnosticsRequest);
        break;
      case OCPPAction.TRIGGER_MESSAGE:
        responsePayload = this.handleTriggerMessage(payload as OCPPTriggerMessageRequest);
        break;
      default:
        throw new Error("Unsupported action");
    }
    const responseMessage = [OCPPMessageType.CALL_RESULT, id, responsePayload];
    console.log("Send response:", JSON.stringify(responseMessage));

  }

  private handleBlockTag(): void {
    const t = getLatestTransaction()
    if (t) {
      this.setTransactionID(t.connectorId, 0);
      setTransaction(t.connectorId, null);
      this.setAllConnectorStatus(localocpp.OCPPStatus.Faulted + " (Tag blocked)");
    }
    throw new Error("Tag is blocked");
  }

  private handleStartTransaction(payload: StartTransactionResponse): void {
    this.logMsg("Received StartTransaction: " + JSON.stringify(payload));
    if (payload.idTagInfo && payload.idTagInfo.status === "Blocked") {
      this.handleBlockTag();
    }
    const t = getLatestTransaction()
    if (t) {
      this.setTransactionID(t.connectorId, payload.transactionId);
      setTransaction(t.connectorId, {...t, id: payload.transactionId})
    } else {
      throw new Error("Transaction not found")
    }
  }

  private handleStopTransaction(payload: StopTransactionResponse): void {
    this.logMsg("Received StopTransaction: " + JSON.stringify(payload));
    if (payload.idTagInfo && payload.idTagInfo.status === "Blocked") {
      this.handleBlockTag();
    }
    const t = getLatestTransaction()
    if (t) {
      this.setTransactionID(t.connectorId, 0);
      setTransaction(t.connectorId, null);
      this.setAllConnectorStatus(localocpp.OCPPStatus.Available);
    } else {
      throw new Error("Transaction not found")
    }
  }

  private handleCallResult(
    payload: StartTransactionResponse | StopTransactionResponse | TriggerMessageResponse | MeterValuesResponse
  ): void {
    console.log("Received CallResult: " + JSON.stringify(payload));
    if(!this._lastRequest) {
      return;
    }
    switch (this._lastRequest?.action) {
      case OCPPAction.StartTransaction:
        this.handleStartTransaction(payload as StartTransactionResponse);
        break;
      case OCPPAction.StopTransaction:
        this.handleStopTransaction(payload as StopTransactionResponse);
        break;
      case OCPPAction.TRIGGER_MESSAGE:
        console.log("TriggerMessageResponse:", payload as TriggerMessageResponse);
        break;
      default:
        throw new Error("Unsupported action: "+this._lastRequest?.action);
    }
  }

  private handleCallError(errCode: string, errMsg: string): void {
    this.logMsg("Received CallError: " + errCode + " (" + errMsg + ")");
    this.setAllConnectorStatus(
      localocpp.OCPPStatus.Faulted,
      "ErrorCode: " + errCode + " (" + errMsg + ")"
    );
  }

  private sendBootNotification(): void {
    this.logMsg("Sending BootNotification");
    this.setLastAction("BootNotification");
    const id = this.generateId();
    const bn_req = [
      2,
      id,
      "BootNotification",
      {
        chargePointVendor: "Elmo",
        chargePointModel: "Elmo-Virtual1",
        chargePointSerialNumber: "elm.001.13.1",
        chargeBoxSerialNumber: "elm.001.13.1.01",
        firmwareVersion: "0.9.87",
        iccid: "",
        imsi: "",
        meterType: "ELM NQC-ACDC",
        meterSerialNumber: "elm.001.13.1.01",
      } as BootNotificationRequest,
    ]
    this.wsSendData(JSON.stringify(bn_req));
  }

  private setLastAction(action: string): void {
    sessionStorage.setItem("LastAction", action);
  }

  private setHeartbeat(period: number): void {
    this.logMsg("Setting heartbeat period to " + period + "s");
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
    }
    this._heartbeat = setInterval(() => this.sendHeartbeat(), period * 1000);
  }

  private sendAllConnectorsStatusNotification(status: string): void {
    for (let i = 1; i <= this.connectorNumber; i++) {
      this.sendStatusNotification(i, status);
    }
  }

  private sendStatusNotification(connectorId: number, status: string): void {
    this.setLastAction("StatusNotification");
    const id = this.generateId();
    const sn_req = JSON.stringify([
      2,
      id,
      "StatusNotification",
      {
        connectorId: connectorId,
        status: status,
        errorCode: "NoError",
        info: "",
        timestamp: this.formatDate(new Date()),
        vendorId: "",
        vendorErrorCode: "",
      },
    ]);
    this.logMsg(
      "Sending StatusNotification for connector " + connectorId + ": " + status
    );
    this.wsSendData(sn_req);
  }

  private formatDate(date: Date): string {
    return date.toISOString();
  }

  private generateId(): string {
    return (
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    );
  }

  public statusNotification(connectorId: number, status: string): void {
    this.setLastAction("StatusNotification");
    const id = this.generateId();
    const sn_req = JSON.stringify([
      2,
      id,
      "StatusNotification",
      {
        connectorId: connectorId,
        status: status,
        errorCode: "NoError",
        info: "",
        timestamp: this.formatDate(new Date()),
        vendorId: "",
        vendorErrorCode: "",
      },
    ]);
    this.logMsg(
      "Sending StatusNotification for connector " + connectorId + ": " + status
    );
    this.wsSendData(sn_req);
  }

}
