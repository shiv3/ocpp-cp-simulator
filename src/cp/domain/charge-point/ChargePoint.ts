import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "../types/FirmwareLogStatus";
import { EventEmitter } from "../../shared/EventEmitter";
import type {
  DataTransferData,
  DataTransferResult,
} from "../types/DataTransfer";
import { Logger, LogType, LogEntry } from "../../shared/Logger";
import { HeartbeatService } from "../../application/services/HeartbeatService";
import { ClockAlignedMeterScheduler } from "./ClockAlignedMeterScheduler";
import { StateManager } from "../../application/services/StateManager";
import { OperationalTimeline } from "../../application/services/OperationalTimeline";
import { OperationalTimelineProjector } from "../../application/services/OperationalTimelineProjector";
import { Connector } from "../connector/Connector";
import type {
  BootNotificationResult,
  ChargePointEvents,
  ChargingProfileClearReason,
  ChargingProfileSource,
  ClearedChargingProfiles,
  IncomingCallCompletion,
  RegistrationStatus,
} from "./ChargePointEvents";
import { ConfigurationStore } from "./ConfigurationStore";
import type { IChargePointMessageHandler } from "../../infrastructure/transport/IChargePointMessageHandler";
import {
  OCPPWebSocket,
  type SocketClose,
} from "../../infrastructure/transport/OCPPWebSocket";
import type {
  CloseCause,
  ResolvedNetworkSimConfig,
} from "../../infrastructure/transport/network-sim";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "../../infrastructure/transport/wsUrlWithBasic";
import { getProtocolProfile } from "../../infrastructure/transport/profile/profiles";
import { OCPPSoapHandler } from "../../infrastructure/transport/soap";
import { Outbox } from "../transport/Outbox";
import { getOcppCallCatalog } from "../../infrastructure/transport/codec/ocppCallCatalog";
import { type OcppCallOutcome, type OcppCallRequest } from "../types/OcppCall";
import { OcppCallRejectedError } from "../errors/OcppCallErrors";
import type { Database } from "../persistence/Database";
import { LogRepository } from "../persistence/LogRepository";
import type {
  ChargePointErrorCode,
  OCPPAvailability,
  StatusNotificationOptions,
} from "../types/OcppTypes";
import { isOcpp2Version, isSoapVersion, OCPP_2_1 } from "../types/OcppVersion";
import { DeviceModelTargets } from "./DeviceModelTargets";
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
  TransactionChargingState,
  TransactionStartTriggerReason,
  TransactionStopTriggerReason,
  TransactionStoppedReason,
  TransactionUpdateOptions,
} from "../connector/Transaction";
import {
  reportedActivePowerW,
  type ReadingContext,
} from "../connector/MeterValueBuilder";
import {
  evseValueKey,
  RUNTIME_VALUE_KEYS,
  toV2ConnectorStatus,
  V2_CONNECTOR_STATUSES,
} from "./runtimeValueKeys";
import { ReservationManager } from "../reservation/Reservation";
import { LocalAuthListManager } from "../auth/LocalAuthList";
import { idTokenMaxLength } from "../auth/AuthorizationCacheSeed";
import { AuthorizationCache } from "../auth/AuthorizationCache";
import {
  StationAuthorization,
  type CsmsAuthorizationResult,
} from "../auth/StationAuthorization";
import type { LocalOnlyDecision } from "../auth/LocalAuthorizationResolver";
import {
  ChargingProfileStore,
  type ProfileRemoveCriteria,
} from "./ChargingProfileStore";
import type { ActiveChargingProfile } from "../connector/Connector";
import { CertificateStore } from "../security/CertificateStore";
import {
  MONITORING_BASES,
  MonitoringStore,
} from "../monitoring/MonitoringStore";
import { DEFAULT_MONITOR_CATALOG } from "../monitoring/monitorCatalog";
import { MonitorEvaluation } from "../monitoring/MonitorEvaluation";
import type { MonitoredReading } from "../monitoring/evaluateMonitor";
import { VariableMonitorRepository } from "../monitoring/VariableMonitorRepository";
import {
  MAX_MONITOR_SEVERITY,
  MIN_MONITOR_SEVERITY,
  type VariableMonitor,
} from "../monitoring/VariableMonitor";
import {
  MONITORING_CTRLR_KEYS,
  MONITORING_REQUEST_MAX_BYTES,
  MONITORING_REQUEST_MAX_ITEMS,
} from "../monitoring/monitoringCtrlrKeys";
import { renderConfigValue } from "../../infrastructure/transport/v201/renderConfigValue";
import { OcmfMeter } from "../connector/SignedMeterData";
import {
  DEFAULT_ID_TAG,
  IdTagPool,
  type IdTagDistribution,
} from "../auth/IdTagPool";
import {
  SupervisionUrlPool,
  type UrlDistribution,
} from "../../infrastructure/transport/SupervisionUrlPool";

/** RFC 6455 Normal Closure, and No Status Received (a close without a code). */
const NORMAL_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1005]);

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
  /** OCPP 2.x Started-event chargingState (#335); `Charging` when absent. */
  chargingState?: TransactionChargingState;
}

/**
 * Result of `ChargePoint.startTransaction` (issue #181). Non-throwing: a
 * denied local-authorize gate is reported here rather than as a thrown
 * error, so scenario-layer callers can log-and-continue instead of
 * aborting. `denialStatus` is only set when `started` is `false` because
 * Authorize.conf came back non-Accepted; the other early-return guards
 * (connector missing/busy/inoperative) leave it `undefined`.
 */
export interface StartTransactionOutcome {
  started: boolean;
  denialStatus?: string;
}

interface StopTransactionOptions {
  triggerReason?: TransactionStopTriggerReason;
  /** OCPP 2.x Ended-event stoppedReason named explicitly (#335); when
   *  absent the encoder derives it from the 1.6 `reason`. */
  stoppedReason?: TransactionStoppedReason;
}

/**
 * Per-action inbound call policy (issue #247). When a CSMS-initiated CALL
 * arrives for an action with a policy, the CP replies with CALLERROR or
 * remains silent instead of processing normally. Policies are sticky and
 * survive reconnects — they must be explicitly cleared (not one-shot like
 * responseOverride).
 */
export type InboundCallPolicy =
  | { kind: "callerror"; errorCode: string; errorDescription: string }
  | { kind: "ignore" };

/**
 * Certificate quirks for CSR generation and acceptance (issue #247).
 * Used to emulate OCPP conformance tool behavior and test edge cases.
 * All fields are optional; unset fields revert to default behavior.
 */
export interface CertificateQuirks {
  /** Key algorithm for generated CSRs. Default (unset): ECDSA P-256. */
  csrKeyAlgorithm?: "ECDSA" | "RSA";
  /** Line endings for emitted CSR PEM. Default (unset): "lf". */
  csrPemLineEndings?: "lf" | "crlf";
  /** Accepted signature algorithms for certificates received via CertificateSigned.
   *  Unset/empty = accept anything (default behavior). The handler checks the leaf
   *  certificate's signature algorithm name (via X509Certificate.signatureAlgorithm.name)
   *  and rejects the chain if its name is not in this list. Matchable algorithm names
   *  include "ECDSA" (P-256, P-384, P-521), "RSASSA-PKCS1-v1_5" (RSA PKCS#1),
   *  and "RSA-PSS" (RSA-PSS). */
  requiredCertificateSignatureAlgorithms?: string[];
  /** OCPP 1.6 configuration keys to omit from GetConfiguration responses.
   *  When a hidden key is requested by name, it appears in the response's
   *  unknownKey array instead of the configurationKey list. Unset/empty =
   *  no keys are hidden (default behavior). */
  hiddenConfigurationKeys?: string[];
}

export type ChargePointResetType = "Hard" | "Soft";
type ChargePointResetSource = "ocpp-call" | "ocpp15-soap";

