import {Logger} from "./Logger";
import {OCPPAction, OCPPErrorCode, OCPPMessageType} from "./OcppTypes";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";

export type OcppMessagePayload = OcppMessageRequestPayload | OcppMessageResponsePayload | OcppMessageErrorPayload;

export type OcppMessageRequestPayload =
  | request.AuthorizeRequest
  | request.BootNotificationRequest
  | request.HeartbeatRequest
  | request.MeterValuesRequest
  | request.StartTransactionRequest
  | request.StatusNotificationRequest
  | request.StopTransactionRequest

export type OcppMessageResponsePayload =
  | response.ChangeConfigurationResponse
  | response.GetConfigurationResponse
  | response.GetDiagnosticsResponse
  | response.RemoteStartTransactionResponse
  | response.RemoteStopTransactionResponse
  | response.ResetResponse
  | response.TriggerMessageResponse
  | response.UnlockConnectorResponse

export type OcppMessageErrorPayload = {
  readonly errorCode: OCPPErrorCode;
  readonly errorDescription: string;
  readonly errorDetails?: object;
};

type MessageHandler = (
  messageType: OCPPMessageType,
  messageId: string,
  action: OCPPAction,
  payload: OcppMessagePayload
) => void;

export class OCPPWebSocket {
  private _ws: WebSocket | null = null;
  private _url: string;
  private _basicAuth: {username: string; password: string} | null = null;
  private _chargePointId: string;
  private _logger: Logger;
  private _messageHandler: MessageHandler | null = null;
  private _pingInterval: number | null = null;
  private _reconnectAttempts: number = 0;
  private _maxReconnectAttempts: number = 5;
  private _reconnectDelay: number = 5000; // 5 seconds

  constructor(url: string, chargePointId: string, logger: Logger,
              basicAuthSettings: { username: string; password: string } | null = null) {
    this._url = url;
    this._chargePointId = chargePointId;
    this._logger = logger;
    if (basicAuthSettings) {
      this._basicAuth = {
        username: basicAuthSettings.username,
        password: basicAuthSettings.password
      };
    }
  }

  get url(): string {
    return this._url;
  }

  public connect(
    onopen: (() => void) | null = null,
    onclose: ((ev: CloseEvent) => void) | null = null
  ): void {
    const url = new URL(this._url);
    if (this?._basicAuth) {
      url.username = this._basicAuth.username;
      url.password = this._basicAuth.password;
    }
    console.log("url", url);
    this._ws = new WebSocket(`${url.toString()}${this._chargePointId}`, [
      "ocpp1.6",
      "ocpp1.5",
    ]);
    this._ws.onopen = () => {
      if (onopen) {
        onopen();
      }
      this.handleOpen.bind(this);
    };
    this._ws.onmessage = this.handleMessage.bind(this);
    this._ws.onerror = this.handleError.bind(this);
    this._ws.onclose = (ev: CloseEvent) => {
      if (onclose) {
        onclose(ev);
      }
      this.handleClose.bind(this);
    };
  }

  public disconnect(): void {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  public sendAction(
    messageId: string,
    action: OCPPAction,
    payload: OcppMessageRequestPayload,
  ): void {
    const message = JSON.stringify([OCPPMessageType.CALL, messageId, action, payload]);
    this.send(message);
  }

  public sendResult(
      messageId: string,
      payload: OcppMessageResponsePayload,
  ): void {
    const message = JSON.stringify([OCPPMessageType.CALL_RESULT, messageId, payload]);
    this.send(message);
  }

  public sendError(
      messageId: string,
      payload: OcppMessageErrorPayload,
  ): void {
    const message = JSON.stringify([OCPPMessageType.CALL_ERROR, messageId, payload]);
    this.send(message);
  }

  private send(message: string): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(message);
      this._logger.log(`Sent: ${message}`);
    } else {
      this._logger.log("WebSocket is not connected");
    }
  }

  public setMessageHandler(handler: MessageHandler): void {
    this._messageHandler = handler;
  }

  private handleOpen(): void {
    this._logger.log("WebSocket connected");
    this._reconnectAttempts = 0;

    // this.startPingInterval();
  }

  private handleMessage(ev: MessageEvent): void {
    this._logger.log(`Received: ${JSON.stringify(ev)}`);
    try {
      const messageArray = JSON.parse(ev.data.toString());
      const len = messageArray.length;
      if (!(!Array.isArray(messageArray) || len !== 3 || len !== 4)) {
        this._logger.error("Invalid message format: " + messageArray);
        return;
      }
      if (this._messageHandler) {
        if (len == 3) {
          const [messageType, messageId, payload] = messageArray;
          this._messageHandler(
            messageType,
            messageId,
            OCPPAction.CallResult,
            payload
          );
        }
        if (len == 4) {
          const [messageType, messageId, action, payload] = messageArray;
          this._messageHandler(messageType, messageId, action, payload);
        }
      } else {
        this._logger.log("No message handler set");
      }
    } catch (error) {
      this._logger.log(`Error parsing message: ${error}`);
    }
  }

  private handleError(evt: Event): void {
    this._logger.log(`WebSocket error type: ${evt.type}`);
  }

  private handleClose(msg: MessageEvent): void {
    this._logger.log(`WebSocket closed: ${msg}`);
    this.stopPingInterval();
    this.attemptReconnect();
  }

  // private startPingInterval(): void {
  //   this._pingInterval = setInterval(() => {
  //     if (this._ws && this._ws.readyState === WebSocket.OPEN) {
  //       this._ws.ping();
  //     }
  //   }, 30000); // Send a ping every 30 seconds
  // }

  private stopPingInterval(): void {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this._reconnectAttempts < this._maxReconnectAttempts) {
      this._reconnectAttempts++;
      this._logger.log(
        `Attempting to reconnect (${this._reconnectAttempts}/${this._maxReconnectAttempts})...`
      );
      setTimeout(() => this.connect(), this._reconnectDelay);
    } else {
      this._logger.log(
        "Max reconnect attempts reached. Please check your connection and try again."
      );
    }
  }
}
