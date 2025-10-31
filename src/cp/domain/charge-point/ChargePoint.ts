import { EventEmitter } from "../../shared/EventEmitter";
import { Logger, LogType } from "../../shared/Logger";
import { HeartbeatService } from "../../application/services/HeartbeatService";
import { StateManager } from "../../application/services/StateManager";
import { Connector } from "../connector/Connector";
import type { ChargePointEvents } from "./ChargePointEvents";
import { OCPPMessageHandler } from "../../infrastructure/transport/OCPPMessageHandler";
import { OCPPWebSocket } from "../../infrastructure/transport/OCPPWebSocket";
import { BootNotification, OCPPStatus } from "../types/OcppTypes";
import type { Transaction } from "../connector/Transaction";

interface BasicAuthSettings {
  username: string;
  password: string;
}

export interface AutoMeterValueSetting {
  enabled: boolean;
  interval: number;
  value: number;
}

export class ChargePoint {
  private readonly _connectors: Map<number, Connector> = new Map();
  private readonly _logger = new Logger();
  private readonly _events = new EventEmitter<ChargePointEvents>();
  private readonly _webSocket: OCPPWebSocket;
  private readonly _messageHandler: OCPPMessageHandler;
  private readonly _heartbeat: HeartbeatService;
  private readonly _stateManager: StateManager;

  private _status: OCPPStatus = OCPPStatus.Unavailable;
  private _error = "";
  private _autoMeterValueSetting: AutoMeterValueSetting | null;

  constructor(
    private readonly _id: string,
    private readonly _bootNotification: BootNotification,
    connectorCount: number,
    wsUrl: string,
    basicAuthSettings: BasicAuthSettings | null,
    autoMeterValueSetting: AutoMeterValueSetting | null,
  ) {
    this._autoMeterValueSetting = autoMeterValueSetting;

    for (let connectorId = 1; connectorId <= connectorCount; connectorId++) {
      const connector = new Connector(connectorId, this._logger);
      if (autoMeterValueSetting?.enabled) {
        connector.setIncrementFallback({
          intervalSeconds: autoMeterValueSetting.interval,
          incrementValue: autoMeterValueSetting.value,
        });
      }
      this._connectors.set(connectorId, connector);
    }

    this._webSocket = new OCPPWebSocket(wsUrl, this._id, this._logger, basicAuthSettings);
    this._messageHandler = new OCPPMessageHandler(this, this._webSocket, this._logger);

    this._heartbeat = new HeartbeatService(this._logger);
    this._heartbeat.setHeartbeatCallback(() => this._messageHandler.sendHeartbeat());

    this._stateManager = new StateManager(
      this._logger,
      this._events,
      () => ({ status: this._status, error: this._error }),
      (connectorId) => {
        const connector = this._connectors.get(connectorId);
        if (!connector) return undefined;
        return {
          status: connector.status,
          availability: connector.availability,
          transaction: connector.transaction,
          meterValue: connector.meterValue,
        };
      },
    );

    this._connectors.forEach((connector, connectorId) => {
      this._stateManager.initializeConnector(
        connectorId,
        connector.status,
        connector.availability,
      );
    });
  }

  get autoMeterValueSetting(): AutoMeterValueSetting | null {
    return this._autoMeterValueSetting;
  }

  set autoMeterValueSetting(setting: AutoMeterValueSetting | null) {
    this._autoMeterValueSetting = setting;
    this._connectors.forEach((connector) => {
      connector.setIncrementFallback(
        setting?.enabled
          ? {
              intervalSeconds: setting.interval,
              incrementValue: setting.value,
            }
          : null,
      );
    });
  }

  get id(): string {
    return this._id;
  }

  get status(): OCPPStatus {
    return this._status;
  }

  get connectorNumber(): number {
    return this._connectors.size;
  }

  get connectors(): Map<number, Connector> {
    return new Map(this._connectors);
  }

  get wsUrl(): string {
    return this._webSocket.url;
  }

  get error(): string {
    return this._error;
  }

  set error(value: string) {
    this._error = value;
    this._events.emit("error", { error: value });
  }

  get events(): EventEmitter<ChargePointEvents> {
    return this._events;
  }

  get stateManager(): StateManager {
    return this._stateManager;
  }

  get logger(): Logger {
    return this._logger;
  }

  set loggingCallback(callback: (message: string) => void) {
    this._logger._loggingCallback = callback;
  }

  connect(): void {
    this._webSocket.connect(
      () => {
        this.boot();
        this._events.emit("connected", undefined);
      },
      (ev: CloseEvent) => {
        this.status = OCPPStatus.Unavailable;
        this.updateAllConnectorsStatus(OCPPStatus.Unavailable);
        this._logger.error(
          `WebSocket closed code: ${ev.code} reason: ${ev.reason}`,
          LogType.WEBSOCKET,
        );
        this._events.emit("disconnected", { code: ev.code, reason: ev.reason });
        if (ev.code !== 1005) {
          this.error = `WebSocket closed code: ${ev.code} reason: ${ev.reason}`;
        }
      },
    );
  }