export interface ChargePointTransportOptions {
  readonly centralSystemUrl?: string;
  readonly soapCallbackUrl?: string;
  readonly soapPath?: string;
  readonly soapRequestTimeoutMs?: number;
  /**
   * Every supervision URL this charge point may use, when it was given more
   * than one. `wsUrl` stays the first of them, so everything that reports or
   * persists a URL keeps seeing one string; the pool picks per attempt.
   * OCPP-J only — SOAP has no reconnect loop to rotate.
   */
  readonly supervisionUrls?: readonly string[];
  readonly urlDistribution?: UrlDistribution;
  /** Resolved idTags this charge point draws from (#299). */
  readonly idTags?: readonly string[];
  readonly idTagDistribution?: IdTagDistribution;
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
  private readonly _idTagPool: IdTagPool | null;
  private readonly _outbox: Outbox;
  private readonly _heartbeat: HeartbeatService;
  private readonly _clockAligned: ClockAlignedMeterScheduler;
  private readonly _stateManager: StateManager;
  private readonly _timeline: OperationalTimeline;
  private readonly _timelineProjector: OperationalTimelineProjector;
  private readonly _logRepository: LogRepository;
  private readonly _reservationManager: ReservationManager;
  private readonly _localAuthListManager: LocalAuthListManager;
  private readonly _authorization: StationAuthorization;
  // §3.13.3: profiles installed with connectorId=0 (ChargePointMaxProfile,
  // station-wide TxDefaultProfile) belong at the CP level, not duplicated
  // onto every connector. Connectors consult this store at composite time.
  private readonly _stationProfiles: ChargingProfileStore =
    new ChargingProfileStore();
  private readonly _certificateStore: CertificateStore;
  // OCPP 2.x variable monitors and monitoring level (N04-N06, #457).
  private readonly _monitoring = new MonitoringStore(DEFAULT_MONITOR_CATALOG);
  // #538: Target attributes of the 2.1 device model (EVSE.Power).
  private readonly _deviceModelTargets = new DeviceModelTargets();
  // Their evaluation into NotifyEvent; OCPP 2.x only (N07, #457).
  private _monitorEvaluation: MonitorEvaluation | undefined;
  private readonly _configuration: ConfigurationStore;
  // #315: one simulated signing meter per connector, made on first use.
  private readonly _signedMeters = new Map<number, OcmfMeter>();

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
  // Diagnostic-only, paired with _scenarioHandledConnectors: whenever
  // RemoteStartTransaction lands via the DEFAULT path (no scenario armed on
  // this connector yet), the timestamp is recorded here. A scenario that
  // arms afterwards (registerScenarioHandler) consults this to detect that
  // it just missed a call that arrived while it was still walking toward
  // the trigger node — the "run_scenario raced RemoteStartTransaction"
  // footgun: the CSMS command silently starts a real transaction outside
  // the scenario, and the scenario then parks forever waiting for a call
  // that already happened. Consumed (deleted) on read via
  // takeDefaultHandledRemoteStart, so a warning never fires twice and a
  // stale/unrelated bypass can't leak into a later, unconnected run.
  private readonly _lastDefaultHandledRemoteStart: Map<number, number> =
    new Map();
  // Mirror of the above for the RemoteStopTransaction / stop-side bypass.
  private readonly _lastDefaultHandledRemoteStop: Map<number, number> =
    new Map();
  /** One-shot canned `{ status }` responses per incoming action,
   *  armed by a scenario responseOverride node (issue #110). */
  private readonly _responseOverrides = new Map<string, string>();
  /** Sticky per-action inbound call policies (issue #247). When a CSMS-initiated
   *  CALL arrives for an action with a policy, reply with CALLERROR or stay silent
   *  instead of processing normally. Survive reconnects until explicitly cleared. */
  private readonly _inboundCallPolicies = new Map<string, InboundCallPolicy>();
  /** Certificate quirks for CSR generation and acceptance (issue #247).
   *  Used to emulate OCPP conformance tool behavior. Sticky until cleared. */
  private _certificateQuirks: CertificateQuirks = {};
  // §4.9 B6: per-connector ConnectionTimeOut watchdog. Started when a
  // connector enters Preparing, cleared on any other transition. If the
  // timer fires we auto-transition the connector to Finishing.
  private readonly _connectionTimeoutTimers: Map<number, NodeJS.Timeout> =
    new Map();
  // §4.9 S3: whether this SOAP CP has a soapCallbackUrl (server-hosted) vs
  // send-only (browser local mode). For non-SOAP versions, always false.
  private readonly _hasSoapCallbackUrl: boolean;
  // Network simulation summary: { enabled, manualRuleIds } when a config has
  // been applied via setNetworkSimConfig, null for SOAP CPs or when no config
  // has been applied yet.
  private _networkSimSummary: {
    enabled: boolean;
    manualRuleIds: string[];
  } | null = null;

