import {Connector} from "./Connector";
import {OCPPWebSocket} from "./OCPPWebSocket";
import {OCPPMessageHandler} from "./OCPPMessageHandler";
import {Logger} from "./Logger";
import {OCPPStatus, OCPPAvailability, BootNotification} from "./OcppTypes";
import {Transaction} from "./Transaction.ts";
import * as ocpp from "./OcppTypes.ts";

export class ChargePoint {
  private _id: string;
  private _bootNotification: ocpp.BootNotification;
  private _connectors: Map<number, Connector>;
  private _webSocket: OCPPWebSocket;
  private _messageHandler: OCPPMessageHandler;
  private _logger: Logger;
  private _autoMeterValueSetting: { interval: number; value: number } | null;

  public _status: OCPPStatus = OCPPStatus.Unavailable;
  private _error: string = "";
  public _errorCallback: (error: string) => void = () => {
  };

  private _heartbeat: number | null = null;
  private _autoMeterValueIntervals: Map<number, number> = new Map();

  private _statusChangeCallback:
    | ((status: string, message?: string) => void)
    | null = null;
  private _availabilityChangeCallbacks: Map<
    number,
    (availability: string) => void
  > = new Map();

  constructor(id: string, _bootNotification: BootNotification, connectorCount: number, wsUrl: string,
              autoMeterValueSetting: { interval: number; value: number } | null) {
    this._id = id;
    this._bootNotification = _bootNotification;
    this._connectors = new Map();
    for (let i = 1; i <= connectorCount; i++) {
      this._connectors.set(i, new Connector(i));
    }
    this._logger = new Logger();
    this._webSocket = new OCPPWebSocket(wsUrl, this._id, this._logger);
    this._messageHandler = new OCPPMessageHandler(
      this,
      this._webSocket,
      this._logger
    );
    this._autoMeterValueSetting = autoMeterValueSetting;
  }

  // Getters
  get id(): string {
    return this._id;
  }

  get status(): OCPPStatus {
    return this._status;
  }

  get connectorNumber(): number {
    return this._connectors.size;
  }

  get wsUrl(): string {
    return this._webSocket.url;
  }

  get error(): string {
    return this._error;
  }

  set error(error: string) {
    this._error = error;
    this._errorCallback(error);
  }

  set errorCallback(callback: (error: string) => void) {
    this._errorCallback = callback;
  }

  get connectors(): Map<number, Connector> {
    return new Map(this._connectors);
  }

  // Setters and getters for callbacks
  set statusChangeCallback(
    callback: (status: string, message?: string) => void
  ) {
    this._statusChangeCallback = callback;
  }

  set loggingCallback(callback: (message: string) => void) {
    this._logger._loggingCallback = callback;
  }

  setConnectorTransactionIDChangeCallback(
    connectorId: number,
    callback: (transactionId: number | null) => void
  ): void {
    this.connectors.get(connectorId)?.setTransactionIDChangeCallbacks(callback);
  }

  setConnectorStatusChangeCallback(
    connectorId: number,
    callback: (status: ocpp.OCPPStatus) => void
  ): void {
    this.connectors.get(connectorId)?.setStatusChangeCallbacks(callback);
  }

  setConnectorMeterValueChangeCallback(
    connectorId: number,
    callback: (meterValue: number) => void
  ): void {
    this.connectors.get(connectorId)?.setMeterValueChangeCallbacks(callback);
  }

  setAvailabilityChangeCallback(
    connectorId: number,
    callback: (availability: string) => void
  ): void {
    this._availabilityChangeCallbacks.set(connectorId, callback);
  }

  public connect(): void {
    this._webSocket.connect(
      () => {
        this._messageHandler.sendBootNotification(this._bootNotification);
        this.status = OCPPStatus.Available;
        this.updateAllConnectorsStatus(OCPPStatus.Available);
        this.error = "";
      },
      (ev: CloseEvent) => {
        this.status = OCPPStatus.Unavailable;
        this.updateAllConnectorsStatus(OCPPStatus.Unavailable);
        this._logger.error(
          `WebSocket closed code: ${ev.code} reason: ${ev.reason}`
        );
        if (ev.code !== 1005) {
          this.error = `WebSocket closed code: ${ev.code} reason: ${ev.reason}`;
        }
      }
    );
  }

