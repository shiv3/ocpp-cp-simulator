import { Connector } from "./Connector";
import { OCPPWebSocket } from "./OCPPWebSocket";
import { OCPPMessageHandler } from "./OCPPMessageHandler";
import { Logger, LogType } from "./Logger";
import { OCPPStatus, OCPPAvailability, BootNotification } from "./OcppTypes";
import { Transaction } from "./Transaction.ts";
import * as ocpp from "./OcppTypes.ts";
import { HeartbeatManager, MeterValueManager } from "./managers";
import { StateManager } from "./managers/StateManager";
import { EventEmitter } from "./EventEmitter";
import { ChargePointEvents } from "./ChargePointEvents";

export class ChargePoint {
  private _id: string;
  private _bootNotification: ocpp.BootNotification;
  private _connectors: Map<number, Connector>;
  private _webSocket: OCPPWebSocket;
  private _messageHandler: OCPPMessageHandler;
  private _logger: Logger;
  private _autoMeterValueSetting: { interval: number; value: number } | null;

  // Manager instances
  private _heartbeatManager: HeartbeatManager;
  private _meterValueManager: MeterValueManager;
  private _stateManager: StateManager;

  // EventEmitter for type-safe events
  private _events: EventEmitter<ChargePointEvents> = new EventEmitter();

  public _status: OCPPStatus = OCPPStatus.Unavailable;
  private _error: string = "";

  constructor(
    id: string,
    _bootNotification: BootNotification,
    connectorCount: number,
    wsUrl: string,
    basicAuthSettings: { username: string; password: string } | null,
    autoMeterValueSetting: { interval: number; value: number } | null,
  ) {
    this._id = id;
    this._bootNotification = _bootNotification;
    this._connectors = new Map();
    for (let i = 1; i <= connectorCount; i++) {
      this._connectors.set(i, new Connector(i));
    }
    this._logger = new Logger();
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
    this._autoMeterValueSetting = autoMeterValueSetting;

    // Initialize managers
    this._heartbeatManager = new HeartbeatManager(this._logger);
    this._heartbeatManager.setHeartbeatCallback(() =>
      this._messageHandler.sendHeartbeat(),
    );

    this._meterValueManager = new MeterValueManager(this._logger);
    this._meterValueManager.setGetMeterValueCallback((connectorId) =>
      this.getConnector(connectorId)?.meterValue || 0,
    );
    this._meterValueManager.setSetMeterValueCallback(
      (connectorId, value) => this.setMeterValue(connectorId, value),
    );
    this._meterValueManager.setSendMeterValueCallback((connectorId) =>
      this.sendMeterValue(connectorId),
    );

    // Initialize StateManager
    this._stateManager = new StateManager(
      this._logger,
      this._events,
      () => ({ status: this._status, error: this._error }),
      (id) => {
        const connector = this._connectors.get(id);
        if (!connector) return undefined;
        return {
          status: connector.status as string,
          availability: connector.availability,
          transaction: connector.transaction,
          meterValue: connector.meterValue,
        };
      },
    );

    // Initialize connectors in StateManager
    this._connectors.forEach((connector, id) => {
      this._stateManager.initializeConnector(
        id,
        connector.status as OCPPStatus,
        connector.availability,
      );
    });
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

    // Emit event through EventEmitter
    this._events.emit("error", { error });
  }

  get connectors(): Map<number, Connector> {
    return new Map(this._connectors);
  }

  /**
   * Get the event emitter for this charge point
   */
  get events(): EventEmitter<ChargePointEvents> {
    return this._events;
  }

  /**
   * Get the state manager for this charge point
   */
  get stateManager(): StateManager {
    return this._stateManager;
  }

  /**
   * Access the internal logger (for clearing logs from UI)
   */
  get logger(): Logger {
    return this._logger;
  }

  /**
   * Set logging callback (emits log events)
   */
  set loggingCallback(callback: (message: string) => void) {
    this._logger._loggingCallback = callback;
  }

