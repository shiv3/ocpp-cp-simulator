import { Logger, LogType } from "../../shared/Logger";
import { OCPPAction, OCPPErrorCode, OCPPMessageType } from "../../domain/types/OcppTypes";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";

export type OcppMessagePayload =
  | OcppMessageRequestPayload
  | OcppMessageResponsePayload
  | OcppMessageErrorPayload;

export type OcppMessageRequestPayload =
  | request.AuthorizeRequest
  | request.BootNotificationRequest
  | request.HeartbeatRequest
  | request.MeterValuesRequest
  | request.StartTransactionRequest
  | request.StatusNotificationRequest
  | request.StopTransactionRequest;

export type OcppMessageResponsePayload =
  | response.ChangeConfigurationResponse
  | response.GetConfigurationResponse
  | response.GetDiagnosticsResponse
  | response.RemoteStartTransactionResponse
  | response.RemoteStopTransactionResponse
  | response.ResetResponse
  | response.TriggerMessageResponse
  | response.UnlockConnectorResponse;

export type OcppMessageErrorPayload = {
  readonly errorCode: OCPPErrorCode;
  readonly errorDescription: string;
  readonly errorDetails?: object;
};

type MessageHandler = (
  messageType: OCPPMessageType,
  messageId: string,
  action: OCPPAction,
  payload: OcppMessagePayload,
) => void;

export class OCPPWebSocket {
  private _ws: WebSocket | null = null;
  private _url: string;
  private _basicAuth: { username: string; password: string } | null = null;
  private _chargePointId: string;
  private _logger: Logger;
  private _messageHandler: MessageHandler | null = null;
  private _pingInterval: number | null = null;
  private _reconnectAttempts: number = 0;
  private _maxReconnectAttempts: number = Infinity; // Infinite retries
  private _baseReconnectDelay: number = 1000; // 1 second base delay
  private _maxReconnectDelay: number = 30000; // 30 seconds max delay
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _onOpenCallback: (() => void) | null = null;
  private _onCloseCallback: ((ev: CloseEvent) => void) | null = null;
  private _isManualDisconnect: boolean = false;

  constructor(
    url: string,
    chargePointId: string,
    logger: Logger,
    basicAuthSettings: { username: string; password: string } | null = null,
  ) {
    this._url = url;
    this._chargePointId = chargePointId;
    this._logger = logger;
    if (basicAuthSettings) {
      this._basicAuth = {
        username: basicAuthSettings.username,
        password: basicAuthSettings.password,
      };
    }
  }

  get url(): string {
    return this._url;
  }

  public connect(
    onopen: (() => void) | null = null,
    onclose: ((ev: CloseEvent) => void) | null = null,
  ): void {
    // Store callbacks for reconnection
    if (onopen) this._onOpenCallback = onopen;
    if (onclose) this._onCloseCallback = onclose;

    this._isManualDisconnect = false;

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
      this.handleOpen();
      if (this._onOpenCallback) {
        this._onOpenCallback();
      }
    };
    this._ws.onmessage = this.handleMessage.bind(this);
    this._ws.onerror = this.handleError.bind(this);
    this._ws.onclose = (ev: CloseEvent) => {
      this.handleClose(ev);
      if (this._onCloseCallback) {
        this._onCloseCallback(ev);
      }
    };
  }

  public disconnect(): void {
    // Set manual disconnect flag to prevent auto-reconnect
    this._isManualDisconnect = true;

    // Clear reconnect timer to prevent reconnection attempts
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempts = 0;

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
    const message = JSON.stringify([
      OCPPMessageType.CALL,
      messageId,
      action,
      payload,
    ]);
    this.send(message);
  }

  public sendResult(
    messageId: string,
    payload: OcppMessageResponsePayload,
  ): void {
    const message = JSON.stringify([
      OCPPMessageType.CALLRESULT,
      messageId,
      payload,
    ]);
    this.send(message);
  }

  public sendError(messageId: string, payload: OcppMessageErrorPayload): void {
    const message = JSON.stringify([
      OCPPMessageType.CALLERROR,
      messageId,
      payload,
    ]);
    this.send(message);
  }

  private send(message: string): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(message);
      this._logger.info(`Sent: ${message}`, LogType.WEBSOCKET);
    } else {
      this._logger.warn("WebSocket is not connected", LogType.WEBSOCKET);
    }
  }

  public setMessageHandler(handler: MessageHandler): void {
    this._messageHandler = handler;
  }

  private handleOpen(): void {
    this._logger.info("WebSocket connected successfully", LogType.WEBSOCKET);

    // Reset reconnect attempts on successful connection
    if (this._reconnectAttempts > 0) {
      this._logger.info(
        `Reconnection successful after ${this._reconnectAttempts} attempt(s)`,
        LogType.WEBSOCKET
      );
    }
    this._reconnectAttempts = 0;

    // this.startPingInterval();
  }

  private handleMessage(ev: MessageEvent): void {
    this._logger.info(`Received: ${ev.data}`, LogType.WEBSOCKET);
    try {
      const messageArray = JSON.parse(ev.data.toString());

      // Validate message format: must be array with length 3 or 4
      if (!Array.isArray(messageArray) || (messageArray.length !== 3 && messageArray.length !== 4)) {
        this._logger.error("Invalid message format: " + messageArray, LogType.WEBSOCKET);
        return;
      }

      if (this._messageHandler) {
        if (messageArray.length === 3) {
          const [messageType, messageId, payload] = messageArray;
          this._messageHandler(
            messageType,
            messageId,
            OCPPAction.CallResult,
            payload,
          );
        } else if (messageArray.length === 4) {
          const [messageType, messageId, action, payload] = messageArray;
          this._messageHandler(messageType, messageId, action, payload);
        }
      } else {
        this._logger.warn("No message handler set", LogType.WEBSOCKET);
      }
    } catch (error) {
      this._logger.error(`Error parsing message: ${error}`, LogType.WEBSOCKET);
    }
  }

  private handleError(evt: Event): void {
    this._logger.error(`WebSocket error type: ${evt.type}`, LogType.WEBSOCKET);
  }

  private handleClose(ev: CloseEvent): void {
    this._logger.info(
      `WebSocket closed: code=${ev.code}, reason=${ev.reason || "none"}, wasClean=${ev.wasClean}`,
      LogType.WEBSOCKET
    );
    this.stopPingInterval();

    // Only attempt reconnect if not manually disconnected
    if (!this._isManualDisconnect) {
      this.attemptReconnect();
    }
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
    // Clear any existing reconnect timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._reconnectAttempts++;

    // Calculate delay with exponential backoff: baseDelay * 2^(attempts - 1)
    // Example: 1s, 2s, 4s, 8s, 16s, 30s (max)
    const exponentialDelay = this._baseReconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    const delay = Math.min(exponentialDelay, this._maxReconnectDelay);

    this._logger.info(
      `Reconnecting in ${delay / 1000}s... (attempt ${this._reconnectAttempts})`,
      LogType.WEBSOCKET,
    );

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._logger.info(
        `Attempting reconnection (attempt ${this._reconnectAttempts})...`,
        LogType.WEBSOCKET,
      );
      this.connect();
    }, delay);
  }
}