  public disconnect(): void {
    this._logger.info("Disconnecting from WebSocket");
    this._status = OCPPStatus.Unavailable;
    this._webSocket.disconnect();
  }

  public authorize(tagId: string): void {
    this._messageHandler.authorize(tagId);
  }

  set status(status: OCPPStatus) {
    this._status = status;
    if (this._statusChangeCallback) {
      this._statusChangeCallback(status);
    }
  }

  public startTransaction(tagId: string, connectorId: number): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      const transaction: Transaction = {
        id: 0,
        connectorId: connectorId,
        tagId: tagId,
        meterStart: 0,
        meterStop: null,
        startTime: new Date(),
        stopTime: null,
      };
      connector.transaction = transaction;
      this._messageHandler.startTransaction(transaction, connectorId);
      this.updateConnectorStatus(connectorId, OCPPStatus.Preparing);
      this._autoMeterValueSetting && this.startAutoMeterValue(connectorId, this._autoMeterValueSetting.interval, this._autoMeterValueSetting.value);

    } else {
      this._logger.error(`Connector ${connectorId} not found`);
    }
  }

  public stopTransaction(tagId: string, connectorId: number): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      connector.transaction!.stopTime = new Date();
      connector.transaction!.meterStop = connector.meterValue;
      this._messageHandler.stopTransaction(
        connector.transaction!,
        connector.id
      );
      this.updateConnectorStatus(connector.id, OCPPStatus.Finishing);
      this._autoMeterValueSetting && this.stopAutoMeterValue(connectorId);
    } else {
      this._logger.error(`Transaction for tag ${tagId} not found`);
    }
  }

  public sendHeartbeat(): void {
    this._messageHandler.sendHeartbeat();
  }

  public sendReset(): void {
    this._messageHandler.sendReset();
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

  public startAutoMeterValue(connectorId: number, intervalSec: number, value: number): void {
    const intervalNum = setInterval(() => {
      this.setMeterValue(connectorId, this.getConnector(connectorId)!.meterValue + value);
      this.sendMeterValue(connectorId);
    }, intervalSec * 1000);
    this._autoMeterValueIntervals.set(connectorId, intervalNum);
  }

  public stopAutoMeterValue(connectorId: number): void {
    const intervalNum = this._autoMeterValueIntervals.get(connectorId);
    if (intervalNum) {
      clearInterval(intervalNum);
      this._autoMeterValueIntervals.delete(connectorId);
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
      });
      this._messageHandler.sendStatusNotification(connector.id, newStatus);
    });
  }

  public updateConnectorStatus(
    connectorId: number,
    newStatus: OCPPStatus
  ): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      connector.status = newStatus;
      this._messageHandler.sendStatusNotification(connectorId, newStatus);
    } else {
      this._logger.error(`Connector ${connectorId} not found`);
    }
  }

  public updateConnectorAvailability(
    connectorId: number,
    newAvailability: string
  ): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      connector.availability! = newAvailability;
      if (newAvailability === OCPPAvailability.Inoperative) {
        this.updateConnectorStatus(connectorId, OCPPStatus.Unavailable);
      } else if (newAvailability === OCPPAvailability.Operative) {
        this.updateConnectorStatus(connectorId, OCPPStatus.Available);
      }
      const callback = this._availabilityChangeCallbacks.get(connectorId);
      if (callback) {
        callback(newAvailability);
      }
    } else {
      this._logger.error(`Connector ${connectorId} not found`);
    }
  }

  public setTransactionID(connectorId: number, transactionId: number): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      connector.transactionId = transactionId;
    } else {
      this._logger.error(`Connector ${connectorId} not found`);
    }
  }
}