  public connect(): void {
    this._webSocket.connect(
      () => {
        this.boot();
        // Emit connected event
        this._events.emit("connected", undefined);
      },
      (ev: CloseEvent) => {
        this.status = OCPPStatus.Unavailable;
        this.updateAllConnectorsStatus(OCPPStatus.Unavailable);
        this._logger.error(
          `WebSocket closed code: ${ev.code} reason: ${ev.reason}`,
          LogType.WEBSOCKET,
        );

        // Emit disconnected event
        this._events.emit("disconnected", {
          code: ev.code,
          reason: ev.reason,
        });

        if (ev.code !== 1005) {
          this.error = `WebSocket closed code: ${ev.code} reason: ${ev.reason}`;
        }
      },
    );
  }

  public boot(): void {
    this._messageHandler.sendBootNotification(this._bootNotification);
    this.status = OCPPStatus.Available;
    this.updateAllConnectorsStatus(OCPPStatus.Available);
    this.error = "";
  }

  public disconnect(): void {
    this._logger.info("Disconnecting from WebSocket", LogType.WEBSOCKET);
    this.status = OCPPStatus.Unavailable;

    // Clean up all intervals to prevent memory leaks
    this._heartbeatManager.cleanup();
    this._meterValueManager.cleanup();

    // Clean up all connector event listeners
    this._connectors.forEach((connector) => {
      connector.cleanup();
    });

    this._webSocket.disconnect();
  }

  public reset(): void {
    this.disconnect();
    this.connect();
  }

  public authorize(tagId: string): void {
    this._messageHandler.authorize(tagId);
  }

  /**
   * Set the charge point status
   * @deprecated Use stateManager.transitionChargePointStatus() instead for better state management
   */
  set status(status: OCPPStatus) {
    this._status = status;

    // When CP becomes Unavailable, all connectors should also become Unavailable
    if (status === OCPPStatus.Unavailable) {
      this._connectors.forEach((connector) => {
        connector.status = OCPPStatus.Unavailable;
      });
    }

    // Emit event through EventEmitter
    this._events.emit("statusChange", { status });

    // Also record in StateManager
    this._stateManager.transitionChargePointStatus(status, {
      source: "legacy-setter",
      timestamp: new Date(),
    });
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
        meterSent: false,
      };
      connector.transaction = transaction;
      this._messageHandler.startTransaction(transaction, connectorId);
      this.updateConnectorStatus(connectorId, OCPPStatus.Preparing);

      // Emit transaction started event (will be updated with real ID when response arrives)
      this._events.emit("transactionStarted", {
        connectorId,
        transactionId: 0,
        tagId,
      });

      // Start connector-level auto MeterValue if enabled
      connector.startAutoMeterValue();

