import { EventEmitter } from "../../shared/EventEmitter";
import { Logger, LogType, LogEntry } from "../../shared/Logger";
import { HeartbeatService } from "../../application/services/HeartbeatService";
import { StateManager } from "../../application/services/StateManager";
import { Connector } from "../connector/Connector";
import type { ChargePointEvents } from "./ChargePointEvents";
import { ConfigurationStore } from "./ConfigurationStore";
import { OCPPMessageHandler } from "../../infrastructure/transport/OCPPMessageHandler";
import { OCPPWebSocket } from "../../infrastructure/transport/OCPPWebSocket";
import type { Database } from "../persistence/Database";
import { LogRepository } from "../persistence/LogRepository";
import type { OCPPAvailability } from "../types/OcppTypes";
import {
  BootNotification,
  ChargePointStatus,
  ChargingProfilePurposeType,
  isChargePointStatus,
  OCPPStatus,
} from "../types/OcppTypes";
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
  // cpId is injected later in the constructor body so the Logger can
  // stamp every JSON line with the CP it belongs to (multi-CP daemons).
  private readonly _logger = new Logger();
  private readonly _events = new EventEmitter<ChargePointEvents>();
  private readonly _webSocket: OCPPWebSocket;
  private readonly _messageHandler: OCPPMessageHandler;
  private readonly _heartbeat: HeartbeatService;
  private readonly _stateManager: StateManager;
  private readonly _logRepository: LogRepository;
  private readonly _reservationManager: ReservationManager;
  private readonly _configuration: ConfigurationStore;

  // §7.7: connectorId=0 status MUST be Available / Unavailable / Faulted.
  // The narrower type stops the rest of the code from accidentally setting
  // Charging / Preparing / Reserved etc. on the CP main controller.
  private _status: ChargePointStatus = OCPPStatus.Unavailable;
  private _error = "";
  private _autoMeterValueSetting: AutoMeterValueSetting | null;
  private readonly _scenarioHandledConnectors: Set<number> = new Set();
  // §4.9 B6: per-connector ConnectionTimeOut watchdog. Started when a
  // connector enters Preparing, cleared on any other transition. If the
  // timer fires we auto-transition the connector to Finishing.
  private readonly _connectionTimeoutTimers: Map<number, NodeJS.Timeout> =
    new Map();

  constructor(
    private readonly _id: string,
    private readonly _bootNotification: BootNotification,
    connectorCount: number,
    wsUrl: string,
    basicAuthSettings: BasicAuthSettings | null,
    autoMeterValueSetting: AutoMeterValueSetting | null,
    /** SQLite-backed persistence for ConfigurationStore, PendingMessageQueue,
     *  and per-connector availability. `null` keeps everything in-memory —
     *  used by the daemon's `:memory:` mode and by tests. */
    private readonly _database: Database | null = null,
  ) {
    this._autoMeterValueSetting = autoMeterValueSetting;
    this._logger.setCpId(this._id);
    this._logRepository = new LogRepository(this._database);

    // Setup logger callback to emit log events
    this._logger.loggingCallback = (entry) => {
      this._events.emit("log", {
        timestamp: entry.timestamp,
        level: entry.level,
        type: entry.type,
        message: entry.message,
      });
      // Buffered SQLite write — LogRepository batches up to 50 entries
      // before hitting the DB so high-frequency log lines don't thrash
      // the IndexedDB flush in the browser.
      this._logRepository.append(this._id, entry);
    };

    for (let connectorId = 1; connectorId <= connectorCount; connectorId++) {
      const connector = new Connector(connectorId, this._logger);
      // §5.2: Unavailable set via ChangeAvailability persists across
      // reboots. Restore the persisted value before any event listeners
      // have a chance to react.
      const persisted = this.loadAvailability(connectorId);
      if (persisted) {
        connector.availability = persisted;
      }
      if (autoMeterValueSetting?.enabled) {
        connector.setIncrementFallback({
          intervalSeconds: autoMeterValueSetting.interval,
          incrementValue: autoMeterValueSetting.value,
        });
      }
      // When the connector signals an auto-stop (e.g. target SoC reached),
      // end the in-flight transaction the same way the user would.
      connector.events.on("autoStopRequested", ({ reason }) => {
        this._logger.info(
          `Connector ${connectorId} auto-stop requested (${reason})`,
          LogType.TRANSACTION,
        );
        this.stopTransaction(connector);
      });
      // §5.10 / §5.16: when the active schedule period switches between
      // limit=0 and a non-zero limit during a live transaction, the CP
      // should reflect that on the OCPP layer by toggling Charging ↔
      // SuspendedEVSE so the CSMS sees the pause.
      connector.events.on("scheduleLimitChange", ({ paused, watts }) => {
        if (!connector.transaction) return;
        if (paused && connector.status === OCPPStatus.Charging) {
          this._logger.info(
            `Connector ${connectorId} schedule period limit=0 (W), pausing → SuspendedEVSE`,
            LogType.OCPP,
          );
          this.updateConnectorStatus(connectorId, OCPPStatus.SuspendedEVSE);
        } else if (!paused && connector.status === OCPPStatus.SuspendedEVSE) {
          this._logger.info(
            `Connector ${connectorId} schedule period limit=${watts}W, resuming → Charging`,
            LogType.OCPP,
          );
          this.updateConnectorStatus(connectorId, OCPPStatus.Charging);
        }
      });
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

    // ConfigurationStore is constructed last because it depends on `this`
    // (via the `defaultConfiguration(cp)` factory which reads
    // `cp.connectorNumber` / `cp.wsUrl`). Hot-reactive keys are wired here
    // so changes via ChangeConfiguration.req take effect immediately.
    this._configuration = ConfigurationStore.forChargePoint(
      this,
      this._database,
    );
    this.wireConfigurationListeners();

    // §5.2: a CP-level Unavailable set previously must survive a reboot.
    // We don't actually transition status here (no WebSocket yet); the
    // saved flag is reapplied when ChangeAvailability runs or when the
    // operator inspects the persisted state.
    const persistedCp = this.loadAvailability(0);
    if (persistedCp === "Inoperative") {
      this._status = OCPPStatus.Unavailable;
    }
  }

  /** Read a persisted Operative/Inoperative flag from the DB for the given
   *  connector (`0` = CP-level). Returns `null` if no override is stored. */
  private loadAvailability(connectorId: number): OCPPAvailability | null {
    if (!this._database) return null;
    const row = this._database.get<{ availability: string | null }>(
      "SELECT availability FROM connector_settings WHERE cp_id = ? AND connector_id = ?",
      [this._id, connectorId],
    );
    if (
      row?.availability === "Operative" ||
      row?.availability === "Inoperative"
    ) {
      return row.availability;
    }
    return null;
  }

  private saveAvailability(
    connectorId: number,
    availability: OCPPAvailability,
  ): void {
    if (!this._database) return;
    this._database.run(
      "INSERT INTO connector_settings (cp_id, connector_id, availability) " +
        "VALUES (?, ?, ?) " +
        "ON CONFLICT (cp_id, connector_id) DO UPDATE SET availability = excluded.availability",
      [this._id, connectorId, availability],
    );
  }

  /** Exposed so OCPPMessageHandler (PendingMessageQueue) can share the
   *  same Database instance. `null` means the CP is running in-memory. */
  get database(): Database | null {
    return this._database;
  }

  /** Force any buffered log lines to be flushed to the DB. Used before
   *  the Download Logs export so the file includes the last seconds of
   *  activity the LogRepository hasn't pushed out yet. */
  flushLogs(): void {
    this._logRepository.flush();
  }

  /** In-memory log entries the Logger has accumulated this session,
   *  oldest-first. Used by the Download Logs path when the daemon is
   *  running without --state-db (no SQLite to read from). */
  getInMemoryLogs(): import("../../shared/Logger").LogEntry[] {
    return this._logger.getLogEntries();
  }

  /** Hook up subsystems that react to live Configuration changes. */
  private wireConfigurationListeners(): void {
    this._configuration.onChange((key, value) => {
      switch (key) {
        case "HeartbeatInterval":
          if (typeof value === "number" && value > 0) {
            this._heartbeat.startHeartbeat(value);
          } else {
            this._heartbeat.stopHeartbeat();
          }
          break;
        case "MeterValueSampleInterval":
          // §9.1.15: takes effect on the *next* transaction. Existing
          // per-connector schedulers keep their original cadence until
          // restarted; the new value is honored when a fresh transaction
          // starts (see Connector.startAutoMeterValue).
          this._logger.info(
            `MeterValueSampleInterval=${String(value)} (applies to next transaction)`,
            LogType.CONFIGURATION,
          );
          break;
        // Other keys (ClockAlignedDataInterval / WebSocketPingInterval etc.)
        // are wired in subsequent phases as the dependent subsystems are
        // extended.
        default:
          break;
      }
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

  /** Standard OCPP Configuration Keys store. */
  get configuration(): ConfigurationStore {
    return this._configuration;
  }

  /**
   * Snapshot every connector's (and the CP's) `availability` flag to the
   * configured DB so the §5.2 "Unavailable persists across reboots"
   * requirement is met. Called by ChangeAvailability after applying.
   */
  persistAvailability(): void {
    this.saveAvailability(
      0,
      this._status === OCPPStatus.Unavailable ? "Inoperative" : "Operative",
    );
    this._connectors.forEach((connector) => {
      this.saveAvailability(connector.id, connector.availability);
    });
  }

  get status(): ChargePointStatus {
    return this._status;
  }

  /** Whether the OCPP WebSocket is currently open OR mid-handshake. Used
   *  by LocalChargePointService.restoreConnections to avoid issuing a
   *  second connect() against a CP whose first socket is still in its
   *  async handshake — without the CONNECTING check we'd race and end up
   *  with two sockets fighting for the same cpId. */
  get isWebSocketConnected(): boolean {
    return this._webSocket.isOpenOrConnecting();
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
    // Idempotent: if a socket is already open or mid-handshake, don't
    // create a second one. The daemon's startServer can hit this twice
    // when restoreFromDatabase() auto-connects and then the bootstrap
    // path also calls svc.connect() on the same restored instance — each
    // call would otherwise overwrite `_ws` with a fresh socket and the
    // orphaned one's onClose would mark all connectors Unavailable on the
    // CSMS side.
    //
    // Only synthesize a "connected" event when the socket is already OPEN;
    // for CONNECTING we let the natural handshake fire it so callers that
    // gate on "connected" don't unblock before BootNotification.req
    // actually goes out.
    if (this._webSocket.isOpenOrConnecting()) {
      this._logger.info(
        "connect() ignored: WebSocket is already open or connecting",
        LogType.WEBSOCKET,
      );
      if (this._webSocket.isConnected()) {
        this._events.emit("connected", undefined);
      }
      return;
    }
    this._webSocket.connect(
      () => {
        this.boot();
        this._events.emit("connected", undefined);
        // The queued-message flush itself is triggered by
        // markBootAccepted(); we just need the WebSocket to come up and
        // BootNotification to round-trip first.
      },
      (ev: CloseEvent) => {
        // Same teardown as an explicit disconnect() — heartbeat, scenario
        // state, connector listeners, etc. — so a CSMS-initiated close
        // doesn't leave background timers firing against a dead socket.
        this.teardownAfterClose();
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

  /**
   * Send a StatusNotification.req with explicit errorCode/info/vendorErrorCode
   * — used by scenarios to drive Faulted-with-context paths without mutating
   * the connector's runtime status field (cf. `updateConnectorStatus`).
   *
   * For connectorId === 0, `status` must be Available / Unavailable /
   * Faulted (§7.7); other values are dropped with a warning.
   */
  sendStatusNotificationRaw(
    connectorId: number,
    status: OCPPStatus,
    opts: {
      errorCode?: string;
      info?: string;
      vendorErrorCode?: string;
      vendorId?: string;
    },
  ): void {
    if (connectorId === 0 && !isChargePointStatus(status)) {
      this._logger.warn(
        `Refusing CP-level StatusNotification with status='${status}': only Available/Unavailable/Faulted are valid (§7.7)`,
        LogType.OCPP,
      );
      return;
    }
    this._messageHandler.sendStatusNotification(connectorId, status, {
      errorCode:
        (opts.errorCode as
          | import("../types/OcppTypes").ChargePointErrorCode
          | undefined) ?? undefined,
      info: opts.info,
      vendorErrorCode: opts.vendorErrorCode,
      vendorId: opts.vendorId,
    });
  }

  /** Send a CP-initiated DataTransfer.req (§4.3). */
  sendDataTransfer(vendorId: string, messageId?: string, data?: string): void {
    this._messageHandler.sendDataTransfer(vendorId, messageId, data);
  }

  /** Send DiagnosticsStatusNotification.req — see OCPPMessageHandler doc. */
  sendDiagnosticsStatusNotification(
    status: "Idle" | "Uploaded" | "UploadFailed" | "Uploading",
  ): void {
    this._messageHandler.sendDiagnosticsStatusNotification(status);
  }

  /** Send FirmwareStatusNotification.req — see OCPPMessageHandler doc. */
  sendFirmwareStatusNotification(
    status:
      | "Downloaded"
      | "DownloadFailed"
      | "Downloading"
      | "Idle"
      | "InstallationFailed"
      | "Installing"
      | "Installed",
  ): void {
    this._messageHandler.sendFirmwareStatusNotification(status);
  }

  /** Boot-notification gate accessors used by BootNotificationResultHandler. */
  markBootAccepted(): void {
    this._messageHandler.setBootStatus({ status: "Accepted" });
    // §4.7/§4.8/§4.10 + errata 3.18: flush queued transaction-related
    // messages now that the boot gate is open. Run via queueMicrotask so
    // any post-boot StatusNotification fan-out goes first.
    queueMicrotask(() => this._messageHandler.flushPendingQueue());
  }

  markBootPending(): void {
    this._messageHandler.setBootStatus({ status: "Pending" });
  }

  markBootRejected(retryAfterSeconds: number): void {
    this._messageHandler.setBootStatus({
      status: "Rejected",
      retryAfter: new Date(Date.now() + retryAfterSeconds * 1000),
    });
    // Re-send BootNotification.req once the interval elapses (§4.2).
    setTimeout(() => {
      this.boot();
    }, retryAfterSeconds * 1000);
  }

  boot(): void {
    // OCPP 1.6J §4.2: the CP MUST NOT send any other CALL message until
    // BootNotification has been Accepted. The connector-level
    // StatusNotification fan-out happens in BootNotificationResultHandler
    // after we get the Accepted response.
    this._messageHandler.sendBootNotification(this._bootNotification);
    this.error = "";
  }

  disconnect(): void {
    this._logger.info("Disconnecting from WebSocket", LogType.WEBSOCKET);
    this.teardownAfterClose();
    this._webSocket.disconnect();
  }

  /**
   * Common teardown for both user-initiated disconnect() and the
   * WebSocket's onclose path. Sets the CP+connector status to Unavailable,
   * stops the heartbeat, cleans up connector listeners, and releases the
   * reservation manager so no timers / event handlers keep running against
   * a dead socket.
   */
  private teardownAfterClose(): void {
    this.status = OCPPStatus.Unavailable;
    this._heartbeat.cleanup();
    this._connectors.forEach((connector) => connector.cleanup());
    this._reservationManager.dispose();
    this._scenarioHandledConnectors.clear();
    // Cancel all ConnectionTimeOut watchdogs so the timer doesn't fire
    // against a disconnected CP.
    this._connectionTimeoutTimers.forEach((t) => clearTimeout(t));
    this._connectionTimeoutTimers.clear();
    // §4.1.1 serializer: drop the in-flight CALL + queued CALLs since the
    // WebSocket they target is gone. Transaction-related ones are already
    // persisted via PendingMessageQueue on prior send failures.
    this._messageHandler.onWebSocketClosed();
    // Flush any buffered log lines so the operator can still see the
    // last seconds of activity after the CP went down.
    this._logRepository.flush();
  }

  reset(): void {
    this.disconnect();
    this.connect();
  }

  authorize(tagId: string): void {
    this._messageHandler.authorize(tagId);
  }

  set status(newStatus: ChargePointStatus) {
    this._status = newStatus;
    if (newStatus === OCPPStatus.Unavailable) {
      // §4.9 note says CP-level (connectorId=0) and individual connector
      // statuses are formally independent. Cascading Unavailable here is a
      // UI-integrity choice: when the CP goes Unavailable (disconnect,
      // ChangeAvailability(0,Inoperative), etc.) the per-connector cards
      // should stop showing stale Operative state.
      this._connectors.forEach((connector) => {
        const previousStatus = connector.status;
        if (previousStatus === OCPPStatus.Unavailable) return;
        connector.status = OCPPStatus.Unavailable;
        this._events.emit("connectorStatusChange", {
          connectorId: connector.id,
          status: OCPPStatus.Unavailable,
          previousStatus,
        });
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

    // §5.13: if the connector was Reserved (or the reservation is for
    // connectorId=0 with this idTag), consume that reservation and carry
    // its id into StartTransaction.req so CSMS can close it out.
    const reservation =
      this._reservationManager.getReservationForConnector(connectorId);
    const reservationId = reservation?.reservationId;

    const transaction: Transaction = {
      id: 0,
      connectorId,
      tagId,
      meterStart: connector.meterValue,
      meterStop: null,
      startTime: new Date(),
      stopTime: null,
      meterSent: false,
      reservationId,
      batteryCapacityKwh,
      initialSoc,
    };

    // Set initial SoC on connector if provided
    if (initialSoc !== undefined) {
      connector.soc = initialSoc;
    }

    if (reservation) {
      // The reservation is fulfilled the moment we send StartTransaction —
      // §5.13 says the reservation terminates when a transaction is started
      // for the reserved idTag.
      this._reservationManager.cancelReservation(reservation.reservationId);
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

  stopTransaction(
    connectorOrId: number | Connector,
    reason?: import("../connector/Transaction").StopTransactionReason,
  ): void {
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
    if (reason) {
      transaction.stopReason = reason;
    }

    this._messageHandler.stopTransaction(transaction, connector.id);

    this._events.emit("transactionStopped", {
      connectorId: connector.id,
      transactionId: transaction.id ?? 0,
    });

    // Clear TxProfile charging profiles when transaction ends (OCPP 1.6 spec compliant)
    // NOTE: Only TxProfile is cleared. TxDefaultProfile persists for future transactions.
    // ChargePointMaxProfile also persists as it applies to the entire station.
    const clearedProfiles = connector.removeChargingProfiles({
      purpose: ChargingProfilePurposeType.TxProfile,
    });
    if (clearedProfiles > 0) {
      this._logger.info(
        `Cleared ${clearedProfiles} TxProfile(s) after transaction end on connector ${connector.id}`,
        LogType.TRANSACTION,
      );
    }

    this.cleanTransaction(connector);
    connector.stopTransaction();
    if (connector.autoResetToAvailable) {
      this.updateConnectorStatus(connector.id, OCPPStatus.Available);
    }

    // §5.2: if ChangeAvailability arrived while this transaction was
    // running we returned `Scheduled`; now that it stopped, finalize the
    // deferred availability flip and fire the follow-up StatusNotification.
    const scheduled = connector.scheduledAvailability;
    if (scheduled && scheduled !== connector.availability) {
      connector.availability = scheduled;
      const next =
        scheduled === "Operative"
          ? OCPPStatus.Available
          : OCPPStatus.Unavailable;
      this.updateConnectorStatus(connector.id, next);
      this.persistAvailability();
    }
    connector.scheduledAvailability = null;
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

  /** §4.6: any outgoing CALL counts as activity for the heartbeat idle
   *  timer. The transport calls this for every send; if the CALL is a
   *  Heartbeat itself, lastSentAt is also stamped. */
  notifyOutgoingCall(isHeartbeat: boolean): void {
    this._heartbeat.notifyOutgoingCall();
    if (isHeartbeat) this._heartbeat.markHeartbeatSent();
  }

  get heartbeat(): HeartbeatService {
    return this._heartbeat;
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
    // Connector 0 represents the charge point main controller (OCPP 1.6J
    // §7.7). It only accepts Available / Unavailable / Faulted; trying to
    // drive it into Charging / Reserved / etc. would create an out-of-spec
    // StatusNotification. Drop with a warning rather than silently coercing.
    if (connectorId === 0) {
      if (!isChargePointStatus(status)) {
        this._logger.warn(
          `Refusing to set connector 0 (CP main controller) to '${status}': only Available/Unavailable/Faulted are valid per OCPP 1.6 §7.7`,
          LogType.SYSTEM,
        );
        return;
      }
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
      // CP-level Faulted: send via the same path, no specific connector
      // errorCode available, so we'd pass NoError by default. Callers that
      // want to set a CP-level fault should use sendCpFaultedNotification.
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

    // §4.9 B6 ConnectionTimeOut: when the connector enters Preparing,
    // start a timer; if it doesn't progress before the timeout, auto-
    // transition to Finishing (= user didn't present an idTag in time).
    if (status === OCPPStatus.Preparing) {
      this.startConnectionTimeout(connectorId);
    } else {
      this.clearConnectionTimeout(connectorId);
    }

    // Faulted state propagates the connector's currentErrorCode; warning-grade
    // notifications during Preparing/Suspended* also do, so the CSMS can
    // see e.g. EVCommunicationError context. NoError is sent for the
    // happy-path transitions.
    const useErrorCode =
      connector.currentErrorCode !== "NoError" || status === OCPPStatus.Faulted;
    this._messageHandler.sendStatusNotification(connectorId, status, {
      errorCode: useErrorCode ? connector.currentErrorCode : "NoError",
      info: connector.errorInfo ?? undefined,
      vendorErrorCode: connector.vendorErrorCode ?? undefined,
    });
  }

  private startConnectionTimeout(connectorId: number): void {
    this.clearConnectionTimeout(connectorId);
    const timeoutSec =
      this._configuration?.getInteger("ConnectionTimeOut") ?? 60;
    if (timeoutSec <= 0) return;
    const handle = setTimeout(() => {
      this._connectionTimeoutTimers.delete(connectorId);
      const connector = this.getConnector(connectorId);
      if (!connector || connector.status !== OCPPStatus.Preparing) return;
      this._logger.info(
        `Connector ${connectorId} ConnectionTimeOut elapsed; transitioning Preparing → Finishing (§4.9 B6)`,
        LogType.OCPP,
      );
      this.updateConnectorStatus(connectorId, OCPPStatus.Finishing);
    }, timeoutSec * 1000);
    this._connectionTimeoutTimers.set(connectorId, handle);
  }

  private clearConnectionTimeout(connectorId: number): void {
    const handle = this._connectionTimeoutTimers.get(connectorId);
    if (handle) {
      clearTimeout(handle);
      this._connectionTimeoutTimers.delete(connectorId);
    }
  }

  /**
   * Sends a StatusNotification.req for the current state of the given
   * connector (no domain mutation, no events). Used to satisfy
   * TriggerMessage(StatusNotification) from the CSMS.
   *
   * connectorId 0 means the charge-point main controller.
   * connectorId omitted means "fan out to connector 0 + every connector".
   */
  sendCurrentStatusNotification(connectorId?: number): void {
    if (connectorId === undefined) {
      this._messageHandler.sendStatusNotification(0, this._status);
      this._connectors.forEach((connector) => {
        this._messageHandler.sendStatusNotification(
          connector.id,
          connector.status,
        );
      });
      return;
    }
    if (connectorId === 0) {
      this._messageHandler.sendStatusNotification(0, this._status);
      return;
    }
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(
        `Connector ${connectorId} not found (TriggerMessage)`,
        LogType.SYSTEM,
      );
      return;
    }
    this._messageHandler.sendStatusNotification(connectorId, connector.status);
  }
}