  boot(): void {
    this._messageHandler.sendBootNotification(this._bootNotification);
    this.status = OCPPStatus.Available;
    this.updateAllConnectorsStatus(OCPPStatus.Available);
    this.error = "";
  }

  disconnect(): void {
    this._logger.info("Disconnecting from WebSocket", LogType.WEBSOCKET);
    this.status = OCPPStatus.Unavailable;
    this._heartbeat.cleanup();
    this._connectors.forEach((connector) => connector.cleanup());
    this._webSocket.disconnect();
  }

  reset(): void {
    this.disconnect();
    this.connect();
  }

  authorize(tagId: string): void {
    this._messageHandler.authorize(tagId);
  }

  set status(newStatus: OCPPStatus) {
    this._status = newStatus;
    if (newStatus === OCPPStatus.Unavailable) {
      this._connectors.forEach((connector) => {
        connector.status = OCPPStatus.Unavailable;
      });
    }
    this._events.emit("statusChange", { status: newStatus });
    this._stateManager.transitionChargePointStatus(newStatus, {
      source: "boundary-setter",
      timestamp: new Date(),
    });
  }

  startTransaction(tagId: string, connectorId: number): void {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(`Connector ${connectorId} not found`, LogType.TRANSACTION);
      return;
    }

    const transaction: Transaction = {
      id: 0,
      connectorId,
      tagId,
      meterStart: connector.meterValue,
      meterStop: null,
      startTime: new Date(),
      stopTime: null,
      meterSent: false,
    };

    connector.beginTransaction(transaction);
    this._messageHandler.startTransaction(transaction, connectorId);
    this.updateConnectorStatus(connectorId, OCPPStatus.Preparing);

    this._events.emit("transactionStarted", {
      connectorId,
      transactionId: 0,
      tagId,
    });
  }

  stopTransaction(connectorOrId: number | Connector): void {
    const connector =
      typeof connectorOrId === "number"
        ? this.getConnector(connectorOrId)
        : connectorOrId;
    if (!connector) {
      const connId = typeof connectorOrId === "number" ? connectorOrId : connectorOrId.id;
      this._logger.error(`Connector ${connId} not found`, LogType.TRANSACTION);
      return;
    }

    const transaction = connector.transaction;
    if (!transaction) {
      this._logger.warn(
        `No active transaction for connector ${connector.id} when stopping`,
        LogType.TRANSACTION,
      );
      return;
    }

    connector.stopAutoMeterValue();
    transaction.stopTime = new Date();
    transaction.meterStop = connector.meterValue;

    this._messageHandler.stopTransaction(transaction, connector.id);

    this._events.emit("transactionStopped", {
      connectorId: connector.id,
      transactionId: transaction.id ?? 0,
    });

    this.cleanTransaction(connector);
    connector.stopTransaction();
    this.updateConnectorStatus(connector.id, OCPPStatus.Available);
  }

  cleanTransaction(connectorOrId: Connector | number): void {
    const connector =
      typeof connectorOrId === "number"
        ? this.getConnector(connectorOrId)
        : connectorOrId;
    if (!connector) return;

    const transaction = connector.transaction;
    if (transaction) {
      transaction.meterSent = false;
      transaction.stopTime = new Date();
      transaction.meterStop = connector.meterValue;

      // Emit Finishing state for scenarios that rely on the transitional status
      this.updateConnectorStatus(connector.id, OCPPStatus.Finishing);
    }

    connector.stopAutoMeterValue();
  }

  startHeartbeat(period: number): void {
    this._heartbeat.startHeartbeat(period);
  }

  stopHeartbeat(): void {
    this._heartbeat.stopHeartbeat();
  }

  sendHeartbeat(): void {
    this._heartbeat.sendHeartbeat();
  }

  setMeterValue(connectorId: number, value: number): void {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(`Connector ${connectorId} not found`, LogType.METER_VALUE);
      return;
    }
    connector.meterValue = value;
  }

  sendMeterValue(connectorId: number): void {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(`Connector ${connectorId} not found`, LogType.METER_VALUE);
      return;
    }
    this._messageHandler.sendMeterValue(
      connector.transaction?.id ?? undefined,
      connectorId,
      connector.meterValue,
    );
  }

  getConnector(connectorId: number): Connector | undefined {
    return this._connectors.get(connectorId);
  }

  removeConnector(connectorId: number): boolean {
    const connector = this._connectors.get(connectorId);
    if (!connector) return false;

    connector.cleanup();
    const removed = this._connectors.delete(connectorId);
    if (removed) {
      this._events.emit("connectorRemoved", { connectorId });
    }
    return removed;
  }

  updateAllConnectorsStatus(status: OCPPStatus): void {
    this._connectors.forEach((connector) => this.updateConnectorStatus(connector.id, status));
  }

  updateConnectorStatus(connectorId: number, status: OCPPStatus): void {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(`Connector ${connectorId} not found`, LogType.System);
      return;
    }

    const previousStatus = connector.status;
    connector.status = status;
    this._messageHandler.sendStatusNotification(connectorId, status, previousStatus);
  }
}
