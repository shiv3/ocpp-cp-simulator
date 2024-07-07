import { Logger } from "./Logger";
import { OCPPAction, OCPPMessageType } from "./OcppTypes";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";

export type OcppMessagePayload = any;
type MessageHandler = (
  messageType: OCPPMessageType,
  messageId: string,
  action: OCPPAction,
  payload: OcppMessagePayload
) => void;

export class OCPPWebSocket {
  private _ws: WebSocket | null = null;
  private _url: string;
  private _chargePointId: string;
  private _logger: Logger;
  private _messageHandler: MessageHandler | null = null;
  private _pingInterval: number | null = null;
  private _reconnectAttempts: number = 0;
  private _maxReconnectAttempts: number = 5;
  private _reconnectDelay: number = 5000; // 5 seconds

  constructor(url: string, chargePointId: string, logger: Logger) {
    this._url = url;
    this._chargePointId = chargePointId;
    this._logger = logger;
  }

  public connect(
    onopen: (() => void) | null = null,
    onclose: ((ev: CloseEvent) => void) | null = null
  ): void {
    this._ws = new WebSocket(`${this._url}${this._chargePointId}`, [
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

  public send(
    messageType: OCPPMessageType,
    messageId: string,
    action: OCPPAction,
    payload:
      | request.StartTransactionRequest
      | request.StopTransactionRequest
      | request.AuthorizeRequest
      | request.HeartbeatRequest
      | request.MeterValuesRequest
      | request.StatusNotificationRequest
      | request.GetDiagnosticsRequest
      | request.TriggerMessageRequest
      | request.ResetRequest
  ): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      const message = JSON.stringify([messageType, messageId, action, payload]);
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