      // Legacy auto MeterValue support (fallback)
      if (
        !connector.autoMeterValueConfig.enabled &&
        this._autoMeterValueSetting !== null &&
        this._autoMeterValueSetting.interval !== 0 &&
        this._autoMeterValueSetting.value !== 0
      ) {
        this._meterValueManager.startAutoMeterValue(connectorId, {
          intervalSeconds: this._autoMeterValueSetting.interval,
          incrementValue: this._autoMeterValueSetting.value,
        });
      }
    } else {
      this._logger.error(`Connector ${connectorId} not found`, LogType.TRANSACTION);
    }
  }

  public stopTransaction(connectorId: number | Connector): void {
    let connId: number;
    let connector: Connector | undefined;
    if (typeof connectorId === "number") {
      connId = connectorId;
      connector = this.getConnector(connectorId);
    } else {
      connId = connectorId.id;
      connector = connectorId;
    }

    // Stop connector-level auto MeterValue
    if (connector) {
      connector.stopAutoMeterValue();
    }

    // Always stop legacy auto meter value to prevent memory leaks
    this._meterValueManager.stopAutoMeterValue(connId);

    if (connector) {
      const transactionId = connector.transaction?.id || 0;
      connector.transaction!.stopTime = new Date();
      connector.transaction!.meterStop = connector.meterValue;
      this._messageHandler.stopTransaction(connector.transaction!, connId);

      // Emit transaction stopped event
      this._events.emit("transactionStopped", {
        connectorId: connId,
        transactionId,
      });

      this.cleanTransaction(connector);
    } else {
      this._logger.error(`Connector for id ${connId} not found`, LogType.TRANSACTION);
    }
    this.updateConnectorStatus(connId, OCPPStatus.Available);
  }

  public cleanTransaction(connector: Connector | number): void {
    let connectorId: number;
    let transaction: Transaction | undefined | null;
    if (typeof connector === "number") {
      connectorId = connector;
      transaction = this.getConnector(connectorId)?.transaction;
    } else {
      connectorId = connector.id;
      transaction = connector.transaction;
    }
    if (transaction) {
      transaction.meterSent = false;
    }
    this.updateConnectorStatus(connectorId, OCPPStatus.Finishing);
    this._meterValueManager.stopAutoMeterValue(connectorId);
  }

  public sendHeartbeat(): void {
    this._heartbeatManager.sendHeartbeat();
  }

  public startHeartbeat(period: number): void {
    this._heartbeatManager.startHeartbeat(period);
  }

  public stopHeartbeat(): void {
    this._heartbeatManager.stopHeartbeat();
  }

  public setMeterValue(connectorId: number, meterValue: number): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      connector.meterValue = meterValue;
    } else {
      this._logger.error(`Connector ${connectorId} not found`, LogType.METER_VALUE);
    }
  }

  public sendMeterValue(connectorId: number): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      this._messageHandler.sendMeterValue(
        connector.transaction?.id ?? undefined,
        connectorId,
        connector.meterValue,
      );
    } else {
      this._logger.error(`Connector ${connectorId} not found`, LogType.METER_VALUE);
    }
  }

  // Meter value management methods moved to MeterValueManager

  public getConnector(connectorId: number): Connector | undefined {
    return this._connectors.get(connectorId);
  }

  public removeConnector(connectorId: number): boolean {
    const connector = this._connectors.get(connectorId);
    if (!connector) {
      return false;
    }

    // Clean up the connector before removing
    connector.cleanup();

    // Remove from the map
    const result = this._connectors.delete(connectorId);

    // Emit event
    if (result) {
      this._events.emit("connectorRemoved", { connectorId });
    }

    return result;
  }

  public updateAllConnectorsStatus(newStatus: OCPPStatus): void {
    this._connectors.forEach((connector) => {
      this.updateConnectorStatus(connector.id, newStatus);
    });
  }

  public updateConnectorStatus(
    connectorId: number,
    newStatus: OCPPStatus,
  ): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      const previousStatus = connector.status as OCPPStatus;
      connector.status = newStatus;
      this._messageHandler.sendStatusNotification(connectorId, newStatus);

      // Record transition in StateHistory
      this._stateManager.history.recordTransition({
        id: crypto.randomUUID(),
        timestamp: new Date(),
        entity: "connector",
        entityId: connectorId,
        transitionType: "status",
        fromState: previousStatus,
        toState: newStatus,
        context: {
          source: "updateConnectorStatus",
          timestamp: new Date(),
        },
        validationResult: {
          level: "OK",
        },
        success: true,
      });

      // Emit connector status change event
      this._events.emit("connectorStatusChange", {
        connectorId,
        status: newStatus,
        previousStatus,
      });
    } else {
      this._logger.error(`Connector ${connectorId} not found`, LogType.STATUS);
    }
  }

  public updateConnectorAvailability(
    connectorId: number,
    newAvailability: OCPPAvailability,
  ): boolean {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(`Connector ${connectorId} not found`, LogType.STATUS);
      return false;
    }
    connector.availability = newAvailability;
    if (newAvailability === "Inoperative") {
      this.updateConnectorStatus(connectorId, OCPPStatus.Unavailable);
    } else if (newAvailability === "Operative") {
      this.updateConnectorStatus(connectorId, OCPPStatus.Available);
    }

    // Emit connector availability change event
    this._events.emit("connectorAvailabilityChange", {
      connectorId,
      availability: newAvailability,
    });

    return true;
  }

  public setTransactionID(connectorId: number, transactionId: number): void {
    const connector = this.getConnector(connectorId);
    if (connector) {
      connector.transactionId = transactionId;

      // Emit connector transaction change event
      this._events.emit("connectorTransactionChange", {
        connectorId,
        transactionId,
      });
    } else {
      this._logger.error(`Connector ${connectorId} not found`, LogType.TRANSACTION);
    }
  }

  /**
   * Clean up all event listeners and resources
   */
  public cleanup(): void {
    this.disconnect();
    this._events.removeAllListeners();
  }
}
