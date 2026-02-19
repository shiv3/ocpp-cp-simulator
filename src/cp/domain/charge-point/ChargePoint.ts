import { EventEmitter } from "../../shared/EventEmitter";
import { Logger, LogType, LogEntry } from "../../shared/Logger";
import { HeartbeatService } from "../../application/services/HeartbeatService";
import { StateManager } from "../../application/services/StateManager";
import { Connector } from "../connector/Connector";
import type { ChargePointEvents } from "./ChargePointEvents";
import { OCPPMessageHandler } from "../../infrastructure/transport/OCPPMessageHandler";
import { OCPPWebSocket } from "../../infrastructure/transport/OCPPWebSocket";
import { BootNotification, OCPPStatus } from "../types/OcppTypes";
import type { Transaction } from "../connector/Transaction";
import { ReservationManager } from "../reservation/Reservation";

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
  private readonly _reservationManager: ReservationManager;

  private _status: OCPPStatus = OCPPStatus.Unavailable;
  private _error = "";
  private _autoMeterValueSetting: AutoMeterValueSetting | null;
  private readonly _scenarioHandledConnectors: Set<number> = new Set();

  constructor(
    private readonly _id: string,
    private readonly _bootNotification: BootNotification,
    connectorCount: number,
    wsUrl: string,
    basicAuthSettings: BasicAuthSettings | null,
    autoMeterValueSetting: AutoMeterValueSetting | null,
  ) {
    this._autoMeterValueSetting = autoMeterValueSetting;

    // Setup logger callback to emit log events
    this._logger.loggingCallback = (entry) => {
      this._events.emit("log", {
        timestamp: entry.timestamp,
        level: entry.level,
        type: entry.type,
        message: entry.message,
      });
    };

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

    this._webSocket = new OCPPWebSocket(
      wsUrl,
      this._id,
      this._logger,
      basicAuthSettings,
    );
    this._messageHandler = new OCPPMessageHandler(
      this,
      this._webSocket,
      this._logger,
    );

    this._heartbeat = new HeartbeatService(this._logger);
    this._heartbeat.setHeartbeatCallback(() =>
      this._messageHandler.sendHeartbeat(),
    );

    this._reservationManager = new ReservationManager(this._logger);

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

  get reservationManager(): ReservationManager {
    return this._reservationManager;
  }

  /**
   * Register a connector as being handled by a scenario.
   * When registered, RemoteStartTransaction handler will emit
   * remoteStartReceived instead of calling startTransaction directly.
   */
  registerScenarioHandler(connectorId: number): void {
    this._scenarioHandledConnectors.add(connectorId);
  }

  unregisterScenarioHandler(connectorId: number): void {
    this._scenarioHandledConnectors.delete(connectorId);
  }

  isScenarioHandled(connectorId: number): boolean {
    return this._scenarioHandledConnectors.has(connectorId);
  }

  notifyRemoteStartReceived(connectorId: number, tagId: string): void {
    this._events.emit("remoteStartReceived", { connectorId, tagId });
  }

  set loggingCallback(callback: (entry: LogEntry) => void) {
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
    this._connectors.forEach((connector) => {
      if (connector.autoResetToAvailable) {
        this.updateConnectorStatus(connector.id, OCPPStatus.Available);
        return;
      }
      this.updateConnectorStatus(connector.id, connector.status);
    });
    this.error = "";
  }

  disconnect(): void {
    this._logger.info("Disconnecting from WebSocket", LogType.WEBSOCKET);
    this.status = OCPPStatus.Unavailable;
    this._heartbeat.cleanup();
    this._connectors.forEach((connector) => connector.cleanup());
    this._reservationManager.dispose();
    this._scenarioHandledConnectors.clear();
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

  startTransaction(
    tagId: string,
    connectorId: number,
    batteryCapacityKwh?: number,
    initialSoc?: number,
  ): void {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(
        `Connector ${connectorId} not found`,
        LogType.TRANSACTION,
      );
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
      batteryCapacityKwh,
      initialSoc,
    };

    // Set initial SoC on connector if provided
    if (initialSoc !== undefined) {
      connector.soc = initialSoc;
    }

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
      const connId =
        typeof connectorOrId === "number" ? connectorOrId : connectorOrId.id;
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
    if (connector.autoResetToAvailable) {
      this.updateConnectorStatus(connector.id, OCPPStatus.Available);
    }
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
      this._logger.error(
        `Connector ${connectorId} not found`,
        LogType.METER_VALUE,
      );
      return;
    }
    connector.meterValue = value;
  }

  sendMeterValue(connectorId: number): void {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(
        `Connector ${connectorId} not found`,
        LogType.METER_VALUE,
      );
      return;
    }
    this._messageHandler.sendMeterValue(
      connector.transaction?.id ?? undefined,
      connectorId,
      connector.meterValue,
      connector.soc ?? undefined,
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
    this._connectors.forEach((connector) =>
      this.updateConnectorStatus(connector.id, status),
    );
  }

  updateConnectorStatus(connectorId: number, status: OCPPStatus): void {
    // Connector 0 represents the charge point main controller (OCPP 1.6J spec)
    if (connectorId === 0) {
      const previousStatus = this._status;
      this._status = status;
      this._events.emit("statusChange", { status });
      this._stateManager.transitionChargePointStatus(status, {
        source: "connector-0-update",
        timestamp: new Date(),
      });
      this._logger.info(
        `Charge point status updated: ${previousStatus} -> ${status} (connector 0)`,
        LogType.SYSTEM,
      );
      this._messageHandler.sendStatusNotification(0, status);
      return;
    }

    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(`Connector ${connectorId} not found`, LogType.SYSTEM);
      return;
    }

    const previousStatus = connector.status;
    connector.status = status;
    this._events.emit("connectorStatusChange", {
      connectorId,
      status,
      previousStatus,
    });
    this._messageHandler.sendStatusNotification(connectorId, status);
  }
}