  constructor(
    private readonly _id: string,
    private readonly _bootNotification: BootNotification,
    connectorCount: number,
    wsUrl: string,
    basicAuthSettings: BasicAuthSettings | null,
    autoMeterValueSetting: AutoMeterValueSetting | null,
    /** SQLite-backed persistence for ConfigurationStore, PendingMessageQueue,
     *  CertificateStore and per-connector availability. `null` keeps everything in-memory —
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
    // #456: installed certificates survive a restart when state persists.
    this._certificateStore = new CertificateStore(this._id, this._database);
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
      this._webSocket.observers.on("simulatedDisconnect", (fault) =>
        this._events.emit("networkFaultInjected", fault),
      );
      this._webSocket.observers.on("reconnectScheduled", (info) =>
        this._events.emit("reconnecting", info),
      );
      const supervisionUrls = transportOptions.supervisionUrls;
      if (supervisionUrls && supervisionUrls.length > 1) {
        this._webSocket.setSupervisionUrlPool(
          new SupervisionUrlPool(
            supervisionUrls,
            transportOptions.urlDistribution,
            this._id,
          ),
        );
      }
      this._messageHandler = getProtocolProfile(
        this._ocppVersion,
      ).createMessageHandler(this, this._webSocket, this._logger);
    }
    this._outbox = new Outbox(this._messageHandler);

    this._heartbeat = new HeartbeatService(this._logger);
    this._heartbeat.setHeartbeatCallback(() => this._outbox.sendHeartbeat());
    this._clockAligned = new ClockAlignedMeterScheduler((boundary) =>
      this.emitClockAlignedSamples(boundary),
    );

    // #299: a charge point that draws from a pool when a call names no tag.
    // An explicit tagId always wins, so this only ever fills a gap.
    this._idTagPool =
      transportOptions.idTags && transportOptions.idTags.length > 0
        ? new IdTagPool(
            transportOptions.idTags,
            transportOptions.idTagDistribution,
            this._id,
          )
        : null;

    this._reservationManager = new ReservationManager(
      this._logger,
      (connectorId) => this.onReservationExpired(connectorId),
    );
    this._localAuthListManager = new LocalAuthListManager(this._logger);
    // #452: the policy is read on every decision, so ChangeConfiguration
    // applies at once. `_configuration` is assigned further down; nothing
    // reads the policy before the constructor returns.
    this._authorization = new StationAuthorization({
      cache: new AuthorizationCache(this._id, this._database),
      localList: this._localAuthListManager,
      policy: () => ({
        cacheEnabled: this._configuration.authorizationCacheEnabled(),
        localListEnabled: this._configuration.localAuthListEnabled(),
        localPreAuthorize: this._configuration.localPreAuthorize(),
        localAuthorizeOffline: this._configuration.localAuthorizeOffline(),
        allowOfflineTxForUnknownId:
          this._configuration.allowOfflineTxForUnknownId(),
        // 2.x AuthCacheCtrlr.LifeTime; a 1.6 store has no such key → null.
        cacheLifetimeSeconds: this._configuration.authCacheLifeTimeSeconds(),
        localListChecksExpiry: true,
      }),
      idTokenMaxLength: idTokenMaxLength(this._ocppVersion),
    });

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

    // #448: subscribed before any connection or status event can fire.
    this._timeline = new OperationalTimeline(this._id);
    this._timelineProjector = new OperationalTimelineProjector(
      this._timeline,
      this._events,
      this._connectors,
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
    if (isOcpp2Version(this._ocppVersion)) this.wireVariableMonitoring();
    // A persisted override never fires onChange; the scheduler only runs
    // once a boot is Accepted (#454).
    this._clockAligned.setIntervalSeconds(
      this._configuration.clockAlignedDataInterval(),
    );
    // A value persisted with --state-db is in force from the first open.
    this._webSocket?.setPingInterval(
      this._configuration.webSocketPingInterval(),
    );

    // §5.2: a CP-level Unavailable set previously must survive a reboot.
    // We don't actually transition status here (no WebSocket yet); the
    // saved flag is reapplied when ChangeAvailability runs or when the
    // operator inspects the persisted state.
    const persistedCp = this.loadAvailability(0);
    if (persistedCp === "Inoperative") {
      this._status = OCPPStatus.Unavailable;
      if (this._monitorEvaluation) this.publishStationAvailability();
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

  /**
   * OCPP 2.x variable monitoring (#457): restore the persisted monitors
   * (N07.FR.13), keep the table in step with the store, and evaluate the
   * monitors whenever SetVariables or a scenario `configSet` node changes
   * the value they watch (N07). Events go out after the answer that caused
   * them, and only while the boot is Accepted (B02.FR.02): reporting starts
   * off and `applyBootAccepted` turns it on.
   */
  private wireVariableMonitoring(): void {
    const repository = new VariableMonitorRepository(this._id, this._database);
    const persisted = repository.load();
    const storedBase = repository.loadActiveBase();
    // #538: the hardwired monitors, the persisted ones, and on a station
    // that never stored its catalog state, the preconfigured ones. The
    // station's own monitors are stored too, so they keep their triggered
    // flag (N07.FR.14) and a later start knows which were deleted.
    this._monitoring.initialize(
      persisted.map((p) => p.monitor),
      storedBase,
    );
    for (const monitor of this._monitoring.list()) {
      if (
        monitor.origin === "HardWiredMonitor" ||
        (storedBase === undefined && monitor.origin === "PreconfiguredMonitor")
      ) {
        repository.save(monitor);
      }
    }
    if (storedBase === undefined) {
      repository.saveActiveBase(this._monitoring.activeMonitoringBase);
    }
    this.publishMonitoringCtrlr();
    this.publishRuntimeValues();
    // Registered before the evaluation's own listener, so a new row exists
    // when its triggered flag is first written.
    this._monitoring.onChange((event) => {
      if (event.kind === "installed") repository.save(event.monitor);
      else if (event.kind === "cleared") repository.delete(event.monitor.id);
      else if (event.kind === "levelChanged") {
        this.publishActiveMonitoringLevel();
      } else {
        repository.saveActiveBase(event.base);
        this.publishActiveMonitoringBase();
      }
    });
    const evaluation = new MonitorEvaluation(
      {
        store: this._monitoring,
        read: (key) => this.readMonitoredValue(key),
        emit: (events) =>
          queueMicrotask(() => this._outbox.sendNotifyEvent(events)),
        // N07.FR.04, N08.FR.03: queued at once, in production order with
        // the TransactionEvents queued offline (#538).
        queue: (events) => this._outbox.queueNotifyEvent(events),
        offlineQueuingSeverity: () =>
          this._configuration.offlineQueuingSeverity(),
        transactionActive: () =>
          [...this._connectors.values()].some((c) => c.hasRunningTransaction),
        transactionIdOf: (monitor) => this.monitoredTransactionId(monitor),
        onTriggeredChange: (id, triggered) =>
          repository.setTriggered(id, triggered),
      },
      new Map(persisted.map((p) => [p.monitor.id, p.triggered])),
    );
    // Not connected yet: offline until the first Boot Accepted (#538).
    evaluation.setOffline();
    this._monitorEvaluation = evaluation;
    this._configuration.onChange((key) => evaluation.valueChanged(key));
    this._deviceModelTargets.onChange((key) => evaluation.valueChanged(key));
  }

  /**
   * The read-only MonitoringCtrlr variables of the 2.x device model (#538),
   * as runtime configuration keys: the request limits it advertises for
   * Set/ClearVariableMonitoring, and the monitoring level in force.
   */
  private publishMonitoringCtrlr(): void {
    const keys = MONITORING_CTRLR_KEYS;
    for (const items of [
      keys.itemsPerSetVariableMonitoring,
      keys.itemsPerClearVariableMonitoring,
    ]) {
      this._configuration.defineRuntimeIntegerKey(
        items,
        MONITORING_REQUEST_MAX_ITEMS,
      );
    }
    for (const bytes of [
      keys.bytesPerSetVariableMonitoring,
      keys.bytesPerClearVariableMonitoring,
    ]) {
      this._configuration.defineRuntimeIntegerKey(
        bytes,
        MONITORING_REQUEST_MAX_BYTES,
      );
    }
    this.publishActiveMonitoringLevel();
    this.publishActiveMonitoringBase();
  }

  /**
   * The runtime values of the 2.x device model (#538), as read-only runtime
   * keys refreshed on every connector event that can move them (status,
   * meter tick, SoC, EV settings, charging profiles, transaction). A key is
   * redefined only when its value changes, so a monitor is evaluated on
   * change only, never once per meter tick.
   */
  private publishRuntimeValues(): void {
    for (const connector of this._connectors.values()) {
      const publish = () => this.publishConnectorValues(connector);
      publish();
      // 2.1: EVSE.Power has a Target, for TargetDelta monitors (N07.FR.22).
      if (this._ocppVersion === OCPP_2_1) {
        this._deviceModelTargets.declare(
          evseValueKey(RUNTIME_VALUE_KEYS.evsePower, connector.id),
        );
      }
      connector.events.on("statusChange", publish);
      connector.events.on("meterValueChange", publish);
      connector.events.on("socChange", publish);
      connector.events.on("evSettingsChange", publish);
      connector.events.on("transactionChange", publish);
      connector.events.on("chargingProfilesChange", publish);
      connector.events.on("scheduleLimitChange", publish);
    }
    this.publishStationAvailability();
  }

  /** `EVSE.Power`, `EVSE.AvailabilityState` and
   *  `Connector.AvailabilityState` of EVSE N (connector N). */
  private publishConnectorValues(connector: Connector): void {
    const keys = RUNTIME_VALUE_KEYS;
    this.publishRuntimeInteger(
      evseValueKey(keys.evsePower, connector.id),
      reportedActivePowerW(connector),
    );
    const state = toV2ConnectorStatus(connector.status);
    for (const prefix of [keys.evseState, keys.connectorState]) {
      this.publishRuntimeString(evseValueKey(prefix, connector.id), state);
    }
  }

  /** `ChargingStation.AvailabilityState`: the station-level status. */
  private publishStationAvailability(): void {
    this.publishRuntimeString(
      RUNTIME_VALUE_KEYS.chargingStationAvailabilityState,
      toV2ConnectorStatus(this._status),
    );
  }

  private publishRuntimeInteger(key: string, value: number): void {
    if (this._configuration.get(key)?.value === value) return;
    this._configuration.defineRuntimeIntegerKey(key, value);
  }

  private publishRuntimeString(key: string, value: string): void {
    if (this._configuration.get(key)?.value === value) return;
    this._configuration.defineRuntimeKey(key, value, V2_CONNECTOR_STATUSES);
  }

  /** `ActiveMonitoringBase` follows SetMonitoringBase. */
  private publishActiveMonitoringBase(): void {
    this._configuration.defineRuntimeKey(
      MONITORING_CTRLR_KEYS.activeMonitoringBase,
      this._monitoring.activeMonitoringBase,
      MONITORING_BASES,
    );
  }

  /** `ActiveMonitoringLevel` follows SetMonitoringLevel (0-9). */
  private publishActiveMonitoringLevel(): void {
    this._configuration.defineRuntimeIntegerKey(
      MONITORING_CTRLR_KEYS.activeMonitoringLevel,
      this._monitoring.monitoringLevel,
      { min: MIN_MONITOR_SEVERITY, max: MAX_MONITOR_SEVERITY },
    );
  }

  /**
   * The 2.x transactionId a monitor's event is linked to (#538): the
   * transaction running on the monitor's EVSE (EVSE N is connector N), or,
   * for a station-level monitor reporting only during a transaction, the
   * transaction when exactly one runs. Otherwise none.
   */
  private monitoredTransactionId(monitor: VariableMonitor): string | undefined {
    const running = (c: Connector | undefined) =>
      c?.hasRunningTransaction ? c.transaction?.cpTransactionId : undefined;
    const evse = monitor.component.evse;
    if (evse !== undefined) return running(this._connectors.get(evse.id));
    if (!monitor.transaction) return undefined;
    const active = [...this._connectors.values()].filter(
      (c) => c.hasRunningTransaction,
    );
    return active.length === 1 ? running(active[0]) : undefined;
  }

  /** A configuration value as a monitor sees it: GetVariables' rendering
   *  (empty when write-only, N07.FR.10) and its number, if it is one. */
  private readMonitoredValue(key: string): MonitoredReading | undefined {
    const entry = this._configuration.get(key);
    if (entry === undefined) return undefined;
    const text = renderConfigValue(entry);
    const target = this._deviceModelTargets.get(key);
    return typeof entry.value === "number"
      ? { numeric: entry.value, text, ...(target !== undefined && { target }) }
      : { text };
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
        case "WebSocketPingInterval":
          // #406: re-arms the ping timer at once on an open socket.
          if (typeof value === "number") {
            this._webSocket?.setPingInterval(value);
          }
          break;
        case "ClockAlignedDataInterval":
          // #454: takes effect at once on the new grid while boot is Accepted.
          if (typeof value === "number") {
            this._clockAligned.setIntervalSeconds(value);
          }
          this._logger.info(
            `ClockAlignedDataInterval=${String(value)}${
              this._configuration.meterValuesAlignedData().length === 0
                ? " (MeterValuesAlignedData is empty: nothing will be sent)"
                : ""
            }`,
            LogType.CONFIGURATION,
          );
          break;
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

  /** #406: whether the transport can send WebSocket ping frames. False for
   *  SOAP (no socket) and the browser build (no `ping()` in the DOM API). */
  get supportsWebSocketPing(): boolean {
    return this._webSocket?.supportsPing ?? false;
  }

  /** Standard OCPP Configuration Keys store. */
  get configuration(): ConfigurationStore {
    return this._configuration;
  }

  /**
   * The connector's simulated OCMF signing meter while `SampledDataSignReadings`
   * is true, else `null` (#315). The ephemeral key is made on first use, held
   * in memory only, and published read-only as `MeterPublicKey<connectorId>`
   * so a CSMS can validate against it (2.x stations also send it in every
   * `signedMeterValue`).
   */
  signedMeterFor(connectorId: number): OcmfMeter | null {
    if (!this._configuration.signReadings()) return null;
    let meter = this._signedMeters.get(connectorId);
    if (!meter) {
      meter = new OcmfMeter({
        meterSerial: `${this._id}-${connectorId}`,
        gatewayId: "ocpp-cp-simulator",
        gatewaySerial: this._id,
      });
      this._signedMeters.set(connectorId, meter);
      this._configuration.defineRuntimeKey(
        `MeterPublicKey${connectorId}`,
        meter.publicKeyHex,
      );
    }
    return meter;
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
   * - Server-hosted (with callback): the action must be dispatchable in the
   *   version's dialect — declared with target "cp", or a bidirectional op
   *   (DataTransfer). Mirrors OCPPSoapServer's dispatch rule so the guard
   *   matches what the server actually answers (issue #257: 1.5 now dispatches
   *   its full CS→CP surface, not just Reset).
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

    // SOAP with callback: the action must be dispatchable in this dialect —
    // target "cp" or a bidirectional op — matching OCPPSoapServer dispatch.
    if (!(SOAP_OPERATION_NAMES as readonly string[]).includes(action)) {
      return false;
    }
    const dialect = soapDialectForVersion(this._ocppVersion);
    const metadata = dialect.operationMetadata[action as SoapOperation];
    return metadata?.target === "cp" || metadata?.bidirectional === true;
  }

  get connectorNumber(): number {
    return this._connectors.size;
  }

  get connectors(): Map<number, Connector> {
    return new Map(this._connectors);
  }

  /**
   * The idTag to present when the caller named none.
   *
   * `null` when this charge point has no pool, so every existing call site
   * keeps its own fallback rather than inheriting one.
   */
  nextIdTag(connectorId = 0): string | null {
    return this._idTagPool?.next(connectorId) ?? null;
  }

  /**
   * The idTag a control-plane call presents (#299): an explicit tag always
   * wins, the pool only fills a gap, and a charge point without one keeps the
   * historical literal. OCPP messages always carry a tag, so callers resolve
   * before building one.
   */
  resolveIdTag(tagId: string | undefined, connectorId?: number): string {
    return tagId ?? this.nextIdTag(connectorId) ?? DEFAULT_ID_TAG;
  }

  /**
   * Replace the pool's tags after an `idTagPool.file` was edited (#314).
   *
   * `false` when this charge point has no pool: it was created without one, and
   * conjuring one here would make a `--watch` daemon behave differently from
   * the `cp.create` that produced the charge point.
   */
  /** Whether a pool exists to replace — the same condition
   *  {@link replaceIdTags} refuses on, asked without mutating anything, so a
   *  caller can persist before it changes the live charge point (#314). */
  canReplaceIdTags(tags: readonly string[]): boolean {
    return this._idTagPool !== null && tags.length > 0;
  }

  replaceIdTags(tags: readonly string[]): boolean {
    if (!this._idTagPool || !this.canReplaceIdTags(tags)) return false;
    this._idTagPool.replaceTags(tags);
    return true;
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

  /** #448: operational timeline of this charge point. */
  get timeline(): OperationalTimeline {
    return this._timeline;
  }

  get logger(): Logger {
    return this._logger;
  }

  get reservationManager(): ReservationManager {
    return this._reservationManager;
  }

  /**
   * A reservation lapsed (ReservationManager expiry cleanup) without an
   * explicit CancelReservation. Mirror the cancel path — drive the connector
   * back to Available through updateConnectorStatus so the CSMS sees the
   * transition on the wire — but only when it's still Reserved: a connector
   * that moved to Charging/Preparing/etc. in the meantime must not be clobbered.
   */
  private onReservationExpired(connectorId: number): void {
    const connector = this.getConnector(connectorId);
    if (connector && connector.status === OCPPStatus.Reserved) {
      this.updateConnectorStatus(connectorId, OCPPStatus.Available);
    }
  }

  get localAuthListManager(): LocalAuthListManager {
    return this._localAuthListManager;
  }

  /** OCPP 2.x variable monitors (SetVariableMonitoring, #457). */
  get monitoring(): MonitoringStore {
    return this._monitoring;
  }

  /** The device-model variables with a Target attribute (2.1, #538). */
  get deviceModelTargets(): DeviceModelTargets {
    return this._deviceModelTargets;
  }

  /** Local authorization (#452): Authorization Cache + Local Authorization
   *  List, and the decision over them. */
  get authorization(): StationAuthorization {
    return this._authorization;
  }

  /** Whether the CSMS is reachable now (#452 offline authorization). A SOAP
   *  charge point has no connection state and counts as online, which
   *  keeps its local start flow as it was. */
  isOnline(): boolean {
    if (!this._webSocket) return true;
    return this._webSocket.isConnected();
  }

  /** Feed a CSMS verdict on `idToken` to the Authorization Cache (#452):
   *  called by the Authorize / StartTransaction / StopTransaction result
   *  handlers. A no-op while the cache is disabled or for an identifier of
   *  the Local Authorization List (1.6 §3.5.3). */
  recordAuthorizationResult(
    idToken: string,
    result: CsmsAuthorizationResult,
  ): void {
    if (this._authorization.recordCsmsResult(idToken, result)) {
      this._logger.debug(
        `Authorization cache updated: ${idToken} → ${result.status}`,
        LogType.TRANSACTION,
      );
    }
  }

  /** ClearCache (1.6 §5.4): empty the Authorization Cache. Returns whether
   *  it could be cleared. */
  clearAuthorizationCache(): boolean {
    return this._authorization.clearCache();
  }

  /** Read-only: install and remove profiles with `applyChargingProfile` /
   *  `clearChargingProfiles`, which report the change (#469). */
  get stationProfiles(): Pick<ChargingProfileStore, "all" | "getActive"> {
    return this._stationProfiles;
  }

  /**
   * Install a profile on the station store (`connectorId` 0) or on its
   * connector, replacing any profile with the same id in that scope, and
   * emit `chargingProfileApplied`. Validation is the caller's job.
   *
   * @returns `false`, changing nothing, when the connector does not exist.
   */
  applyChargingProfile(
    profile: ActiveChargingProfile,
    source: ChargingProfileSource,
  ): boolean {
    let replaced: boolean;
    if (profile.connectorId === 0) {
      replaced = this._stationProfiles.add(profile);
    } else {
      const connector = this.getConnector(profile.connectorId);
      if (!connector) return false;
      replaced = connector.addChargingProfile(profile);
    }
    this._events.emit("chargingProfileApplied", {
      connectorId: profile.connectorId,
      profile,
      replaced,
      source,
    });
    return true;
  }

  /**
   * Remove the profiles matching `criteria` (1.6 §5.4 / 2.x K10 targets):
   * no `connectorId` clears the station store and every connector, `0` the
   * station store only, `> 0` that connector. Emits one
   * `chargingProfilesCleared` per scope that lost a profile.
   *
   * @returns The non-empty scopes, station store first.
   */
  clearChargingProfiles(
    connectorId: number | undefined,
    criteria: ProfileRemoveCriteria,
    reason: ChargingProfileClearReason,
  ): ClearedChargingProfiles[] {
    const cleared: ClearedChargingProfiles[] = [];
    const report = (scope: number, profiles: ActiveChargingProfile[]) => {
      if (profiles.length === 0) return;
      cleared.push({ connectorId: scope, profiles });
      this._events.emit("chargingProfilesCleared", {
        connectorId: scope,
        profiles,
        reason,
      });
    };
    if (connectorId === undefined || connectorId === 0) {
      report(0, this._stationProfiles.take(criteria));
    }
    if (connectorId === 0) return cleared;
    const targets =
      connectorId === undefined
        ? this._connectors.values()
        : [this.getConnector(connectorId)];
    for (const connector of targets) {
      if (connector) {
        report(connector.id, connector.takeChargingProfiles(criteria));
      }
    }
    return cleared;
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

  /** Record that RemoteStartTransaction for `connectorId` was just handled
   *  by the default (non-scenario) path — i.e. isScenarioHandled(connectorId)
   *  was false at delivery time. See _lastDefaultHandledRemoteStart. */
  noteDefaultHandledRemoteStart(connectorId: number): void {
    this._lastDefaultHandledRemoteStart.set(connectorId, Date.now());
  }

  /** Consume (and remove) the timestamp recorded by
   *  noteDefaultHandledRemoteStart for `connectorId`, if any exists at or
   *  after `sinceMs`. Returns that epoch-ms timestamp, or null if there is
   *  none — or it predates `sinceMs`, i.e. it's a stale bypass from before
   *  the caller's own run started and therefore unrelated to it. Always
   *  deletes the entry so a stale record can't linger indefinitely. */
  takeDefaultHandledRemoteStart(
    connectorId: number,
    sinceMs: number,
  ): number | null {
    const ts = this._lastDefaultHandledRemoteStart.get(connectorId);
    this._lastDefaultHandledRemoteStart.delete(connectorId);
    return ts !== undefined && ts >= sinceMs ? ts : null;
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

  /** Mirror of noteDefaultHandledRemoteStart for the stop side. */
  noteDefaultHandledRemoteStop(connectorId: number): void {
    this._lastDefaultHandledRemoteStop.set(connectorId, Date.now());
  }

  /** Mirror of takeDefaultHandledRemoteStart for the stop side. */
  takeDefaultHandledRemoteStop(
    connectorId: number,
    sinceMs: number,
  ): number | null {
    const ts = this._lastDefaultHandledRemoteStop.get(connectorId);
    this._lastDefaultHandledRemoteStop.delete(connectorId);
    return ts !== undefined && ts >= sinceMs ? ts : null;
  }

  notifyIncomingCall(
    action: string,
    payload: unknown,
    messageId?: string,
  ): void {
    this._events.emit("incomingCallReceived", { action, messageId, payload });
  }

  /** #396: the answer to an incoming CSMS CALL is decided. */
  notifyIncomingCallCompleted(completion: IncomingCallCompletion): void {
    this._events.emit("incomingCallCompleted", completion);
  }

  /** Called by StartTransactionResultHandler when StartTransaction.conf
   *  carries a non-Accepted idTagInfo.status (issue #181). */
  notifyStartTransactionNotAccepted(
    connectorId: number,
    status: string,
    stopped: boolean,
  ): void {
    this._events.emit("startTransactionNotAccepted", {
      connectorId,
      status,
      stopped,
    });
  }

  /**
   * Called by the 1.6 handler when StartTransaction.req is answered with a
   * CALLERROR (#447), once `cleanTransaction` has closed the connector's
   * transaction. Listeners still find the closed transaction on the
   * connector (its stop time and meter), then it is detached: the CSMS never
   * accepted it, so nothing may stop it again. Left attached, every path that
   * asks "is there a transaction?" — Reset, UnlockConnector, RemoteStop,
   * ChangeAvailability — took it for a running one, and the stop paths sent
   * a StopTransaction.req with the `0` placeholder id (#491). A transaction
   * a listener began in the meantime is a new one and stays.
   */
  notifyTransactionStartFailed(connectorId: number, errorCode: string): void {
    const connector = this.getConnector(connectorId);
    const failed = connector?.transaction ?? null;
    this._events.emit("transactionStartFailed", { connectorId, errorCode });
    if (connector && failed && connector.transaction === failed) {
      connector.stopTransaction();
    }
  }

  /** Called by the 2.x handler on each failed TransactionEvent
   *  transmission: a CALLERROR (#490) or no answer within `MessageTimeout`
   *  (#529). Reports only: the transaction is untouched. */
  notifyTransactionMessageRejected(
    event: ChargePointEvents["transactionMessageRejected"],
  ): void {
    this._events.emit("transactionMessageRejected", event);
  }

  /** Called by the 2.x handler when a TransactionEvent failed its last
   *  attempt and is dropped (#490). Reports only, like the above. */
  notifyTransactionMessageDiscarded(
    event: ChargePointEvents["transactionMessageDiscarded"],
  ): void {
    this._events.emit("transactionMessageDiscarded", event);
  }

  /** Called by AuthorizeResultHandler when Authorize.conf arrives
   *  (issue #181). Fans out to any in-flight `authorizeAndWait` callers
   *  tagId-matched via the `authorizeResult` event. */
  notifyAuthorizeResult(tagId: string, status: string): void {
    this._events.emit("authorizeResult", { tagId, status });
  }

  /**
   * Authorize `tagId` for a local start (issues #181, #452). Resolves with
   * an idTagInfo/idTokenInfo status ("Accepted", "Invalid", "Expired",
   * "Blocked", ...). Never rejects.
   *
   * The local decision comes first (see `auth/LocalAuthorizationResolver.ts`
   * for the rules and their OCPP 1.6 §3.5 / 2.0.1 C12-C15 sources):
   * - offline, it decides alone, at once, without Authorize.req;
   * - online, a valid local-list or cache entry with `LocalPreAuthorize`
   *   resolves "Accepted" without Authorize.req (§9.1.13);
   * - otherwise Authorize.req goes out and the tag-matched
   *   `authorizeResult` event resolves it, so concurrent Authorize calls
   *   for different tags don't cross streams.
   *
   * While waiting, a disconnect hands the decision to the offline rules.
   * A timeout while still connected falls back to what the station knows:
   * a NOT-valid local-list or cache entry resolves its status (#452);
   * anything else warns and resolves "Accepted" (warn-and-proceed, #181).
   * A timeout once the socket is gone applies the offline rules.
   */
  authorizeAndWait(tagId: string, timeoutMs = 10000): Promise<string> {
    const decision = this._authorization.decide(tagId, this.isOnline());
    if (decision.kind !== "askCsms") {
      return Promise.resolve(this.localAuthorizationStatus(tagId, decision));
    }

    this.authorize(tagId);

    return new Promise<string>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        this._events.off("authorizeResult", handler);
        this._events.off("disconnected", disconnectHandler);
      };

      const handler = (data: { tagId: string; status: string }) => {
        if (data.tagId !== tagId) return;
        cleanup();
        resolve(data.status);
      };

      const decideOffline = (why: string) => {
        const status = this.localAuthorizationStatus(
          tagId,
          this._authorization.decideOffline(tagId),
        );
        this._logger.warn(
          `${why} while awaiting Authorize.conf for ${tagId}; offline authorization: ${status}`,
          LogType.TRANSACTION,
        );
        resolve(status);
      };

      const disconnectHandler = () => {
        cleanup();
        decideOffline("Disconnected");
      };

      this._events.on("authorizeResult", handler);
      this._events.on("disconnected", disconnectHandler);

      timeoutId = setTimeout(() => {
        cleanup();
        if (!this.isOnline()) {
          decideOffline(`Timeout (${timeoutMs}ms) and offline`);
          return;
        }
        const refusal = this._authorization.decideUnanswered(tagId);
        if (refusal) {
          this._logger.warn(
            `Timeout (${timeoutMs}ms) awaiting Authorize.conf for ${tagId}; falling back to the local decision`,
            LogType.TRANSACTION,
          );
          resolve(this.localAuthorizationStatus(tagId, refusal));
          return;
        }
        this._logger.warn(
          `Timeout (${timeoutMs}ms) awaiting Authorize.conf for ${tagId}; proceeding as Accepted`,
          LogType.TRANSACTION,
        );
        resolve("Accepted");
      }, timeoutMs);
    });
  }

  /** The status a local (no Authorize round trip) decision resolves to. */
  private localAuthorizationStatus(
    tagId: string,
    decision: LocalOnlyDecision,
  ): string {
    if (decision.kind === "accept") {
      this._logger.info(
        `${tagId} authorized locally (${decision.source}); no Authorize.req sent`,
        LogType.TRANSACTION,
      );
      return "Accepted";
    }
    this._logger.warn(
      `${tagId} refused locally (${decision.source}): ${decision.status}`,
      LogType.TRANSACTION,
    );
    return decision.status;
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

  /** Read-only probe: is an override armed for `action`? Test/diagnostic
   *  helper — does not consume. */
  hasResponseOverride(action: string): boolean {
    return this._responseOverrides.has(action);
  }

  /** Clear an armed response override. No-op if not armed. */
  clearResponseOverride(action: string): void {
    this._responseOverrides.delete(action);
  }

  /** Set an inbound call policy for `action`. Policies are sticky and survive
   *  reconnects; use clearInboundCallPolicy to remove. */
  setInboundCallPolicy(action: string, policy: InboundCallPolicy): void {
    this._inboundCallPolicies.set(action, policy);
  }

  /** Get the inbound call policy for `action`, or undefined if none is set. */
  getInboundCallPolicy(action: string): InboundCallPolicy | undefined {
    return this._inboundCallPolicies.get(action);
  }

  /** Clear the inbound call policy for `action`. If `action` is not provided,
   *  clear all policies. */
  clearInboundCallPolicy(action?: string): void {
    if (action === undefined) {
      this._inboundCallPolicies.clear();
    } else {
      this._inboundCallPolicies.delete(action);
    }
  }

  /** Set certificate quirks (CSR generation options, acceptance policies, etc.).
   *  Shallow-merges into current quirks; unset fields inherit prior values.
   *  Sticky until explicitly cleared. */
  setCertificateQuirks(quirks: Partial<CertificateQuirks>): void {
    this._certificateQuirks = { ...this._certificateQuirks, ...quirks };
  }

  /** Reset all certificate quirks to empty state. */
  clearCertificateQuirks(): void {
    this._certificateQuirks = {};
  }

  /** Read-only access to current certificate quirks. */
  get certificateQuirks(): CertificateQuirks {
    return this._certificateQuirks;
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
      (ev: SocketClose, cause: CloseCause) => {
        // Same teardown as an explicit disconnect() — heartbeat, scenario
        // state, connector listeners, etc. — so a CSMS-initiated close
        // doesn't leave background timers firing against a dead socket.
        this.teardownAfterClose();
        // #474: a close the charge point asked for (operator disconnect,
        // reset, network-sim cut, dispose) or a normal closure is not a
        // failure; the transport already logged it at INFO with its cause.
        const failure =
          cause === "network" && !NORMAL_CLOSE_CODES.has(ev.code)
            ? `WebSocket closed code: ${ev.code} reason: ${ev.reason}`
            : null;
        if (failure) this._logger.error(failure, LogType.WEBSOCKET);
        this._events.emit("disconnected", { code: ev.code, reason: ev.reason });
        if (failure) this.error = failure;
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
  /** Station-initiated DataTransfer.req; resolves with the CSMS's answer
   *  (#348). See {@link IChargePointMessageHandler.sendDataTransfer}. */
  sendDataTransfer(
    vendorId: string,
    messageId?: string,
    data?: DataTransferData,
  ): Promise<DataTransferResult> {
    return this._outbox.sendDataTransfer(vendorId, messageId, data);
  }

  /**
   * Expert OCPP call (#389): any station-initiated CALL of this station's
   * OCPP-J version, with the payload as given. See
   * {@link IChargePointMessageHandler.sendOcppCall}.
   */
  async sendOcppCall(request: OcppCallRequest): Promise<OcppCallOutcome> {
    const catalog = getOcppCallCatalog(this._ocppVersion);
    if (!catalog) {
      throw new OcppCallRejectedError(
        "unsupported_transport",
        `Expert OCPP calls need an OCPP-J station; ${this._ocppVersion} is SOAP`,
      );
    }
    // Checked here, not by the schema, so skipValidation cannot waive it:
    // the scenario editor can store unparsed JSON text as the payload.
    const { payload } = request;
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new OcppCallRejectedError(
        "invalid_payload",
        "The payload of an OCPP call must be a JSON object",
      );
    }
    if (!catalog.isSupported(request.action)) {
      throw new OcppCallRejectedError(
        "unsupported_action",
        `${request.action} is not a station-initiated call on ${this._ocppVersion}; expected one of ${catalog.actions.join(", ")}`,
      );
    }
    return this._outbox.sendOcppCall(request);
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
  sendDiagnosticsStatusNotification(status: DiagnosticsStatus): void {
    this._outbox.sendDiagnosticsStatusNotification(status);
  }

  /** Send FirmwareStatusNotification.req — see OCPPMessageHandler doc. */
  sendFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    this._outbox.sendFirmwareStatusNotification(status, requestId);
  }

  /** Send LogStatusNotification.req — see OCPPMessageHandler doc. */
  sendLogStatusNotification(status: UploadLogStatus, requestId?: number): void {
    this._outbox.sendLogStatusNotification(status, requestId);
  }

  /** `requestId` of the last UpdateFirmware.req this station accepted, so a
   *  2.0.1 FirmwareStatusNotification sent without one still names the
   *  lifecycle it belongs to (#345). Kept until the next accepted request —
   *  deliberately across reconnects and reboots, since a real update reports
   *  `Installed` only after the station has rebooted on the new firmware. */
  private _lastFirmwareRequestId: number | undefined;
  /** Same for GetLog.req → LogStatusNotification. */
  private _lastLogRequestId: number | undefined;

  noteFirmwareRequest(requestId: number): void {
    this._lastFirmwareRequestId = requestId;
  }
  get lastFirmwareRequestId(): number | undefined {
    return this._lastFirmwareRequestId;
  }
  noteLogRequest(requestId: number): void {
    this._lastLogRequestId = requestId;
  }
  get lastLogRequestId(): number | undefined {
    return this._lastLogRequestId;
  }

  /** Send SignedFirmwareStatusNotification.req — see OCPPMessageHandler doc. */
  sendSignedFirmwareStatusNotification(
    status: FirmwareStatus,
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
   * full happy-path by default. Failure paths are also reachable via
   * TriggerMessage(FirmwareStatusNotification) for tests that want to
   * drive them manually, or pre-armed for certification scenarios (cert
   * 1.6 Firmware TC_044_2 / TC_044_3) via the `SimulatedFirmwareUpdateFailure`
   * custom config key (set through a scenario `configSet` node before
   * UpdateFirmware fires): `"DownloadFailed"` diverts at the Downloaded
   * step, `"InstallationFailed"` diverts at the Installed step. The armed
   * value is one-shot: it is consumed and cleared on the next UpdateFirmware,
   * so a second UpdateFirmware without re-arming will run the happy path.
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
    const sequence: readonly FirmwareStatus[] = [
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ];
    const failureMode = this._configuration.getString(
      "SimulatedFirmwareUpdateFailure",
    );
    // One-shot: clear the armed failure immediately so the next UpdateFirmware
    // runs the happy path unless re-armed.
    if (failureMode) {
      this._configuration.applyChange("SimulatedFirmwareUpdateFailure", "");
    }

    const fireStep = (index: number) => {
      if (index >= sequence.length) {
        this._firmwareUpdateInFlight = false;
        this._firmwareUpdateTimers = [];
        return;
      }
      const step = sequence[index];
      if (step === "Downloaded" && failureMode === "DownloadFailed") {
        this.sendFirmwareStatusNotification("DownloadFailed");
        this._firmwareUpdateInFlight = false;
        this._firmwareUpdateTimers = [];
        return;
      }
      if (step === "Installed" && failureMode === "InstallationFailed") {
        this.sendFirmwareStatusNotification("InstallationFailed");
        this._firmwareUpdateInFlight = false;
        this._firmwareUpdateTimers = [];
        return;
      }
      this.sendFirmwareStatusNotification(step);
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
    const sequence: readonly FirmwareStatus[] = [
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

  /**
   * The single entry point for a processed BootNotification.conf, whatever
   * the OCPP version or transport. A status outside the three the spec
   * defines is treated as Rejected. The boot gate takes the new status first,
   * then `bootNotificationResult` is emitted, then the answer's own effects
   * run — so the event precedes every status change it causes (#395).
   */
  onBootNotificationResult(result: BootNotificationResult): void {
    const status: RegistrationStatus =
      result.status === "Accepted" || result.status === "Pending"
        ? result.status
        : "Rejected";
    const interval =
      typeof result.interval === "number" && result.interval > 0
        ? result.interval
        : 0;
    switch (status) {
      case "Accepted":
        this._logger.info("Boot notification accepted", LogType.OCPP);
        this.markBootAccepted();
        break;
      case "Pending":
        this._logger.warn(
          `BootNotification Pending — only CSMS-initiated traffic allowed${
            interval > 0 ? `, retry interval=${interval}s` : ""
          }`,
          LogType.OCPP,
        );
        // Spec: stay quiet but keep the WebSocket open. No retry timer here;
        // CSMS can move us to Accepted/Rejected via subsequent flow.
        this.markBootPending();
        break;
      case "Rejected": {
        const wait = interval > 0 ? interval : 60;
        this._logger.error(
          `BootNotification Rejected — silent for ${wait}s before retry`,
          LogType.OCPP,
        );
        this.markBootRejected(wait);
        break;
      }
    }
    // The CSMS's interval, not the 60s retry a Rejected with 0 falls back to.
    this._events.emit("bootNotificationResult", {
      status,
      interval,
      currentTime: result.currentTime,
    });
    if (status === "Accepted") {
      this.applyBootAccepted(interval);
    } else {
      this.stopHeartbeat();
      this._clockAligned.disable();
      // B02.FR.02: no NotifyEvent until the boot is Accepted.
      this._monitorEvaluation?.setReporting(false);
    }
  }

  private applyBootAccepted(interval: number): void {
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

    this._clockAligned.enable();
    // Re-checks the thresholds: what changed while Pending or offline, and
    // a restored trigger already back in range (N07.FR.14).
    this._monitorEvaluation?.setReporting(true);
  }

  /**
   * One clock-aligned sample per connector for `boundaryMs` (#454), carrying
   * `MeterValuesAlignedData` with `Sample.Clock` and the boundary instant.
   * OCPP 2.x puts a sample for an EVSE with a live transaction into
   * TransactionEvent(Updated, MeterValueClock) — never the MeterValuePeriodic
   * trigger of #347 — and every other sample into MeterValues. On 1.x a live
   * transaction's id rides along once the CSMS has assigned one.
   */
  private emitClockAlignedSamples(boundaryMs: number): void {
    // Empty by default; the interval change already logged that it is.
    const measurands = this._configuration.meterValuesAlignedData();
    if (measurands.length === 0) return;
    const timestamp = new Date(boundaryMs);
    const isV2 = isOcpp2Version(this._ocppVersion);
    this._connectors.forEach((connector) => {
      const live = connector.hasRunningTransaction;
      if (live && isV2) {
        this._outbox.sendTransactionUpdate(connector.id, {
          triggerReason: "MeterValueClock",
          meterValues: true,
          context: "Sample.Clock",
          measurands,
          timestamp,
        });
        return;
      }
      // `0` until StartTransaction.conf assigns the id.
      const id = connector.transaction?.id;
      const transactionId = live && id ? id : undefined;
      this._outbox.sendMeterValue(transactionId, connector.id, "Sample.Clock", {
        measurands,
        timestamp,
      });
    });
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
    this._webSocket?.disconnect(); // drains network-sim pipelines synchronously (spec 2.6 step 1)
    this.teardownAfterClose(); // handler teardown incl. serializer _serialQueue salvage (step 2)
  }

  /**
   * Common teardown for both user-initiated disconnect() and the
   * WebSocket's onclose path. Sets the CP+connector status to Unavailable,
   * stops the heartbeat, cleans up connector listeners, and releases the
   * reservation manager so no timers / event handlers keep running against
   * a dead socket.
   */
  private teardownAfterClose(): void {
    // A `triggerOn: "connect"` scenario is armed once per connect, recorded on
    // `Connector.lastAutoStartedScenarioKey` so re-emitting Available doesn't
    // restart something already running. That arm must not survive the socket
    // dying: both auto-start engines (CLIChargePointService.
    // tryAutoStartForConnector for the daemon, LocalScenarioRuntime for
    // browser local mode) gate on the key, so
    // a stale arm means the scenario never re-fires after a reconnect. In the
    // daemon that silently kills a CLI-bootstrapped RemoteStart responder --
    // the CP reconnects and boots, but nothing answers RemoteStartTransaction
    // until an operator re-fires the template by hand.
    //
    // Cleared BEFORE the `status` assignment below: that setter cascades
    // Unavailable onto every connector, whose statusChange event is what
    // drives persistConnectorRuntime. Clearing afterwards would persist the
    // stale key into `connector_runtime.last_auto_started_scenario_key` and
    // outlive a process restart too.
    this._connectors.forEach((connector) => {
      connector.lastAutoStartedScenarioKey = null;
    });
    this.status = OCPPStatus.Unavailable;
    this._heartbeat.cleanup();
    this._clockAligned.disable();
    // Offline: events at or below OfflineQueuingSeverity are queued
    // (N07.FR.04, N08.FR.03) until the next boot is Accepted (#538).
    this._monitorEvaluation?.setOffline();
    this._connectors.forEach((connector) => connector.cleanup());
    this._reservationManager.dispose();
    // The Local Authorization List is kept: it is what authorizes while the
    // connection is down (§3.5.3, LocalAuthorizeOffline), so a connection
    // loss must not empty it (#534). Only dispose() drops it.
    this.clearChargingProfiles(0, {}, "ConnectionClosed");
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
    this._lastDefaultHandledRemoteStart.clear();
    this._lastDefaultHandledRemoteStop.clear();
    // Issue #110: stale response overrides must not survive a
    // disconnect — they would silently answer the next real CSMS call.
    this._responseOverrides.clear();
    // Cancel all ConnectionTimeOut watchdogs so the timer doesn't fire
    // against a disconnected CP.
    this._connectionTimeoutTimers.forEach((t) => clearTimeout(t));
    this._connectionTimeoutTimers.clear();
    // §4.1.1 serializer: drop the in-flight CALL + queued CALLs since the
    // WebSocket they target is gone. Transaction-related ones go to the
    // PendingMessageQueue (1.6 §3.7; 2.x E11 TransactionEvents, #528).
    this._outbox.onWebSocketClosed();
    // Flush any buffered log lines so the operator can still see the
    // last seconds of activity after the CP went down.
    this._logRepository.flush();
  }

  reset(): void {
    if (this._webSocket) {
      // WebSocket CP: use cause-aware internal reset (preserves reconnect reservation)
      this._webSocket.disconnectInternal(); // drains, does NOT set manual, does NOT clear reservation
      this.teardownAfterClose(); // drain-before-teardown order preserved
    } else {
      // SOAP CP: fallback to the old disconnect+connect semantics
      this.disconnect();
    }
    this.connect();
  }

  /**
   * Terminal teardown: permanently releases the charge point.
   * Shuts down the network-sim controller and closes the socket,
   * then runs final CP-side teardown.
   */
  dispose(): void {
    this._webSocket?.dispose(); // terminal: shuts controller down, clears reservation, closes socket
    this.teardownAfterClose(); // final CP-side teardown
    // Offline monitoring keeps the periodic timers running: stop them.
    this._monitorEvaluation?.dispose();
    this._localAuthListManager.dispose();
    this._timelineProjector.dispose();
    // The socket's real close event still arrives asynchronously and its
    // handler logs "WebSocket closed" through this repository. Closing it
    // here (not in teardownAfterClose, which a plain disconnect shares)
    // drops that late line instead of buffering it — otherwise a `cp.delete`
    // that just cascaded to `logs` gets one row back for the deleted id
    // (#326).
    this._logRepository.close();
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
    const previousStatus = this._status;
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
    // #538: ChargingStation.AvailabilityState on a 2.x station.
    if (this._monitorEvaluation) this.publishStationAvailability();
    this._events.emit("statusChange", { status: newStatus, previousStatus });
    this._stateManager.transitionChargePointStatus(newStatus, {
      source: "boundary-setter",
      timestamp: new Date(),
    });
  }

  async startTransaction(
    tagId: string,
    connectorId: number,
    batteryCapacityKwh?: number,
    initialSoc?: number,
    options: StartTransactionOptions = {},
  ): Promise<StartTransactionOutcome> {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(
        `Connector ${connectorId} not found`,
        LogType.TRANSACTION,
      );
      return { started: false };
    }

    if (connector.transaction && connector.transaction.stopTime === null) {
      // Only a NOT-yet-stopped transaction blocks a new start. A closed one
      // still attached (cleanTransaction sets stopTime without detaching; a
      // snapshot persisted before #491 restores one) must NOT block a retry.
      this._logger.warn(
        `Connector ${connectorId} already has an active transaction; ignoring duplicate start`,
        LogType.TRANSACTION,
      );
      return { started: false };
    }

    if (connector.availability !== "Operative") {
      this._logger.warn(
        `Connector ${connectorId} is ${connector.availability}; refusing to start transaction`,
        LogType.TRANSACTION,
      );
      return { started: false };
    }

    // Issue #181: gate LOCAL (non-remote-start) starts on Authorize.conf.
    // "RemoteStart" means either RemoteStartTransactionHandler's direct
    // path (which already applies AuthorizeRemoteTxRequests semantics) or
    // a scenario that captured a RemoteStartTrigger node — both already
    // went through CSMS-driven authorization, so they're excluded here.
    const isLocalStart = options.triggerReason !== "RemoteStart";
    if (isLocalStart && this._configuration.authorizeBeforeLocalStart()) {
      const status = await this.authorizeAndWait(tagId);
      // Any non-"Accepted" idTagInfo/idTokenInfo status denies the local
      // start. Deliberately NOT an allowlist of specific denial strings —
      // OCPP 2.0.1/2.1's AuthorizationStatusEnumType has more denial values
      // than 1.6's AuthorizationStatus (ConcurrentTx, NoCredit,
      // NotAllowedTypeEVSE, NotAtThisLocation, NotAtThisTime, Unknown), and
      // a hardcoded 1.6-shaped list would silently let those through.
      if (status !== "Accepted") {
        this._logger.warn(
          `Authorize.conf ${status} for ${tagId}; refusing local transaction start on connector ${connectorId}`,
          LogType.TRANSACTION,
        );
        this._events.emit("authorizeDenied", {
          connectorId,
          tagId,
          status,
        });
        return { started: false, denialStatus: status };
      }
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
      startChargingState: options.chargingState,
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
    // Drive Preparing before enqueueing StartTransaction.req: the outbound
    // CALL queue is strictly serial/FIFO, so whichever we queue first is
    // what the wire sees first. Sending Preparing's StatusNotification.req
    // ahead of StartTransaction.req makes the OCPP-conformant wire order
    // (Preparing precedes StartTransaction) intrinsic to the domain rather
    // than an accident of scenario node ordering (#176). A connector already
    // in Preparing (plugged in first) has sent it: a second
    // StatusNotification(Preparing) is a Preparing → Preparing transition
    // OCPP 1.6 does not have (#496). Its ConnectionTimeOut restarts as before.
    if (connector.status === OCPPStatus.Preparing) {
      this.startConnectionTimeout(connectorId);
    } else {
      this.updateConnectorStatus(connectorId, OCPPStatus.Preparing);
    }
    this._outbox.sendTransactionEvent({
      phase: "started",
      transaction,
      connectorId,
    });

    this._events.emit("transactionStarted", {
      connectorId,
      transactionId: 0,
      tagId,
    });

    return { started: true };
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
    // A closed transaction (`stopTime` set) is no transaction: stopping it
    // again would send a second StopTransaction.req for it (#491).
    if (!transaction || !connector.hasRunningTransaction) {
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
    if (options.stoppedReason) {
      transaction.stoppedReason = options.stoppedReason;
    }

    this._outbox.sendTransactionEvent({
      phase: "ended",
      transaction,
      connectorId: connector.id,
    });

    this._events.emit("transactionStopped", {
      connectorId: connector.id,
      transactionId: transaction.id,
      reason: transaction.stoppedReason ?? transaction.stopReason,
    });

    // Clear TxProfile charging profiles when transaction ends (OCPP 1.6 spec compliant)
    // NOTE: Only TxProfile is cleared. TxDefaultProfile persists for future transactions.
    // ChargePointMaxProfile also persists as it applies to the entire station.
    const [cleared] = this.clearChargingProfiles(
      connector.id,
      { purpose: ChargingProfilePurposeType.TxProfile },
      "TransactionEnded",
    );
    if (cleared) {
      this._logger.info(
        `Cleared ${cleared.profiles.length} TxProfile(s) after transaction end on connector ${connector.id}`,
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

  /**
   * The EV side of the cable was unplugged (#488). With a running
   * transaction, `StopTransactionOnEVSideDisconnect` (2.x
   * `TxCtrlr.StopTxOnEVSideDisconnect`) decides:
   * - true: the transaction stops with `EVDisconnected` (1.6 §4.9 / §4.10;
   *   2.0.1 E09: Ended, triggerReason `EVCommunicationLost`);
   * - false: the transaction is kept and the connector goes SuspendedEV
   *   (1.6 §4.9 / §4.10) with its energy offer stopped: the register no
   *   longer rises while periodic MeterValues keep going out, and the
   *   derived power is zero outside Charging. On 2.x a
   *   TransactionEvent(Updated) carries chargingState `SuspendedEV` and
   *   triggerReason `EVCommunicationLost` (E10); the StatusNotification
   *   that follows is de-duplicated against it. A second unplug while so
   *   suspended sends nothing.
   * Without a transaction the connector goes Available, as an unplug did
   * before.
   */
  evDisconnected(connectorId: number): void {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(
        `Connector ${connectorId} not found`,
        LogType.TRANSACTION,
      );
      return;
    }

    if (!connector.hasRunningTransaction) {
      this.updateConnectorStatus(connectorId, OCPPStatus.Available);
      return;
    }

    if (
      connector.energyOfferSuspended &&
      connector.status === OCPPStatus.SuspendedEV
    ) {
      this._logger.debug(
        `Connector ${connectorId} EV side already disconnected, ignoring`,
        LogType.TRANSACTION,
      );
      return;
    }

    if (this._configuration.stopTransactionOnEVSideDisconnect()) {
      this._logger.info(
        `Connector ${connectorId} EV side disconnected, stopping the transaction (StopTransactionOnEVSideDisconnect=true)`,
        LogType.TRANSACTION,
      );
      this.stopTransaction(connector, "EVDisconnected", {
        triggerReason: "EVCommunicationLost",
        stoppedReason: "EVDisconnected",
      });
      return;
    }

    this._logger.info(
      `Connector ${connectorId} EV side disconnected, suspending the transaction (StopTransactionOnEVSideDisconnect=false)`,
      LogType.TRANSACTION,
    );
    connector.suspendEnergyOffer();
    if (isOcpp2Version(this._ocppVersion)) {
      this._outbox.sendTransactionUpdate(connectorId, {
        triggerReason: "EVCommunicationLost",
        chargingState: "SuspendedEV",
      });
    }
    this.updateConnectorStatus(connectorId, OCPPStatus.SuspendedEV);
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

  sendMeterValue(connectorId: number, context?: ReadingContext): void {
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
      context,
    );
  }

  /**
   * Drive an OCPP 2.x TransactionEvent(Updated) on a running transaction
   * (#335). On OCPP 1.6 the handler logs a warning and sends nothing.
   */
  sendTransactionUpdate(
    connectorId: number,
    options: TransactionUpdateOptions,
  ): void {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(
        `Connector ${connectorId} not found`,
        LogType.TRANSACTION,
      );
      return;
    }
    this._outbox.sendTransactionUpdate(connectorId, options);
  }

  getConnector(connectorId: number): Connector | undefined {
    return this._connectors.get(connectorId);
  }

  removeConnector(connectorId: number): boolean {
    const connector = this._connectors.get(connectorId);
    if (!connector) return false;

    this.clearChargingProfiles(connectorId, {}, "ConnectorRemoved");
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
      // #538: ChargingStation.AvailabilityState on a 2.x station.
      if (this._monitorEvaluation) this.publishStationAvailability();
      this._events.emit("statusChange", { status, previousStatus });
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

  /**
   * Public network-sim forwarding: apply network simulation config at runtime.
   * No-op for SOAP charge points (this._webSocket is null).
   * Stores a summary { enabled, manualRuleIds } for dashboard UI.
   */
  setNetworkSimConfig(resolved: ResolvedNetworkSimConfig): void {
    // Store summary for UI (null for SOAP CPs)
    if (!this.isSoapChargePoint()) {
      const manualRuleIds = Object.entries(resolved.rules)
        .filter(([, rule]) => rule.type === "manual-disconnect")
        .map(([id]) => id);
      this._networkSimSummary = {
        enabled: resolved.enabled,
        manualRuleIds,
      };
    }
    this._webSocket?.setNetworkSimConfig(resolved);
  }

  /**
   * Network simulation summary: { enabled, manualRuleIds } if a config has been
   * applied, or null for SOAP CPs / when no config has been applied yet.
   */
  networkSimSummary(): { enabled: boolean; manualRuleIds: string[] } | null {
    return this.isSoapChargePoint() ? null : this._networkSimSummary;
  }

  /**
   * Public network-sim forwarding: trigger a manual-disconnect rule.
   * Returns { ok: false; error: "not_connected" } for SOAP or null-socket charge points.
   */
  triggerNetworkSimDisconnect(ruleId: string):
    | { ok: true }
    | {
        ok: false;
        error: "sim_disabled" | "rule_not_manual" | "not_connected";
      } {
    if (!this._webSocket) {
      return { ok: false, error: "not_connected" }; // SOAP or no socket
    }
    return this._webSocket.triggerNetworkSimDisconnect(ruleId);
  }
}
