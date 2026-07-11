import { EventEmitter } from "../../shared/EventEmitter";
import { Logger, LogType, LogEntry } from "../../shared/Logger";
import { HeartbeatService } from "../../application/services/HeartbeatService";
import { StateManager } from "../../application/services/StateManager";
import { Connector } from "../connector/Connector";
import type { ChargePointEvents } from "./ChargePointEvents";
import { ConfigurationStore } from "./ConfigurationStore";
import type { IChargePointMessageHandler } from "../../infrastructure/transport/IChargePointMessageHandler";
import { OCPPWebSocket } from "../../infrastructure/transport/OCPPWebSocket";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "../../infrastructure/transport/wsUrlWithBasic";
import { getProtocolProfile } from "../../infrastructure/transport/profile/profiles";
import { OCPPSoapHandler } from "../../infrastructure/transport/soap";
import { Outbox } from "../transport/Outbox";
import type { Database } from "../persistence/Database";
import { LogRepository } from "../persistence/LogRepository";
import type {
  ChargePointErrorCode,
  OCPPAvailability,
  StatusNotificationOptions,
} from "../types/OcppTypes";
import { isSoapVersion, OCPP_1_5 } from "../types/OcppVersion";
import {
  SOAP_OPERATION_NAMES,
  soapDialectForVersion,
  type SoapOperation,
} from "../../infrastructure/transport/soap/dialect";
import {
  BootNotification,
  ChargePointStatus,
  ChargingProfilePurposeType,
  isChargePointStatus,
  OCPPStatus,
} from "../types/OcppTypes";
import type {
  StopTransactionReason,
  Transaction,
  TransactionStartTriggerReason,
  TransactionStopTriggerReason,
} from "../connector/Transaction";
import { ReservationManager } from "../reservation/Reservation";
import { LocalAuthListManager } from "../auth/LocalAuthList";
import { ChargingProfileStore } from "./ChargingProfileStore";
import type { ActiveChargingProfile } from "../connector/Connector";
import { CertificateStore } from "../security/CertificateStore";

interface BasicAuthSettings {
  username: string;
  password: string;
}

export interface AutoMeterValueSetting {
  enabled: boolean;
  interval: number;
  value: number;
}

interface StartTransactionOptions {
  triggerReason?: TransactionStartTriggerReason;
  remoteStartId?: number;
}

interface StopTransactionOptions {
  triggerReason?: TransactionStopTriggerReason;
}

export type ChargePointResetType = "Hard" | "Soft";
type ChargePointResetSource = "ocpp-call" | "ocpp15-soap";

export interface ChargePointTransportOptions {
  readonly centralSystemUrl?: string;
  readonly soapCallbackUrl?: string;
  readonly soapPath?: string;
  readonly soapRequestTimeoutMs?: number;
}

export class ChargePoint {
  private readonly _connectors: Map<number, Connector> = new Map();
  // cpId is injected later in the constructor body so the Logger can
  // stamp every JSON line with the CP it belongs to (multi-CP daemons).
  private readonly _logger = new Logger();
  private readonly _events = new EventEmitter<ChargePointEvents>();
  private readonly _webSocket: OCPPWebSocket | null;
  private readonly _messageHandler: IChargePointMessageHandler;
  private readonly _transportUrl: string;
  private readonly _outbox: Outbox;
  private readonly _heartbeat: HeartbeatService;
  private readonly _stateManager: StateManager;
  private readonly _logRepository: LogRepository;
  private readonly _reservationManager: ReservationManager;
  private readonly _localAuthListManager: LocalAuthListManager;
  // §3.13.3: profiles installed with connectorId=0 (ChargePointMaxProfile,
  // station-wide TxDefaultProfile) belong at the CP level, not duplicated
  // onto every connector. Connectors consult this store at composite time.
  private readonly _stationProfiles: ChargingProfileStore =
    new ChargingProfileStore();
  private readonly _certificateStore = new CertificateStore();
  private readonly _configuration: ConfigurationStore;

