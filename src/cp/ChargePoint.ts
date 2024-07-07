import {Connector} from './Connector';
import {OCPPWebSocket} from './OCPPWebSocket';
import {OCPPMessageHandler} from './OCPPMessageHandler';
import {Logger} from './Logger';
import {OCPPStatus, AVAILABITY_OPERATIVE, AVAILABITY_INOPERATIVE} from './ocpp_constants';
import {Transaction} from "./Transaction.ts";

export class ChargePoint {
  private _id: string;
  private _connectors: Map<number, Connector>;
  private _webSocket: OCPPWebSocket;
  private _messageHandler: OCPPMessageHandler;
  private _logger: Logger;

  private _status: OCPPStatus = OCPPStatus.Unavailable;
  private _error: string = "";

  private _heartbeat: number | null = null;
  private _statusChangeCallback: ((status: string, message?: string) => void) | null = null;
  private _availabilityChangeCallbacks: Map<number, ((availability: string) => void)> = new Map();

  constructor(id: string, connectorCount: number, wsUrl: string) {
    this._id = id;
    this._connectors = new Map();
    for (let i = 1; i <= connectorCount; i++) {
      this._connectors.set(i, new Connector(i));
    }
    this._logger = new Logger();
    this._webSocket = new OCPPWebSocket(wsUrl, this._id, this._logger);
    this._messageHandler = new OCPPMessageHandler(this, this._webSocket, this._logger);
  }

  // Getters
  get id(): string {
    return this._id;
  }

  get connectors(): Map<number, Connector> {
    return new Map(this._connectors);
  }

  // Setters and getters for callbacks
  set statusChangeCallback(callback: (status: string, message?: string) => void) {
    this._statusChangeCallback = callback;
  }

  set loggingCallback(callback: (message: string) => void) {
    this._logger.loggingCallback = callback;
  }

  setConnectorTransactionIDChangeCallback(connectorId: number, callback: (transactionId: number | null) => void): void {
    this.connectors.get(connectorId)?.setTransactionIDChangeCallbacks(callback);
  }

  setConnectorStatusChangeCallback(connectorId: number, callback: (status: string) => void): void {
    this.connectors.get(connectorId)?.setStatusChangeCallbacks(callback);
  }

  setAvailabilityChangeCallback(connectorId: number, callback: (availability: string) => void): void {
    this._availabilityChangeCallbacks.set(connectorId, callback);
  }

  public connect(): void {
    this._webSocket.connect(
      () => {
        this._messageHandler.sendBootNotification()
        this.updateStatus(OCPPStatus.Available);
        this.updateAllConnectorsStatus(OCPPStatus.Available);
      },
      (msg: MessageEvent, ev: CloseEvent) => {
        this.updateStatus(OCPPStatus.Unavailable);
        this.updateAllConnectorsStatus(OCPPStatus.Unavailable);
        this._logger.error(`WebSocket closed code: ${msg.code} reason: ${msg.reason}`);
      }
    );
  }

  public disconnect(): void {
    this._logger.info("Disconnecting from WebSocket");
    this._webSocket.disconnect();
  }

  public authorize(tagId: string): void {
    this._messageHandler.authorize(tagId);
  }

  public updateStatus(status: OCPPStatus): void {
    this._status = status;
    this.triggerStatusChangeCallback(status);
  }

  public startTransaction(tagId: string, connectorId: number): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      const transaction: Transaction = {
        id: 0,
        connectorId: connectorId,
        tagId: tagId,
        startTime: new Date(),
        stopTime: null,
        meterStart: 0,
      }
      connector.transaction = transaction;
      this._messageHandler.startTransaction(transaction, connectorId);
      this.updateConnectorStatus(connectorId, OCPPStatus.Charging);
    } else {
      this._logger.error(`Connector ${connectorId} not found`);
    }
  }

  public stopTransaction(tagId: number, connectorId: number): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      connector.transaction.stopTime = new Date();
      connector.transaction.meterStop = connector.meterValue;
      this._messageHandler.stopTransaction(connector.transaction, connector.id);
      this.updateConnectorStatus(connector.id, OCPPStatus.Available);
    } else {
      this._logger.error(`Transaction for tag ${tagId} not found`);
    }
  }

  public sendHeartbeat(): void {
    this._messageHandler.sendHeartbeat();
  }

  public startHeartbeat(period: number): void {
    this._logger.info("Setting heartbeat period to " + period + "s");
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
    }
    this._heartbeat = setInterval(() => this.sendHeartbeat(), period * 1000);
  }

  public stopHeartbeat(): void {
    this._logger.info("Stopping heartbeat");
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
    }
  }

  public setMeterValue(connectorId: number, meterValue: number): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      connector.meterValue = meterValue;
    } else {
      this._logger.error(`Connector ${connectorId} not found`);
    }
  }

  public sendMeterValue(connectorId: number): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      this._messageHandler.sendMeterValue(connectorId, connector.meterValue);
    } else {
      this._logger.error(`Connector ${connectorId} not found`);
    }
  }

  public getConnector(connectorId: number): Connector | undefined {
    return this._connectors.get(connectorId);
  }


  public updateAllConnectorsStatus(newStatus: OCPPStatus): void {
    this._connectors.forEach((connector) => {
      connector.status = newStatus;
      this.connectors.forEach((connector) => {
        connector.status = newStatus;
      })
      this._messageHandler.sendStatusNotification(connector.id, newStatus);
    });
  }

  public updateConnectorStatus(connectorId: number, newStatus: OCPPStatus): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      connector.status = newStatus;
      this._messageHandler.sendStatusNotification(connectorId, newStatus);
      this.triggerConnectorStatusChangeCallback(connectorId, newStatus);
    } else {
      this._logger.error(`Connector ${connectorId} not found`);
    }
  }

  public updateConnectorAvailability(connectorId: number, newAvailability: string): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      connector.availability = newAvailability;
      if (newAvailability === AVAILABITY_INOPERATIVE) {
        this.updateConnectorStatus(connectorId, OCPPStatus.Unavailable);
      } else if (newAvailability === AVAILABITY_OPERATIVE) {
        this.updateConnectorStatus(connectorId, OCPPStatus.Available);
      }
      this.triggerAvailabilityChangeCallback(connectorId, newAvailability);
    } else {
      this._logger.error(`Connector ${connectorId} not found`);
    }
  }

  public setTransactionID(connectorId: number, transactionId: number): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      connector.setTransactionId(transactionId);
      this.triggerConnectorTransactionIDChangeCallback(connectorId, transactionId);
    } else {
      this._logger.error(`Connector ${connectorId} not found`);
    }
  }

  private triggerStatusChangeCallback(status: string, message?: string): void {
    if (this._statusChangeCallback) {
      this._statusChangeCallback(status, message);
    }
  }

  private triggerConnectorTransactionIDChangeCallback(connectorId: number, transactionId: number): void {
    const callback = this.connectors.get(connectorId)?.triggerTransactionIDChangeCallback;
    if (callback) {
      callback(transactionId);
    }
  }

  private triggerConnectorStatusChangeCallback(connectorId: number, status: string): void {
    const callback = this.connectors.get(connectorId)?.triggerStatusChangeCallback;
    if (callback) {
      callback(status);
    }
  }

  private triggerAvailabilityChangeCallback(connectorId: number, availability: string): void {
    const callback = this._availabilityChangeCallbacks.get(connectorId);
    if (callback) {
      callback(availability);
    }
  }
}