  // §7.7: connectorId=0 status MUST be Available / Unavailable / Faulted.
  // The narrower type stops the rest of the code from accidentally setting
  // Charging / Preparing / Reserved etc. on the CP main controller.
  private _status: ChargePointStatus = OCPPStatus.Unavailable;
  private _error = "";
  private _autoMeterValueSetting: AutoMeterValueSetting | null;
  private readonly _scenarioHandledConnectors: Set<number> = new Set();
  // Mirror of _scenarioHandledConnectors but for the stop side. When a
  // connector id is in this set, the RemoteStopTransaction default
  // handler defers to the scenario instead of stopping the transaction
  // itself — the scenario is parked on a RemoteStopTrigger node and will
  // resume into its own Transaction Stop step.
  private readonly _scenarioStopHandledConnectors: Set<number> = new Set();
  /** One-shot canned `{ status }` responses per incoming action,
   *  armed by a scenario responseOverride node (issue #110). */
  private _responseOverrides = new Map<string, string>();
  // §4.9 B6: per-connector ConnectionTimeOut watchdog. Started when a
  // connector enters Preparing, cleared on any other transition. If the
  // timer fires we auto-transition the connector to Finishing.
  private readonly _connectionTimeoutTimers: Map<number, NodeJS.Timeout> =
    new Map();
  // §4.9 S3: whether this SOAP CP has a soapCallbackUrl (server-hosted) vs
  // send-only (browser local mode). For non-SOAP versions, always false.
  private readonly _hasSoapCallbackUrl: boolean;

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
    /** Extra HTTP headers and Sec-WebSocket-Protocol tokens emitted on
     *  every WS upgrade. Wired through to OCPPWebSocket so reconnects
     *  pick the same values up. CLI-only (DOM WebSocket ignores headers). */
    extraWsHeaders: Record<string, string> = {},
    extraWsSubprotocols: ReadonlyArray<string> = [],
    private readonly _ocppVersion: string = "OCPP-1.6J",
    transportOptions: ChargePointTransportOptions = {},
    securityProfile?: OcppSecurityProfile,
    authorizationKey?: string,
    cpoName?: string,
    tls?: OcppTlsOptions,
  ) {
    this._autoMeterValueSetting = autoMeterValueSetting;
    this._transportUrl = transportOptions.centralSystemUrl ?? wsUrl;
    this._logger.setCpId(this._id);
    this._logRepository = new LogRepository(this._database);
    // §4.9 S3: track whether this SOAP CP can receive CSMS-initiated calls
    // (server-hosted with callback) vs send-only (no callback URL).
    this._hasSoapCallbackUrl = !!transportOptions.soapCallbackUrl;

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
      const connector = new Connector(
        connectorId,
        this._logger,
        () => this._stationProfiles,
      );
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
        this.stopTransaction(connector, undefined, {
          triggerReason: "EnergyLimitReached",
        });
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

    if (isSoapVersion(this._ocppVersion)) {
      this._webSocket = null;
      const dialect = soapDialectForVersion(this._ocppVersion);
      this._messageHandler = new OCPPSoapHandler(this, this._logger, {
        centralSystemUrl: this._transportUrl,
        soapCallbackUrl: transportOptions.soapCallbackUrl,
        requestTimeoutMs: transportOptions.soapRequestTimeoutMs,
        dialect,
      });
    } else {
      this._webSocket = new OCPPWebSocket(
        wsUrl,
        this._id,
        this._logger,
        basicAuthSettings,
        extraWsHeaders,
        extraWsSubprotocols,
        this._ocppVersion,
        securityProfile,
        authorizationKey,
        cpoName,
        tls,
      );
      this._messageHandler = getProtocolProfile(
        this._ocppVersion,
      ).createMessageHandler(this, this._webSocket, this._logger);
    }
    this._outbox = new Outbox(this._messageHandler);

    this._heartbeat = new HeartbeatService(this._logger);
    this._heartbeat.setHeartbeatCallback(() => this._outbox.sendHeartbeat());

    this._reservationManager = new ReservationManager(this._logger);
    this._localAuthListManager = new LocalAuthListManager(this._logger);

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
    if (securityProfile !== undefined) {
      this._configuration.applyChange(
        "SecurityProfile",
        String(securityProfile),
      );
    }
    if (authorizationKey !== undefined) {
      this._configuration.applyChange("AuthorizationKey", authorizationKey);
    }
    if (cpoName !== undefined) {
      this._configuration.applyChange("CpoName", cpoName);
    }
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

  get certificateStore(): CertificateStore {
    return this._certificateStore;
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
    return this._webSocket?.isOpenOrConnecting() ?? false;
  }

  isSoapChargePoint(): boolean {
    return isSoapVersion(this._ocppVersion) && this._webSocket === null;
  }

  get ocppVersion(): string {
    return this._ocppVersion;
  }

  /**
   * §4.9 S3: check whether this charge point can receive a CSMS-initiated call.
   *
   * WebSocket versions can receive all CSMS calls. SOAP versions depend on:
   * - Send-only (no soapCallbackUrl): cannot receive any calls (no server).
   * - Server-hosted (with callback): depends on the version's dialect:
   *   - OCPP-1.5: only Reset can be received (its server registry is Reset-only).
   *   - OCPP-1.2 / 1.6S: check if the action exists in the dialect with target "cp".
   */
  canReceiveCsmsCall(action: string): boolean {
    // WebSocket versions can receive all CSMS calls
    if (!isSoapVersion(this._ocppVersion)) {
      return true;
    }

    // SOAP versions without a callback URL (send-only, e.g. browser local mode)
    // cannot receive any CSMS-initiated calls — there's no server to host the callback.
    if (!this._hasSoapCallbackUrl) {
      return false;
    }

    // SOAP with callback: consult the dialect's operationMetadata.
    // Special case: OCPP-1.5 server registry is Reset-only.
    if (this._ocppVersion === OCPP_1_5) {
      return action === "Reset";
    }

    // For OCPP-1.2 / 1.6S: check if the action exists in the dialect with target "cp".
    if (!(SOAP_OPERATION_NAMES as readonly string[]).includes(action)) {
      return false;
    }
    const dialect = soapDialectForVersion(this._ocppVersion);
    const metadata = dialect.operationMetadata[action as SoapOperation];
    return metadata?.target === "cp";
  }

  get connectorNumber(): number {
    return this._connectors.size;
  }

  get connectors(): Map<number, Connector> {
    return new Map(this._connectors);
  }

  get wsUrl(): string {
    return this._webSocket?.url ?? this._transportUrl;
  }

  get error(): string {
    return this._error;
  }

  set error(value: string) {
    // Only emit on a real transition. boot() clears the error to "" on every
    // connect, which otherwise emitted a spurious {"event":"error",
    // "data":{"error":""}} on the JSON/event stream before "connected".
    if (this._error === value) return;
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

  get localAuthListManager(): LocalAuthListManager {
    return this._localAuthListManager;
  }

  /** Read-only access for handlers and tests. SetChargingProfile /
   *  ClearChargingProfile mutate this directly. */
  get stationProfiles(): ChargingProfileStore {
    return this._stationProfiles;
  }

  /** Convenience: the currently active ChargePointMaxProfile (highest
   *  stackLevel) at the station level. Returns `null` if none. */
  getActiveChargePointMaxProfile(
    now: Date = new Date(),
  ): ActiveChargingProfile | null {
    return this._stationProfiles.getActive(
      ChargingProfilePurposeType.ChargePointMaxProfile,
      now,
    );
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

  notifyRemoteStartReceived(
    connectorId: number,
    tagId: string,
    remoteStartId?: number,
  ): void {
    this._events.emit("remoteStartReceived", {
      connectorId,
      tagId,
      ...(remoteStartId !== undefined ? { remoteStartId } : {}),
    });
  }

  /**
   * Counterpart of registerScenarioHandler for the stop side: a
   * RemoteStopTrigger scenario node registers here so the next
   * RemoteStopTransaction.req from CSMS gets routed into the scenario
   * via `remoteStopReceived` instead of the default handler running
   * stopTransaction() right away.
   */
  registerScenarioStopHandler(connectorId: number): void {
    this._scenarioStopHandledConnectors.add(connectorId);
  }

  unregisterScenarioStopHandler(connectorId: number): void {
    this._scenarioStopHandledConnectors.delete(connectorId);
  }

  isScenarioStopHandled(connectorId: number): boolean {
    return this._scenarioStopHandledConnectors.has(connectorId);
  }

  notifyRemoteStopReceived(connectorId: number, transactionId: number): void {
    this._events.emit("remoteStopReceived", { connectorId, transactionId });
  }

  notifyIncomingCall(action: string, payload: unknown): void {
    this._events.emit("incomingCallReceived", { action, payload });
  }

  armResponseOverride(action: string, status: string): void {
    this._responseOverrides.set(action, status);
  }

  /** Returns and clears the armed status for `action`, or null. */
  consumeResponseOverride(action: string): string | null {
    const status = this._responseOverrides.get(action);
    if (status === undefined) return null;
    this._responseOverrides.delete(action);
    return status;
  }

  set loggingCallback(callback: (entry: LogEntry) => void) {
    this._logger._loggingCallback = callback;
  }

  connect(): void {
    if (!this._webSocket) {
      this._logger.info(
        `Connecting via ${this._ocppVersion} SOAP client`,
        LogType.OCPP,
      );
      this.boot();
      this._events.emit("connected", undefined);
      return;
    }

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
    opts: StatusNotificationOptions,
  ): void {
    if (connectorId === 0 && !isChargePointStatus(status)) {
      this._logger.warn(
        `Refusing CP-level StatusNotification with status='${status}': only Available/Unavailable/Faulted are valid (§7.7)`,
        LogType.OCPP,
      );
      return;
    }
    this._outbox.sendStatusNotification(connectorId, status, {
      errorCode:
        (opts.errorCode as ChargePointErrorCode | undefined) ?? undefined,
      info: opts.info,
      vendorErrorCode: opts.vendorErrorCode,
      vendorId: opts.vendorId,
      timestamp: opts.timestamp,
      suppressChargingStateTransactionEvent:
        opts.suppressChargingStateTransactionEvent ?? true,
    });
  }

  /** Send a CP-initiated DataTransfer.req (§4.3). */
  sendDataTransfer(vendorId: string, messageId?: string, data?: string): void {
    this._outbox.sendDataTransfer(vendorId, messageId, data);
  }

  /** Programmatic trigger for OCPP 1.6 SecurityEventNotification.req. */
  sendSecurityEventNotification(type: string, techInfo?: string): void {
    this._outbox.sendSecurityEventNotification(type, techInfo);
  }

  /** Generate or forward a CSR and send OCPP 1.6 SignCertificate.req. */
  sendSignCertificate(csr?: string): Promise<void> {
    return this._outbox.sendSignCertificate(csr);
  }

  /** Send DiagnosticsStatusNotification.req — see OCPPMessageHandler doc. */
  sendDiagnosticsStatusNotification(
    status: "Idle" | "Uploaded" | "UploadFailed" | "Uploading",
  ): void {
    this._outbox.sendDiagnosticsStatusNotification(status);
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
    this._outbox.sendFirmwareStatusNotification(status);
  }

  /** Send LogStatusNotification.req — see OCPPMessageHandler doc. */
  sendLogStatusNotification(
    status:
      | "BadMessage"
      | "Idle"
      | "NotSupportedOperation"
      | "PermissionDenied"
      | "Uploaded"
      | "UploadFailure"
      | "Uploading",
    requestId?: number,
  ): void {
    this._outbox.sendLogStatusNotification(status, requestId);
  }

  /** Send SignedFirmwareStatusNotification.req — see OCPPMessageHandler doc. */
  sendSignedFirmwareStatusNotification(
    status:
      | "Downloaded"
      | "DownloadFailed"
      | "Downloading"
      | "DownloadScheduled"
      | "DownloadPaused"
      | "Idle"
      | "InstallationFailed"
      | "Installing"
      | "Installed"
      | "InstallRebooting"
      | "InstallScheduled"
      | "InstallVerificationFailed"
      | "InvalidSignature"
      | "SignatureVerified",
    requestId?: number,
  ): void {
    this._outbox.sendSignedFirmwareStatusNotification(status, requestId);
  }

  /** Set while a simulated firmware update is in flight, so a second
   *  UpdateFirmware.req (the spec allows the CSMS to re-issue) doesn't
   *  fork a parallel status train. */
  private _firmwareUpdateInFlight = false;
  /** Reference kept so disconnect/dispose can cancel a pending start
   *  before `retrieveDate`. */
  private _firmwareUpdateTimers: NodeJS.Timeout[] = [];

  /**
   * §4.5 / §6.19: schedule a simulated firmware update progression. After
   * `retrieveDate` is reached, fires FirmwareStatusNotification.req in
   * sequence — Downloading → Downloaded → Installing → Installed — with
   * `intervalMs` between each transition.
   *
   * Real charge points download a binary, install it, and reboot. The
   * simulator just walks the status machine so the CSMS observes the
   * full happy-path. Failure paths (DownloadFailed / InstallationFailed)
   * are reachable via TriggerMessage(FirmwareStatusNotification) for
   * tests that want to drive them manually.
   */
  simulateFirmwareUpdate(retrieveDate: Date, intervalMs = 2000): void {
    if (this._firmwareUpdateInFlight) {
      this._logger.warn(
        "UpdateFirmware: a previous simulated update is still in flight; ignoring",
        LogType.OCPP,
      );
      return;
    }
    this._firmwareUpdateInFlight = true;

    const startDelay = Math.max(0, retrieveDate.getTime() - Date.now());
    const sequence: Array<
      "Downloading" | "Downloaded" | "Installing" | "Installed"
    > = ["Downloading", "Downloaded", "Installing", "Installed"];

    const fireStep = (index: number) => {
      if (index >= sequence.length) {
        this._firmwareUpdateInFlight = false;
        this._firmwareUpdateTimers = [];
        return;
      }
      this.sendFirmwareStatusNotification(sequence[index]);
      const t = setTimeout(() => fireStep(index + 1), intervalMs);
      this._firmwareUpdateTimers.push(t);
    };

    const startTimer = setTimeout(() => fireStep(0), startDelay);
    this._firmwareUpdateTimers.push(startTimer);
  }

  /** Mirrors `_firmwareUpdateInFlight` / `_firmwareUpdateTimers` for the
   *  signed variant — kept separate so a SignedUpdateFirmware.req can't
   *  collide with (or be blocked by) a plain UpdateFirmware.req train. */
  private _signedFirmwareUpdateInFlight = false;
  private _signedFirmwareUpdateTimers: NodeJS.Timeout[] = [];

  /**
   * OCPP 1.6 Security Whitepaper SignedUpdateFirmware.req: schedules a
   * simulated signed firmware update progression. After `retrieveDate` is
   * reached, fires SignedFirmwareStatusNotification.req in sequence —
   * Downloading → Downloaded → SignatureVerified → Installing → Installed
   * — with `intervalMs` between each transition, carrying `requestId` on
   * every notification. Same "no real binary, just walk the status
   * machine" approach as `simulateFirmwareUpdate` — no signature is
   * actually verified.
   */
  simulateSignedFirmwareUpdate(
    retrieveDate: Date,
    requestId: number,
    intervalMs = 2000,
  ): void {
    if (this._signedFirmwareUpdateInFlight) {
      this._logger.warn(
        "SignedUpdateFirmware: a previous simulated update is still in flight; ignoring",
        LogType.OCPP,
      );
      return;
    }
    this._signedFirmwareUpdateInFlight = true;

    const startDelay = Math.max(0, retrieveDate.getTime() - Date.now());
    const sequence: Array<
      | "Downloading"
      | "Downloaded"
      | "SignatureVerified"
      | "Installing"
      | "Installed"
    > = [
      "Downloading",
      "Downloaded",
      "SignatureVerified",
      "Installing",
      "Installed",
    ];

    const fireStep = (index: number) => {
      if (index >= sequence.length) {
        this._signedFirmwareUpdateInFlight = false;
        this._signedFirmwareUpdateTimers = [];
        return;
      }
      this.sendSignedFirmwareStatusNotification(sequence[index], requestId);
      const t = setTimeout(() => fireStep(index + 1), intervalMs);
      this._signedFirmwareUpdateTimers.push(t);
    };

    const startTimer = setTimeout(() => fireStep(0), startDelay);
    this._signedFirmwareUpdateTimers.push(startTimer);
  }

  /** Boot-notification gate accessors used by BootNotificationResultHandler. */
  markBootAccepted(): void {
    this._outbox.setBootStatus({ status: "Accepted" });
    if (
      this._ocppVersion === "OCPP-1.6J" &&
      (this._configuration.getInteger("SecurityProfile") ?? 0) >= 1
    ) {
      this._outbox.sendSecurityEventNotification("StartupOfTheDevice");
    }
    // §4.7/§4.8/§4.10 + errata 3.18: flush queued transaction-related
    // messages now that the boot gate is open. Run via queueMicrotask so
    // any post-boot StatusNotification fan-out goes first.
    queueMicrotask(() => this._outbox.flushPendingQueue());
  }

  markBootPending(): void {
    this._outbox.setBootStatus({ status: "Pending" });
  }

  markBootRejected(retryAfterSeconds: number): void {
    this._outbox.setBootStatus({
      status: "Rejected",
      retryAfter: new Date(Date.now() + retryAfterSeconds * 1000),
    });
    // Re-send BootNotification.req once the interval elapses (§4.2).
    setTimeout(() => {
      this.boot();
    }, retryAfterSeconds * 1000);
  }

  onBootNotificationAccepted(
    _currentTime: string | undefined,
    intervalSeconds: number,
  ): void {
    const interval = intervalSeconds > 0 ? intervalSeconds : 0;
    this._logger.info("Boot notification accepted", LogType.OCPP);
    this.markBootAccepted();
    // Send connector 0 (charge point level) status first
    this.updateConnectorStatus(0, OCPPStatus.Available);
    this.connectors.forEach((connector) => {
      // Reset to Available only when this is a fresh post-boot state —
      // i.e. autoReset is enabled AND no transaction is in flight. A
      // connector that was restored from `connector_runtime` with an
      // active transaction must keep its persisted status (typically
      // Preparing → Charging) so the CSMS-side view stays consistent
      // with the resumed transaction id; otherwise the CSMS sees us
      // bounce Charging → Available and the transaction is orphaned.
      // (See `restoreConnectorRuntimeFromDatabase` for the persisted
      // shape and `Connector.restoreRuntimeSnapshot` for how the
      // private fields are restored ahead of this StatusNotification.)
      if (connector.autoResetToAvailable && connector.transaction === null) {
        this.updateConnectorStatus(connector.id, OCPPStatus.Available);
        return;
      }
      this.updateConnectorStatus(connector.id, connector.status);
    });
    this.status = OCPPStatus.Available;

    if (interval > 0) {
      this.startHeartbeat(interval);
      this._logger.info(
        `Periodic Heartbeat enabled at ${interval}s interval`,
        LogType.HEARTBEAT,
      );
    } else {
      this.stopHeartbeat();
    }
  }

  onBootNotificationPending(intervalSeconds: number): void {
    const interval = intervalSeconds > 0 ? intervalSeconds : 0;
    this._logger.warn(
      `BootNotification Pending — only CSMS-initiated traffic allowed${
        interval > 0 ? `, retry interval=${interval}s` : ""
      }`,
      LogType.OCPP,
    );
    this.markBootPending();
    this.stopHeartbeat();
    // Spec: stay quiet but keep the WebSocket open. No retry timer here;
    // CSMS can move us to Accepted/Rejected via subsequent flow.
  }

  onBootNotificationRejected(intervalSeconds: number): void {
    const wait = intervalSeconds > 0 ? intervalSeconds : 60;
    this._logger.error(
      `BootNotification Rejected — silent for ${wait}s before retry`,
      LogType.OCPP,
    );
    this.markBootRejected(wait);
    this.stopHeartbeat();
  }

  boot(): void {
    // OCPP 1.6J §4.2: the CP MUST NOT send any other CALL message until
    // BootNotification has been Accepted. The connector-level
    // StatusNotification fan-out happens in BootNotificationResultHandler
    // after we get the Accepted response.
    this._outbox.sendBootNotification(this._bootNotification);
    this.error = "";
  }

  disconnect(): void {
    this._logger.info(
      this._webSocket
        ? "Disconnecting from WebSocket"
        : `Disconnecting ${this._ocppVersion} SOAP client`,
      this._webSocket ? LogType.WEBSOCKET : LogType.OCPP,
    );
    this.teardownAfterClose();
    this._webSocket?.disconnect();
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
    this._localAuthListManager.dispose();
    this._stationProfiles.clear();
    // Cancel any pending firmware-update simulation so its status train
    // doesn't keep firing against a dead WebSocket.
    this._firmwareUpdateTimers.forEach((t) => clearTimeout(t));
    this._firmwareUpdateTimers = [];
    this._firmwareUpdateInFlight = false;
    // ...and the signed variant's simulation too.
    this._signedFirmwareUpdateTimers.forEach((t) => clearTimeout(t));
    this._signedFirmwareUpdateTimers = [];
    this._signedFirmwareUpdateInFlight = false;
    this._scenarioHandledConnectors.clear();
    this._scenarioStopHandledConnectors.clear();
    // Cancel all ConnectionTimeOut watchdogs so the timer doesn't fire
    // against a disconnected CP.
    this._connectionTimeoutTimers.forEach((t) => clearTimeout(t));
    this._connectionTimeoutTimers.clear();
    // §4.1.1 serializer: drop the in-flight CALL + queued CALLs since the
    // WebSocket they target is gone. Transaction-related ones are already
    // persisted via PendingMessageQueue on prior send failures.
    this._outbox.onWebSocketClosed();
    // Flush any buffered log lines so the operator can still see the
    // last seconds of activity after the CP went down.
    this._logRepository.flush();
  }

  reset(): void {
    this.disconnect();
    this.connect();
  }

  applyRemoteReset(
    type: ChargePointResetType,
    source: ChargePointResetSource = "ocpp-call",
  ): void {
    if (source === "ocpp15-soap" && !this.isSoapChargePoint()) {
      this._logger.warn(
        "Ignoring SOAP Reset for a charge point that is not registered as a SOAP charge point",
        LogType.OCPP,
      );
      return;
    }
    const reason = type === "Hard" ? "HardReset" : "SoftReset";
    for (const connector of this.connectors.values()) {
      if (connector.transaction) {
        this.stopTransaction(connector, reason);
      }
    }
    this._logger.info(`Reset chargePoint: ${this._id}`, LogType.OCPP);
    if (type === "Hard") {
      this.reset();
    } else {
      this.boot();
    }
  }

  authorize(tagId: string): void {
    this._outbox.authorize(tagId);
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
        // Don't clobber a connector mid-transaction. The most common
        // caller is `teardownAfterClose` (WebSocket close), and writing
        // Unavailable here would race with the connector_runtime
        // persistence hook — the last snapshot before shutdown would
        // record Unavailable, and on the next daemon restart the
        // restore would resurrect the transaction inside an Unavailable
        // shell, divergent from the CSMS view that still thinks
        // Charging. Leave the per-connector status alone; the eventual
        // StopTransaction (CSMS-issued or scenario-driven) will move
        // it through Finishing → Available normally.
        if (connector.transaction !== null) return;
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
    options: StartTransactionOptions = {},
  ): void {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(
        `Connector ${connectorId} not found`,
        LogType.TRANSACTION,
      );
      return;
    }

    if (connector.transaction && connector.transaction.stopTime === null) {
      // Only a NOT-yet-stopped transaction blocks a new start. A cleaned/
      // rejected transaction (cleanTransaction sets stopTime but leaves the
      // object on the connector) must NOT block a legitimate retry.
      this._logger.warn(
        `Connector ${connectorId} already has an active transaction; ignoring duplicate start`,
        LogType.TRANSACTION,
      );
      return;
    }

    if (connector.availability !== "Operative") {
      this._logger.warn(
        `Connector ${connectorId} is ${connector.availability}; refusing to start transaction`,
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
      remoteStartId: options.remoteStartId,
      startTriggerReason: options.triggerReason,
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
    this._outbox.sendTransactionEvent({
      phase: "started",
      transaction,
      connectorId,
    });
    this.updateConnectorStatus(connectorId, OCPPStatus.Preparing);

    this._events.emit("transactionStarted", {
      connectorId,
      transactionId: 0,
      tagId,
    });
  }

  stopTransaction(
    connectorOrId: number | Connector,
    reason?: StopTransactionReason,
    options: StopTransactionOptions = {},
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
    if (options.triggerReason) {
      transaction.stopTriggerReason = options.triggerReason;
    }

    this._outbox.sendTransactionEvent({
      phase: "ended",
      transaction,
      connectorId: connector.id,
    });

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
    this._outbox.sendMeterValue(
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

    connector.dispose();
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
      this._outbox.sendStatusNotification(0, status);
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
    this._outbox.sendStatusNotification(connectorId, status, {
      errorCode: useErrorCode ? connector.currentErrorCode : "NoError",
      info: connector.errorInfo ?? undefined,
      vendorErrorCode: connector.vendorErrorCode ?? undefined,
    });
  }

  private startConnectionTimeout(connectorId: number): void {
    this.clearConnectionTimeout(connectorId);
    const timeoutSec = this._configuration?.connectionTimeOut();
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
      this._outbox.sendStatusNotification(0, this._status);
      this._connectors.forEach((connector) => {
        this._outbox.sendStatusNotification(connector.id, connector.status);
      });
      return;
    }
    if (connectorId === 0) {
      this._outbox.sendStatusNotification(0, this._status);
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
    this._outbox.sendStatusNotification(connectorId, connector.status);
  }
}
