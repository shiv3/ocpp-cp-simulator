import type { VehicleBehaviorDriver } from "./VehicleBehaviorDriver";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "../types/FirmwareLogStatus";
import type {
  ChargePointCapabilityProfile,
  DisabledActionErrorCode,
} from "./CapabilityProfile";
import {
  createCollaborators,
  type ChargePointCollaborators,
  type StationContext,
} from "./ChargePointCollaborators";
import {
  completeConstruction,
  createStationAuthorization,
  routeLogEntries,
  wireSocket,
} from "./ChargePointSetup";
import { CapabilityGate } from "./CapabilityGate";
import { IdTagSource } from "./IdTagSource";
import { EventEmitter } from "../../shared/EventEmitter";
import { realClock } from "../../shared/clock";
import type { SimClock, TimerHandle } from "../../shared/clock";
import { RngStreams, systemRngStreams } from "../../shared/rng";
import type { Rng, RngSource } from "../../shared/rng";
import type {
  DataTransferData,
  DataTransferResult,
} from "../types/DataTransfer";
import type { LogEntry } from "../../shared/Logger";
import { Logger, LogType } from "../../shared/Logger";
import { MainMeter } from "./MainMeter";
import { ClockAlignedMeterScheduler } from "./ClockAlignedMeterScheduler";
import type { Connector } from "../connector/Connector";
import type { ConnectorWrite } from "../connector/ConnectorRecord";
import type {
  BootNotificationResult,
  ChargePointEvents,
  ChargingProfileClearReason,
  ChargingProfileSource,
  ClearedChargingProfiles,
  IncomingCallCompletion,
} from "./ChargePointEvents";
import { ConfigurationStore } from "./ConfigurationStore";
import type {
  AuthorizeSendHooks,
  IChargePointMessageHandler,
} from "../transport/IChargePointMessageHandler";
import type { ChargePointSocket } from "../transport/ChargePointSocket";
import type { RawFrameSink } from "../transport/RawFrameSink";
import { CellularModem, type RedactedModemState } from "../modem/CellularModem";
import { CellularLinkController } from "./CellularLinkController";
import {
  type CellularLinkState,
  type CellularLinkWire,
  type CellularPolicySet,
} from "../modem/cellularLink";
import type { OcppCallActions } from "../transport/OcppCallActions";
import type {
  ChargePointDeps,
  ChargePointTransactions,
} from "./ChargePointDeps";
import type { FileUploader } from "./FileUploader";
import type { ResolvedNetworkSimConfig } from "../transport/networkSim";
import type { OcppSecurityProfile } from "@ocpp-cp-simulator/contracts/securityProfile";
import type { OcppTlsOptions } from "../transport/ConnectionSecurity";
import { Outbox } from "../transport/Outbox";
import {
  type OcppCallOutcome,
  type OcppCallRequest,
  type RawFrameOutcome,
  type RawFrameRequest,
} from "../types/OcppCall";
import {
  type Get15118EVCertificateRequest,
  type Get15118EVCertificateResult,
} from "../security/get15118EVCertificate";
import type { ChargePointRepositories } from "../persistence/ChargePointRepositories";
import type { LogSink } from "../persistence/LogSink";
import type { PendingMessageRepository } from "../persistence/PendingMessageRepository";
import type {
  OCPPAvailability,
  StatusNotificationOptions,
  BootNotification,
  BootReason,
  ChargePointStatus,
} from "../types/OcppTypes";
import { isSoapVersion } from "../types/OcppVersion";
import { DeviceModelTargets } from "./DeviceModelTargets";
import { OCPPStatus } from "../types/OcppTypes";
import type {
  IdTokenTypeName,
  StopTransactionReason,
  TransactionUpdateOptions,
} from "../connector/Transaction";
import {
  type MeterSampleOverrides,
  type ReadingContext,
} from "../connector/MeterValueBuilder";
import { ReservationManager } from "../reservation/Reservation";
import { LocalAuthListManager } from "../auth/LocalAuthList";
import type { StationAuthorization } from "../auth/StationAuthorization";
import { type CsmsAuthorizationResult } from "../auth/StationAuthorization";
import {
  ChargingProfileStore,
  type ApplyChargingProfileOptions,
  type ProfileRemoveCriteria,
} from "./ChargingProfileStore";
import type { ActiveChargingProfile } from "../connector/Connector";
import { CertificateStore } from "../security/CertificateStore";
import {
  NetworkProfileStore,
  type NetworkConnectionProfile,
  type NetworkProfileVerdict,
} from "../security/networkProfiles";
import { MonitoringStore } from "../monitoring/MonitoringStore";
import { DEFAULT_MONITOR_CATALOG } from "../monitoring/monitorCatalog";
import type { MonitorEvaluation } from "../monitoring/MonitorEvaluation";
import type { OcmfMeter } from "../connector/SignedMeterData";
import {
  DEFAULT_ID_TAG,
  IdTagPool,
  type IdTagDistribution,
} from "../auth/IdTagPool";
import { assertWsClientOptions } from "../../shared/WsClientOptions";
import {
  resolveReconnectPolicy,
  type ReconnectPolicy,
} from "../../shared/ReconnectPolicy";
import type { ChargePointBehaviorRegistry } from "../engine/behaviorRules";
import type {
  ChargePointEngine,
  LoadBehaviorOptions,
  TransactionPorts,
} from "../engine/ChargePointEngine";
import type { ChargePointHeartbeat } from "../services/ChargePointHeartbeat";
import type { ChargePointStateManager } from "../services/ChargePointStateManager";
import type {
  ChargePointTimeline,
  ChargePointTimelineProjector,
} from "../services/ChargePointTimeline";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { StationTopology } from "../topology/StationTopology";
import {
  DEFAULT_INBOUND_VALIDATION,
  PowerStateError,
  type BasicAuthSettings,
  type AutoMeterValueSetting,
  type StartTransactionOptions,
  type StartTransactionOutcome,
  type StopTransactionOptions,
  type PowerLossRecord,
  type PowerRestoreOptions,
  type PowerLossOptions,
  type PowerRestoreResult,
  type InboundCallPolicy,
  type CertificateQuirks,
  type ChargePointSimulationOptions,
  type ChargePointResetType,
  type InboundValidationMode,
  type ChargePointTransportOptions,
} from "./ChargePointTypes";
export {
  DEFAULT_INBOUND_VALIDATION,
  PowerStateError,
  RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS,
} from "./ChargePointTypes";
export type {
  BasicAuthSettings,
  AutoMeterValueSetting,
  StartTransactionOptions,
  StartTransactionOutcome,
  StopTransactionOptions,
  PowerLossRecord,
  PowerRecovery,
  PowerRestoreOptions,
  PowerLossOptions,
  PowerRestoreResult,
  InboundCallPolicy,
  CertificateQuirks,
  ChargePointSimulationOptions,
  ChargePointResetType,
  InboundValidationMode,
  ChargePointTransportOptions,
} from "./ChargePointTypes";

type ChargePointResetSource = "ocpp-call" | "ocpp15-soap";

export class ChargePoint {
  private readonly _connectors: Map<number, Connector> = new Map();
  /** The station main meter on connector 0 / EVSE 0 (#617); opt-in. */
  private _mainMeter: MainMeter | undefined;
  // cpId is injected later in the constructor body so the Logger can
  // stamp every JSON line with the CP it belongs to (multi-CP daemons).
  private readonly _logger = new Logger();
  private readonly _events = new EventEmitter<ChargePointEvents>();
  private readonly _webSocket: ChargePointSocket | null;
  private readonly _clock: SimClock;
  /** #609 */
  private readonly _reconnectPolicy: ReconnectPolicy;

  /** The resolved reconnect policy (#609); also read by the default 2.x
   *  `RetryBackOff*` variables. */
  get reconnectPolicy(): ReconnectPolicy {
    return this._reconnectPolicy;
  }

  /** The station's current time, from its clock (virtual under a VirtualClock). */
  nowDate(): Date {
    return new Date(this._clock.now());
  }
  private readonly _rngSource: RngSource;
  private readonly _behaviors: ChargePointBehaviorRegistry;
  /** Owner of the engine-held state and the behaviors (stage B). */
  private readonly _engine: ChargePointEngine;
  /** #575: the default transaction behavior, see `deps.transactions`. */
  private readonly _transactions: ChargePointTransactions;
  /** #628: how the connectors group into EVSEs; every 2.x EVSE reference
   *  is mapped through it. Fixed at construction. */
  private readonly _topology: StationTopology;
  /** #393: level C expert sends; null on SOAP. */
  private readonly _rawFrames: RawFrameSink | null;
  /** #389: null on SOAP. */
  private readonly _callCatalog: OcppCallActions | null;
  private readonly _messageHandler: IChargePointMessageHandler;
  private readonly _transportUrl: string;
  /** The collaborators; their hosts read this charge point through `ctx`. */
  private readonly _ctx: StationContext = {
    authorization: () => this._authorization,
    callCatalog: () => this._callCatalog,
    cellular: () => this._cellular,
    certificateStore: () => this._certificateStore,
    clock: () => this._clock,
    clockAligned: () => this._clockAligned,
    configuration: () => this._configuration,
    connectors: () => this._connectors,
    deviceModelTargets: () => this._deviceModelTargets,
    engine: () => this._engine,
    events: () => this._events,
    heartbeat: () => this._heartbeat,
    localAuthListManager: () => this._localAuthListManager,
    logSink: () => this._logSink,
    logger: () => this._logger,
    mainMeter: () => this._mainMeter,
    monitoring: () => this._monitoring,
    monitorEvaluation: () => this._monitorEvaluation,
    networkProfiles: () => this._networkProfiles,
    nowDate: () => this._nowDate(),
    ocppVersion: () => this._ocppVersion,
    outbox: () => this._outbox,
    rawFrames: () => this._rawFrames,
    reconnectPolicy: () => this._reconnectPolicy,
    repositories: () => this._repositories,
    reservationManager: () => this._reservationManager,
    stateManager: () => this._stateManager,
    stationProfiles: () => this._stationProfiles,
    status: () => this._status,
    setStatus: (status) => {
      this._status = status;
    },
    timelineProjector: () => this._timelineProjector,
    topology: () => this._topology,
    txEndedAligned: () => this._txEndedAligned,
    vehicleDrivers: () => this._vehicleDrivers,
    webSocket: () => this._webSocket,
    assertPowered: () => this.assertPowered(),
    evseIdOf: (connectorId) => this.evseIdOf(connectorId),
    loadAvailability: (connectorId) => this.loadAvailability(connectorId),
    warnCapabilityProfileConflicts: () => this._capabilityGate.warnConflicts(),
    writeConnector: (connectorId, write) =>
      this.writeConnector(connectorId, write),
  };
  private readonly _parts: ChargePointCollaborators = createCollaborators(
    this,
    this._ctx,
  );
  private readonly _certSwitch = this._parts.certSwitch;
  /** Tests read the pending wait's canceller through this name. */
  // @ts-expect-error TS6133: read by tests through a cast, not by this class
  private get _cancelClientCertificateSwitchTimer(): (() => void) | null {
    return this._certSwitch.pendingCancel;
  }
  private readonly _idTags: IdTagSource;
  private readonly _outbox: Outbox;
  private readonly _heartbeat: ChargePointHeartbeat;
  private readonly _clockAligned: ClockAlignedMeterScheduler;
  /** #607: the 2.x `AlignedDataCtrlr.TxEndedInterval` grid, apart from the
   *  `Interval` one: it samples the transaction-end history, sends nothing. */
  private readonly _txEndedAligned: ClockAlignedMeterScheduler;
  /** #722: the per-connector `MeterValueSampleInterval` timers of running 1.x
   *  transactions. */
  /** Applies each connector's vehicle behavior to the station (#835). */
  private readonly _vehicleDrivers: Map<number, VehicleBehaviorDriver> =
    new Map();
  private readonly _stateManager: ChargePointStateManager;
  private readonly _timeline: ChargePointTimeline;
  private readonly _timelineProjector: ChargePointTimelineProjector;
  private readonly _logSink: LogSink;
  /** #878: the stores this charge point persists its own state through. */
  private readonly _repositories: ChargePointRepositories;
  private readonly _fileUploader: FileUploader;
  private readonly _reservationManager: ReservationManager;
  /** #597: Reset OnIdle requests answered `Scheduled`, each run once its transactions end. */
  /** #455: set while the station is without power. */
  private readonly _localAuthListManager: LocalAuthListManager;
  private readonly _authorization: StationAuthorization;
  // §3.13.3: profiles installed with connectorId=0 (ChargePointMaxProfile,
  // station-wide TxDefaultProfile) belong at the CP level, not duplicated
  // onto every connector. Connectors consult this store at composite time.
  private readonly _stationProfiles: ChargingProfileStore =
    new ChargingProfileStore();
  private readonly _certificateStore: CertificateStore;
  private readonly _messaging = this._parts.messaging;
  private readonly _statusControl = this._parts.statusControl;
  private readonly _profileControl = this._parts.profileControl;
  // OCPP 2.x variable monitors and monitoring level (N04-N06, #457).
  private readonly _monitoring = new MonitoringStore(DEFAULT_MONITOR_CATALOG);
  // #538: Target attributes of the 2.1 device model (EVSE.Power).
  private readonly _deviceModelTargets = new DeviceModelTargets();
  private readonly _authorizationFlow = this._parts.authorizationFlow;
  private readonly _sampling = this._parts.sampling;
  private readonly _power = this._parts.power;
  private readonly _resetOnIdle = this._parts.resetOnIdle;
  private readonly _connectionTimeouts = this._parts.connectionTimeouts;
  private readonly _plugIn = this._parts.plugIn;
  private readonly _connectorWiring = this._parts.connectorWiring;
  private readonly _bootState = this._parts.bootState;
  private readonly _boot = this._parts.boot;
  private readonly _outage = this._parts.outage;
  private readonly _configWiring = this._parts.configWiring;
  private readonly _deviceModel = this._parts.deviceModel;
  // OCPP 2.x NetworkConnectionProfiles stored by SetNetworkProfile (B09).
  private readonly _networkProfiles = new NetworkProfileStore();
  // Their evaluation into NotifyEvent (kept by the device model publisher).
  private get _monitorEvaluation(): MonitorEvaluation | undefined {
    return this._deviceModel.evaluation;
  }
  private readonly _configuration: ConfigurationStore;

  // §7.7: connectorId=0 status MUST be Available / Unavailable / Faulted.
  // The narrower type stops the rest of the code from accidentally setting
  // Charging / Preparing / Reserved etc. on the CP main controller.
  private _status: ChargePointStatus = OCPPStatus.Unavailable;
  private _error = "";
  private _autoMeterValueSetting: AutoMeterValueSetting | null;
  /** #347: see {@link sendScheduledMeterValue}. On by default (#551). */
  private _txUpdatedMeterValues = true;
  private readonly _scenarioCalls = this._parts.scenarioCalls;
  private readonly _callOverrides = this._parts.callOverrides;
  // Network simulation summary: { enabled, manualRuleIds } when a config has
  // been applied via setNetworkSimConfig, null for SOAP CPs or when no config
  // has been applied yet.
  private readonly _cellular = new CellularLinkController({
    logger: this._logger,
    events: this._events,
    webSocket: () => this._webSocket,
    isSoapChargePoint: () => this.isSoapChargePoint(),
    connect: () => this.connect(),
  });

  private _inboundValidation: InboundValidationMode;
  private readonly _capabilityGate: CapabilityGate;

  /** See {@link ChargePointCapabilityProfile}. */
  get capabilityProfile(): ChargePointCapabilityProfile | undefined {
    return this._capabilityGate.profile;
  }

  /** Is the inbound `action` disabled by the capability profile (#618)?
   *  @see CapabilityGate.isActionDisabled */
  isActionDisabled(action: string): boolean {
    return this._capabilityGate.isActionDisabled(action);
  }

  /** The CALLERROR code a disabled action is answered with (#618). */
  disabledActionErrorCode(): DisabledActionErrorCode {
    return this._capabilityGate.disabledActionErrorCode();
  }

  /** Whether the station keeps an out-of-table 1.6 status change off the wire
   *  (`statusTransitions: "enforce"`, #618).
   *  @see CapabilityGate.enforcesStatusTransitions */
  get enforcesStatusTransitions(): boolean {
    return this._capabilityGate.enforcesStatusTransitions;
  }

  /** May TriggerMessage request `target` under the capability profile (#618)? */
  isTriggerTargetSupported(target: string): boolean {
    return this._capabilityGate.isTriggerTargetSupported(target);
  }

  /** See {@link InboundValidationMode}. Read on every inbound CALL. */
  get inboundValidation(): InboundValidationMode {
    return this._inboundValidation;
  }

  setInboundValidation(mode: InboundValidationMode): void {
    this._inboundValidation = mode;
  }

  private _reservationAuthorizeIdTag: boolean;

  /** See {@link ChargePointTransportOptions.reservationAuthorizeIdTag}. */
  get reservationAuthorizeIdTag(): boolean {
    return this._reservationAuthorizeIdTag;
  }

  setReservationAuthorizeIdTag(enabled: boolean): void {
    this._reservationAuthorizeIdTag = enabled;
  }

  constructor(
    private readonly _id: string,
    _bootNotification: BootNotification,
    connectorCount: number,
    wsUrl: string,
    basicAuthSettings: BasicAuthSettings | null,
    autoMeterValueSetting: AutoMeterValueSetting | null,
    /** Extra HTTP headers and Sec-WebSocket-Protocol tokens emitted on
     *  every WS upgrade. Wired through to OCPPWebSocket so reconnects
     *  pick the same values up. CLI-only (DOM WebSocket ignores headers). */
    extraWsHeaders: Record<string, string> = {},
    extraWsSubprotocols: ReadonlyArray<string> = [],
    private readonly _ocppVersion: string = "OCPP-1.6J",
    transportOptions: ChargePointTransportOptions = {},
    securityProfile: OcppSecurityProfile | undefined,
    authorizationKey: string | undefined,
    cpoName: string | undefined,
    tls: OcppTlsOptions | undefined,
    simulation: ChargePointSimulationOptions = {},
    /** #575: what is built outside the domain; see `createChargePoint`. */
    deps: ChargePointDeps,
  ) {
    this._boot.bootNotification = _bootNotification;
    this._clock = simulation.clock ?? realClock;
    // #628: the 1:1 station until the topology is configurable. Before the
    // engine and the transport, which read it.
    this._topology = StationTopology.identity(connectorCount);
    // #575: before the connectors are attached and before the transport is
    // built (the message handlers read `behaviors` when they are built).
    this._behaviors = deps.createBehaviorRegistry({
      ocppVersion: () => this._ocppVersion,
      warn: (message) => this._logger.warn(message, LogType.OCPP),
    });
    this._engine = deps.createEngine(this);
    this._transactions = deps.transactions;
    this._reconnectPolicy = resolveReconnectPolicy(transportOptions.reconnect);
    // Before any state is built: a refused option must not leave a half-made
    // charge point behind.
    const wsClientOptions = assertWsClientOptions(transportOptions.ws);
    this._rngSource =
      simulation.seed === undefined
        ? systemRngStreams
        : typeof simulation.seed === "object"
          ? simulation.seed
          : new RngStreams(simulation.seed);
    this._autoMeterValueSetting = autoMeterValueSetting;
    this._transportUrl = transportOptions.centralSystemUrl ?? wsUrl;
    this._inboundValidation =
      transportOptions.inboundValidation ?? DEFAULT_INBOUND_VALIDATION;
    this._reservationAuthorizeIdTag =
      transportOptions.reservationAuthorizeIdTag ?? false;
    this._capabilityGate = new CapabilityGate(
      transportOptions.capabilityProfile,
      {
        configuration: () => this._configuration,
        logger: () => this._logger,
        ocppVersion: () => this._ocppVersion,
      },
    );
    this._logger.setCpId(this._id);
    this._logSink = deps.logSink;
    this._repositories = deps.repositories;
    this._fileUploader = deps.fileUploader;
    // #456: installed certificates survive a restart when state persists.
    // #928: the initial config, or (without one) the state a restart finds.
    this._cellular.attachModem(
      transportOptions.modem
        ? new CellularModem(
            this._id,
            transportOptions.modem,
            deps.repositories.modem,
          )
        : CellularModem.restore(this._id, deps.repositories.modem),
    );
    this._certificateStore = new CertificateStore(
      this._repositories.certificates,
      this._clock,
    );
    // §4.9 S3: track whether this SOAP CP can receive CSMS-initiated calls
    // (server-hosted with callback) vs send-only (no callback URL).
    this._messaging.hasSoapCallbackUrl = !!transportOptions.soapCallbackUrl;

    routeLogEntries(this._logger, this._events, () => this._logSink, this._id);

    this._connectorWiring.createConnectors(
      connectorCount,
      transportOptions.chargerCapabilities,
      autoMeterValueSetting,
    );

    const mainMeterConfig = transportOptions.chargerCapabilities?.mainMeter;
    if (mainMeterConfig) {
      this._mainMeter = new MainMeter(
        mainMeterConfig,
        () => this._connectors,
        this._clock,
      );
    }

    // #575: the factory builds the socket, the raw-frame sender, the
    // supervision URL pool and the message handler (which reads `this`).
    const transport = deps.createTransport(this, {
      logger: this._logger,
      wsUrl,
      transportUrl: this._transportUrl,
      basicAuth: basicAuthSettings,
      extraWsHeaders,
      extraWsSubprotocols,
      ocppVersion: this._ocppVersion,
      securityProfile,
      authorizationKey,
      cpoName,
      tls,
      transportOptions,
    });
    this._webSocket = transport.socket;
    this._rawFrames = transport.rawFrames;
    this._messageHandler = transport.handler;
    this._callCatalog = transport.callCatalog;
    this._messaging.receivesCsmsCall = (action) =>
      transport.receivesCsmsCall(action);
    if (this._webSocket) {
      wireSocket(this._webSocket, {
        wsClientOptions,
        reconnectPolicy: this._reconnectPolicy,
        // Seeded even without `simulation.seed` (no CLI flag or `cp.create`
        // field sets one): by the charge point id, so the same id draws the
        // same jitter on every run, like the SupervisionUrlPool's hash (#609).
        reconnectRng: () =>
          simulation.seed === undefined
            ? new RngStreams(this._id).stream(this._id, "reconnect")
            : this.rng("reconnect"),
        events: this._events,
      });
    }
    this._outbox = new Outbox(this._messageHandler);

    this._heartbeat = deps.createHeartbeat(this._logger, this._clock);
    this._heartbeat.setHeartbeatCallback(() => this._outbox.sendHeartbeat());
    this._clockAligned = new ClockAlignedMeterScheduler(
      (boundary) => this.emitClockAlignedSamples(boundary),
      this._clock,
    );
    this._txEndedAligned = new ClockAlignedMeterScheduler(
      (boundary) =>
        this.recordAlignedTxEndedSamples(
          this._configuration.stopTxnAlignedData(),
          boundary,
        ),
      this._clock,
    );

    // #299: a charge point that draws from a pool when a call names no tag.
    // An explicit tagId always wins, so this only ever fills a gap.
    this._idTags = new IdTagSource(
      transportOptions.idTags && transportOptions.idTags.length > 0
        ? new IdTagPool(
            transportOptions.idTags,
            transportOptions.idTagDistribution,
            this._id,
          )
        : null,
      { chargePoint: this },
    );

    this._reservationManager = new ReservationManager(
      this._logger,
      (connectorId, reservation) =>
        this._statusControl.onReservationExpired(connectorId, reservation),
      this._clock,
    );
    this._localAuthListManager = new LocalAuthListManager(this._logger);
    // #452: the policy is read on every decision, so ChangeConfiguration
    // applies at once. `_configuration` is assigned further down; nothing
    // reads the policy before the constructor returns.
    this._authorization = createStationAuthorization({
      clock: this._clock,
      configuration: () => this._configuration,
      localList: this._localAuthListManager,
      ocppVersion: this._ocppVersion,
      repositories: this._repositories,
    });

    this._stateManager = deps.createStateManager({
      logger: this._logger,
      events: this._events,
      chargePoint: () => ({ status: this._status, error: this._error }),
      clock: this._clock,
      rng: this.rng("state-history"),
    });

    // #448: subscribed before any connection or status event can fire.
    const timeline = deps.createTimeline({
      cpId: this._id,
      events: this._events,
      connectors: this._connectors,
      clock: this._clock,
      rng: this.rng("timeline"),
    });
    this._timeline = timeline.timeline;
    this._timelineProjector = timeline.projector;

    // ConfigurationStore is constructed last because it depends on `this`
    // (via the `defaultConfiguration(cp)` factory which reads
    // `cp.connectorNumber` / `cp.wsUrl`). Hot-reactive keys are wired here
    // so changes via ChangeConfiguration.req take effect immediately.
    this._configuration = ConfigurationStore.forChargePoint(
      this,
      this._repositories.configuration,
    );
    completeConstruction(this._parts, this._ctx, {
      securityProfile,
      authorizationKey,
      cpoName,
      powerSharing: transportOptions.chargerCapabilities?.powerSharing,
    });
  }

  /** Read a persisted Operative/Inoperative flag from the DB for the given
   *  connector (`0` = CP-level). Returns `null` if no override is stored. */
  private loadAvailability(connectorId: number): OCPPAvailability | null {
    return this._repositories.connectorSettings.loadAvailability(connectorId);
  }

  private saveAvailability(
    connectorId: number,
    availability: OCPPAvailability,
  ): void {
    this._repositories.connectorSettings.saveAvailability(
      connectorId,
      availability,
    );
  }

  /** The clock every timer and timestamp of this charge point reads. */
  get clock(): SimClock {
    return this._clock;
  }

  /** Rules that may take an inbound CSMS CALL over from the default path. */
  get behaviors(): ChargePointBehaviorRegistry {
    return this._behaviors;
  }

  /** The charger engine: event queue, engine state and behavior runner. */
  get engine(): ChargePointEngine {
    return this._engine;
  }

  /**
   * Load a behavior object (docs/concepts/charger-engine.md, "Behavior API")
   * into this station: its `onCall` rules take the matching inbound CALLs over
   * from the default behavior, and `main` starts. Throws on a duplicate id or
   * a `requires` this station cannot meet.
   */
  loadBehavior(behavior: Behavior, options?: LoadBehaviorOptions): void {
    this._engine.loadBehavior(behavior, options);
  }

  /** Unload a behavior loaded with {@link loadBehavior}; false if none has that id. */
  unloadBehavior(id: string): boolean {
    return this._engine.unloadBehavior(id);
  }

  /** The random stream `name` of this charge point (see `RngStreams`). */
  rng(name: string): Rng {
    return this._rngSource.stream(this._id, name);
  }

  /** The current instant of {@link clock} as a `Date`. */
  private _nowDate(): Date {
    return new Date(this._clock.now());
  }

  /** Where the message handler's PendingMessageQueue stores its rows
   *  (#878): a no-op repository when the CP runs in memory. */
  get pendingMessages(): PendingMessageRepository {
    return this._repositories.pendingMessages;
  }

  /** Force any buffered log lines to be flushed to the DB. Used before
   *  the Download Logs export so the file includes the last seconds of
   *  activity the log sink hasn't pushed out yet. */
  flushLogs(): void {
    this._logSink.flush();
  }

  /** In-memory log entries the Logger has accumulated this session,
   *  oldest-first. Used by the Download Logs path when the daemon is
   *  running without --state-db (no SQLite to read from). */
  getInMemoryLogs(): import("../../shared/Logger").LogEntry[] {
    return this._logger.getLogEntries();
  }

  /** #724 A05.FR.06-08: reconnect with the upgraded security profile.
   *  @see ConfigurationWiring.switchSecurityProfile */
  switchSecurityProfile(previousProfile: number): void {
    this._configWiring.switchSecurityProfile(previousProfile);
  }

  /** The station's power budget in watts now, `Infinity` without sharing. */
  stationPowerBudgetW(): number {
    return this._configWiring.stationPowerBudgetW();
  }

  /**
   * #347: whether the meter-value scheduler's samples taken during an OCPP
   * 2.x transaction ride TransactionEvent(Updated, MeterValuePeriodic)
   * instead of MeterValues. On by default (#551); false restores the
   * standalone MeterValues. Ignored on 1.x.
   */
  get txUpdatedMeterValues(): boolean {
    return this._txUpdatedMeterValues;
  }

  set txUpdatedMeterValues(enabled: boolean) {
    this._txUpdatedMeterValues = enabled;
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
   * is true, else `null` (#315).
   * @see MeterSampling.signedMeterFor
   */
  signedMeterFor(connectorId: number): OcmfMeter | null {
    return this._sampling.signedMeterFor(connectorId);
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

  /** Whether the Central System's latest BootNotification answer was
   *  `Accepted` and the connection has not closed since (#603). */
  get bootAccepted(): boolean {
    return this._bootState.bootAccepted;
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
   * §4.9 S3: whether this charge point can receive a CSMS-initiated call
   * (always on WebSocket; on SOAP only server-hosted with a callback URL and
   * a dispatchable action).
   * @see StationMessaging.canReceiveCsmsCall
   */
  canReceiveCsmsCall(action: string): boolean {
    return this._messaging.canReceiveCsmsCall(action);
  }

  get connectorNumber(): number {
    return this._connectors.size;
  }

  /** The station main meter (connector 0 / EVSE 0), `undefined` when the
   *  station has none (#617). */
  get mainMeter(): MainMeter | undefined {
    return this._mainMeter;
  }

  get connectors(): Map<number, Connector> {
    return new Map(this._connectors);
  }

  /**
   * How the domain connectors group into EVSEs (#628). The 1:1 station
   * (`StationTopology.identity`) today. A connector removed at run time stays
   * in the topology; whether it exists is still `getConnector`'s answer.
   */
  get topology(): StationTopology {
    return this._topology;
  }

  /** The EVSE a domain connector (k > 0) belongs to on the 2.x wire (#628);
   *  an id outside the topology keeps the 1:1 mapping. */
  private evseIdOf(connectorId: number): number {
    return this._topology.evseOf(connectorId) ?? connectorId;
  }

  /** The idTag to present when the caller named none; `null` without a pool.
   *  @see IdTagSource.nextIdTag */
  nextIdTag(connectorId = 0): string | null {
    return this._idTags.nextIdTag(connectorId);
  }

  /** The pool's tags and distribution (#603), `null` without a pool.
   *  @see IdTagSource.idTagPoolInfo */
  idTagPoolInfo(): {
    tags: readonly string[];
    distribution: IdTagDistribution;
  } | null {
    return this._idTags.idTagPoolInfo();
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

  /** Whether a pool exists to replace (#314).
   *  @see IdTagSource.canReplaceIdTags */
  canReplaceIdTags(tags: readonly string[]): boolean {
    return this._idTags.canReplaceIdTags(tags);
  }

  /** Replace the pool's tags after an `idTagPool.file` was edited (#314).
   *  @see IdTagSource.replaceIdTags */
  replaceIdTags(tags: readonly string[]): boolean {
    return this._idTags.replaceIdTags(tags);
  }

  /** The PEM bundle that validates the current CSMS connection (#537), as
   *  {@link ChargePointSocket.connectionTrustAnchorsPem}; `undefined` on SOAP. */
  connectionTrustAnchorsPem(): string | undefined {
    return this._webSocket?.connectionTrustAnchorsPem();
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

  get stateManager(): ChargePointStateManager {
    return this._stateManager;
  }

  /** #448: operational timeline of this charge point. */
  get timeline(): ChargePointTimeline {
    return this._timeline;
  }

  /** Uploads the GetDiagnostics file (#575: injected through deps). */
  get fileUploader(): FileUploader {
    return this._fileUploader;
  }

  get logger(): Logger {
    return this._logger;
  }

  get reservationManager(): ReservationManager {
    return this._reservationManager;
  }

  /**
   * The parent id (1.6) or groupIdToken the station knows for `idTag`
   * (reservation matching, 1.6 §5.13, H03.FR.04/07); it never asks the CSMS.
   * @see AuthorizationFlow.knownParentIdOf
   */
  knownParentIdOf(idTag: string): string | undefined {
    return this._authorizationFlow.knownParentIdOf(idTag);
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

  /** OCPP 2.x NetworkConnectionProfiles, by configurationSlot (B09). */
  get networkProfiles(): NetworkProfileStore {
    return this._networkProfiles;
  }

  /** B09 SetNetworkProfile: validate and store `profile` in
   *  `configurationSlot`; the connection is left as it is.
   *  @see ConfigurationWiring.setNetworkProfile */
  setNetworkProfile(
    configurationSlot: number,
    profile: NetworkConnectionProfile,
  ): NetworkProfileVerdict {
    return this._configWiring.setNetworkProfile(configurationSlot, profile);
  }

  /** Local authorization (#452): Authorization Cache + Local Authorization
   *  List, and the decision over them. */
  get authorization(): StationAuthorization {
    return this._authorization;
  }

  /** Queue the transaction-related CALL written but not answered, so it is
   *  delivered after the next boot (a graceful shutdown that stopped waiting).
   *  Returns whether one was queued. */
  queueUnansweredTransactionCall(): boolean {
    return this._outbox.queueUnansweredTransactionCall();
  }

  /** Whether the CSMS is reachable now (#452 offline authorization). A SOAP
   *  charge point has no connection state and counts as online, which
   *  keeps its local start flow as it was. */
  isOnline(): boolean {
    if (!this._webSocket) return true;
    return this._webSocket.isConnected();
  }

  /** Feed a CSMS verdict on `idToken` to the Authorization Cache (#452) and
   *  report a conflict with the Local Authorization List (#744).
   *  @see AuthorizationFlow.recordAuthorizationResult */
  recordAuthorizationResult(
    idToken: string,
    result: CsmsAuthorizationResult,
  ): void {
    this._authorizationFlow.recordAuthorizationResult(idToken, result);
  }

  /** ClearCache (1.6 §5.4): empty the Authorization Cache. Returns whether
   *  it could be cleared. */
  clearAuthorizationCache(): boolean {
    return this._authorizationFlow.clearAuthorizationCache();
  }

  /** Read-only: install and remove profiles with `applyChargingProfile` /
   *  `clearChargingProfiles`, which report the change (#469). */
  get stationProfiles(): Pick<ChargingProfileStore, "all" | "getActive"> {
    return this._stationProfiles;
  }

  /**
   * Install a profile on the station store (`connectorId` 0) or on its
   * connector and emit `chargingProfileApplied`; `false` when the connector
   * does not exist (#469).
   * @see ChargingProfileControl.applyChargingProfile
   */
  applyChargingProfile(
    profile: ActiveChargingProfile,
    source: ChargingProfileSource,
    options: ApplyChargingProfileOptions = {},
  ): boolean {
    return this._profileControl.applyChargingProfile(profile, source, options);
  }

  /**
   * Remove the profiles matching `criteria` from the station store and/or the
   * connectors; returns the non-empty scopes.
   * @see ChargingProfileControl.clearChargingProfiles
   */
  clearChargingProfiles(
    connectorId: number | undefined,
    criteria: ProfileRemoveCriteria,
    reason: ChargingProfileClearReason,
  ): ClearedChargingProfiles[] {
    return this._profileControl.clearChargingProfiles(
      connectorId,
      criteria,
      reason,
    );
  }

  /** The active ChargePointMaxProfile at the station level, `null` if none. */
  getActiveChargePointMaxProfile(
    now: Date = this._nowDate(),
  ): ActiveChargingProfile | null {
    return this._profileControl.getActiveChargePointMaxProfile(now);
  }

  /** Register a connector as handled by a scenario.
   *  @see ScenarioCallOwnership.register */
  registerScenarioHandler(connectorId: number): void {
    this._scenarioCalls.register(connectorId);
  }

  unregisterScenarioHandler(connectorId: number): void {
    this._scenarioCalls.unregister(connectorId);
  }

  isScenarioHandled(connectorId: number): boolean {
    return this._scenarioCalls.isHandled(connectorId);
  }

  notifyRemoteStartReceived(
    connectorId: number,
    tagId: string,
    remoteStartId?: number,
    idTokenType?: IdTokenTypeName,
  ): void {
    this._events.emit("remoteStartReceived", {
      connectorId,
      tagId,
      ...(remoteStartId !== undefined ? { remoteStartId } : {}),
      ...(idTokenType !== undefined ? { idTokenType } : {}),
    });
  }

  /** Record a RemoteStartTransaction handled by the default path.
   *  @see ScenarioCallOwnership.noteDefaultHandledRemoteStart */
  noteDefaultHandledRemoteStart(connectorId: number): void {
    this._scenarioCalls.noteDefaultHandledRemoteStart(connectorId);
  }

  /** Consume the timestamp noteDefaultHandledRemoteStart recorded.
   *  @see ScenarioCallOwnership.takeDefaultHandledRemoteStart */
  takeDefaultHandledRemoteStart(
    connectorId: number,
    sinceMs: number,
  ): number | null {
    return this._scenarioCalls.takeDefaultHandledRemoteStart(
      connectorId,
      sinceMs,
    );
  }

  /** Stop-side counterpart of registerScenarioHandler.
   *  @see ScenarioCallOwnership.registerStop */
  registerScenarioStopHandler(connectorId: number): void {
    this._scenarioCalls.registerStop(connectorId);
  }

  unregisterScenarioStopHandler(connectorId: number): void {
    this._scenarioCalls.unregisterStop(connectorId);
  }

  isScenarioStopHandled(connectorId: number): boolean {
    return this._scenarioCalls.isStopHandled(connectorId);
  }

  notifyRemoteStopReceived(connectorId: number, transactionId: number): void {
    this._events.emit("remoteStopReceived", { connectorId, transactionId });
  }

  /** Mirror of noteDefaultHandledRemoteStart for the stop side. */
  noteDefaultHandledRemoteStop(connectorId: number): void {
    this._scenarioCalls.noteDefaultHandledRemoteStop(connectorId);
  }

  /** Mirror of takeDefaultHandledRemoteStart for the stop side. */
  takeDefaultHandledRemoteStop(
    connectorId: number,
    sinceMs: number,
  ): number | null {
    return this._scenarioCalls.takeDefaultHandledRemoteStop(
      connectorId,
      sinceMs,
    );
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

  /** Keep the transaction but stop the energy delivery after a non-Accepted id.
   *  @see AuthorizationFlow.holdEnergyOnInvalidId */
  holdEnergyOnInvalidId(connector: Connector): void {
    this._authorizationFlow.holdEnergyOnInvalidId(connector);
  }

  /** Called by StartTransactionResultHandler when StartTransaction.conf
   *  carries a non-Accepted idTagInfo.status (issue #181). */
  notifyStartTransactionNotAccepted(
    connectorId: number,
    status: string,
    stopped: boolean,
    midSession = false,
  ): void {
    this._events.emit("startTransactionNotAccepted", {
      connectorId,
      status,
      stopped,
      ...(midSession && { midSession: true as const }),
    });
  }

  /** Called by the handlers on each failed transmission of a
   *  transaction-related message: a 2.x TransactionEvent answered with a
   *  CALLERROR (#490) or left without answer for `MessageTimeout` (#529), a
   *  1.6 StartTransaction, StopTransaction or MeterValues of a transaction
   *  answered with a CALLERROR (#527). Reports only: the transaction is
   *  untouched. */
  notifyTransactionMessageRejected(
    event: ChargePointEvents["transactionMessageRejected"],
  ): void {
    this._events.emit("transactionMessageRejected", event);
  }

  /** Called by the handlers when a transaction-related message failed its
   *  last attempt and is dropped (#490, #527). Reports only, like the
   *  above. */
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

  /** Authorize `tagId` for a local start (#181, #452); never rejects.
   *  @see AuthorizationFlow.authorizeAndWait */
  authorizeAndWait(
    tagId: string,
    timeoutMs = 10000,
    idTokenType?: IdTokenTypeName,
    options: { failClosed?: boolean } = {},
  ): Promise<string> {
    return this._authorizationFlow.authorizeAndWait(
      tagId,
      timeoutMs,
      idTokenType,
      options,
    );
  }

  armResponseOverride(action: string, status: string): void {
    this._callOverrides.armResponseOverride(action, status);
  }

  /** Returns and clears the armed status for `action`, or null. */
  consumeResponseOverride(action: string): string | null {
    return this._callOverrides.consumeResponseOverride(action);
  }

  /** Read-only probe: is an override armed for `action`? Test/diagnostic
   *  helper — does not consume. */
  hasResponseOverride(action: string): boolean {
    return this._callOverrides.hasResponseOverride(action);
  }

  /** Clear an armed response override. No-op if not armed. */
  clearResponseOverride(action: string): void {
    this._callOverrides.clearResponseOverride(action);
  }

  /** Set an inbound call policy for `action`. Policies are sticky and survive
   *  reconnects; use clearInboundCallPolicy to remove. */
  setInboundCallPolicy(action: string, policy: InboundCallPolicy): void {
    this._callOverrides.setInboundCallPolicy(action, policy);
  }

  /** Get the inbound call policy for `action`, or undefined if none is set. */
  getInboundCallPolicy(action: string): InboundCallPolicy | undefined {
    return this._callOverrides.getInboundCallPolicy(action);
  }

  /** Clear the inbound call policy for `action`. If `action` is not provided,
   *  clear all policies. */
  clearInboundCallPolicy(action?: string): void {
    this._callOverrides.clearInboundCallPolicy(action);
  }

  /** Set certificate quirks (CSR generation options, acceptance policies, etc.).
   *  Shallow-merges into current quirks; unset fields inherit prior values.
   *  Sticky until explicitly cleared. */
  setCertificateQuirks(quirks: Partial<CertificateQuirks>): void {
    this._callOverrides.setCertificateQuirks(quirks);
  }

  /** Reset all certificate quirks to empty state. */
  clearCertificateQuirks(): void {
    this._callOverrides.clearCertificateQuirks();
  }

  /** Read-only access to current certificate quirks. */
  get certificateQuirks(): CertificateQuirks {
    return this._callOverrides.certificateQuirks;
  }

  set loggingCallback(callback: (entry: LogEntry) => void) {
    this._logger._loggingCallback = callback;
  }

  connect(): void {
    this._outage.connect();
  }

  /**
   * Send a StatusNotification.req with explicit errorCode/info/vendorErrorCode,
   * without mutating the connector's status; connector 0 takes only
   * Available / Unavailable / Faulted (§7.7).
   * @see ConnectorStatusControl.sendStatusNotificationRaw
   */
  sendStatusNotificationRaw(
    connectorId: number,
    status: OCPPStatus,
    opts: StatusNotificationOptions,
  ): void {
    this._statusControl.sendStatusNotificationRaw(connectorId, status, opts);
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
   * OCPP-J version, with the payload as given.
   * @see StationMessaging.sendOcppCall
   */
  async sendOcppCall(request: OcppCallRequest): Promise<OcppCallOutcome> {
    return this._messaging.sendOcppCall(request);
  }

  /**
   * Expert raw frame (#393, level C of #389): one text frame written to the
   * WebSocket as given, outside the 1.6 serial CALL queue.
   * @see StationMessaging.sendRawFrame
   */
  sendRawFrame(request: RawFrameRequest): Promise<RawFrameOutcome> {
    return this._messaging.sendRawFrame(request);
  }

  /**
   * 2.0.1 / 2.1 Get15118EVCertificate relay (M01 / M02, #537); each request
   * goes through {@link sendOcppCall}, so 1.6 and SOAP stations refuse it.
   * @see StationMessaging.get15118EVCertificate
   */
  async get15118EVCertificate(
    request: Get15118EVCertificateRequest,
  ): Promise<Get15118EVCertificateResult> {
    return this._messaging.get15118EVCertificate(request);
  }

  /** #537 A02.FR.08: switch to the renewed client certificate by reconnecting.
   *  @see ClientCertificateSwitch.switchClientCertificate */
  async useRenewedClientCertificate(): Promise<void> {
    await this._certSwitch.switchClientCertificate(true);
  }

  /** #564: the same switch without the reconnect.
   *  @see ClientCertificateSwitch.switchClientCertificate */
  async adoptRenewedClientCertificate(): Promise<void> {
    await this._certSwitch.switchClientCertificate(false);
  }

  /** #537: end the renewed certificate switch for good.
   *  @see ClientCertificateSwitch.release */
  releaseRenewedClientCertificate(): void {
    this._certSwitch.release();
  }

  /** Programmatic trigger for SecurityEventNotification; see
   *  {@link IChargePointMessageHandler.sendSecurityEventNotification}. */
  sendSecurityEventNotification(
    type: string,
    techInfo?: string,
  ): Promise<void> {
    return this._outbox.sendSecurityEventNotification(type, techInfo);
  }

  /** Generate or forward a CSR and send OCPP 1.6 SignCertificate.req. */
  sendSignCertificate(csr?: string): Promise<void> {
    return this._outbox.sendSignCertificate(csr);
  }

  /** Send DiagnosticsStatusNotification.req — see OCPPMessageHandler doc. */
  sendDiagnosticsStatusNotification(status: DiagnosticsStatus): void {
    this._outbox.sendDiagnosticsStatusNotification(status);
  }

  /** Send FirmwareStatusNotification.req — see OCPPMessageHandler doc.
   *  @see StationMessaging.sendFirmwareStatusNotification */
  sendFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    this._messaging.sendFirmwareStatusNotification(status, requestId);
  }

  /** Send LogStatusNotification.req — see OCPPMessageHandler doc.
   *  @see StationMessaging.sendLogStatusNotification */
  sendLogStatusNotification(status: UploadLogStatus, requestId?: number): void {
    this._messaging.sendLogStatusNotification(status, requestId);
  }

  /** Counts every LogStatusNotification this station sent (N01.FR.09).
   *  @see StationMessaging.logStatusSeq */
  get logStatusSeq(): number {
    return this._messaging.logStatusSeq;
  }
  get lastLogStatusRequestId(): number | undefined {
    return this._messaging.lastLogStatusRequestId;
  }

  /** `requestId` of the last accepted UpdateFirmware.req (#345).
   *  @see StationMessaging.noteFirmwareRequest */
  noteFirmwareRequest(requestId: number): void {
    this._messaging.noteFirmwareRequest(requestId);
  }
  get lastFirmwareRequestId(): number | undefined {
    return this._messaging.lastFirmwareRequestId;
  }
  /** Same for GetLog.req → LogStatusNotification. */
  noteLogRequest(requestId: number): void {
    this._messaging.noteLogRequest(requestId);
  }
  get lastLogRequestId(): number | undefined {
    return this._messaging.lastLogRequestId;
  }

  /** Send SignedFirmwareStatusNotification.req — see OCPPMessageHandler doc. */
  sendSignedFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    this._messaging.sendSignedFirmwareStatusNotification(status, requestId);
  }

  /** The CSMS answered a StatusNotification for `connectorId` (0 = the charge
   *  point) with `status` (#702). */
  noteStatusAcknowledged(connectorId: number, status: OCPPStatus): void {
    this._outage.ackedStatus.set(connectorId, status);
  }

  /** Boot-notification gate accessors used by BootNotificationResultHandler. */
  markBootAccepted(): void {
    this._boot.markBootAccepted();
  }

  /** §4.2: run `fn` as the answer to an accepted TriggerMessage. */
  runTriggered<T>(fn: () => T): T {
    return this._outbox.runTriggered(fn);
  }

  markBootPending(): void {
    this._boot.markBootPending();
  }

  markBootRejected(retryAfterSeconds: number): void {
    this._boot.markBootRejected(retryAfterSeconds);
  }

  /** The single entry point for a processed BootNotification.conf.
   *  @see BootLifecycle.onBootNotificationResult */
  onBootNotificationResult(result: BootNotificationResult): void {
    this._boot.onBootNotificationResult(result);
  }

  /** #607: append one formatted sample to the transaction-end history.
   *  @see MeterSampling.recordTxEndedSample */
  recordTxEndedSample(
    connector: Connector,
    measurands: string[],
    context: "Transaction.Begin" | "Sample.Periodic" | "Sample.Clock",
    timestamp: Date,
  ): void {
    this._sampling.recordTxEndedSample(
      connector,
      measurands,
      context,
      timestamp,
    );
  }

  /** A station without power starts, stops and boots nothing (#798). */
  private assertPowered(): void {
    if (this._power.poweredOff) throw new PowerStateError("powered_off");
  }

  /**
   * Send BootNotification.req. `reason` (2.x B01.FR.09) is remembered until
   * the boot is Accepted, so the retry after a Rejected answer repeats it;
   * an Accepted boot falls back to PowerUp, the reason of a plain reconnect.
   */
  boot(reason?: BootReason): void {
    this.assertPowered();
    if (reason) this._bootState.bootReason = reason;
    // A boot asked for while the socket is down (a Reset, a retry timer) is
    // lost on the wire: the next open must send it (#702).
    if (!this.isOnline()) this._outage.bootOnNextOpen = true;
    this._bootState.bootUnanswered = true;
    this._outage.ackedStatus = new Map();
    this._bootState.bootSentFingerprint = JSON.stringify(this.bootPayload());
    // OCPP 1.6J §4.2: the CP MUST NOT send any other CALL message until
    // BootNotification has been Accepted. The connector-level
    // StatusNotification fan-out happens in BootNotificationResultHandler
    // after we get the Accepted response.
    this._outbox.sendBootNotification(
      this.bootPayload(),
      this._bootState.bootReason,
    );
    this.error = "";
  }

  disconnect(): void {
    this._outage.disconnect();
  }

  reset(reason: BootReason = "LocalReset"): void {
    this._outage.reset(reason);
  }

  /** Whether the station is without power (#455). */
  get poweredOff(): boolean {
    return this._power.poweredOff;
  }

  /** Simulate a power loss (#455).
   *  @see PowerLossController.powerLoss */
  powerLoss(options: PowerLossOptions = {}): PowerLossRecord {
    return this._power.powerLoss(options);
  }

  /** Power returns (#455).
   *  @see PowerLossController.restorePower */
  restorePower(options: PowerRestoreOptions = {}): PowerRestoreResult {
    return this._power.restorePower(options);
  }

  /**
   * Stop variable monitoring for good: its periodic timers, which run
   * offline too (N08.FR.03), and any event still in flight. For an
   * instance being discarded without {@link dispose} — the one a
   * `cp.update` replaces — whose timers would otherwise keep it alive and
   * queue NotifyEvents under its id (#538).
   */
  stopMonitoring(): void {
    this._monitorEvaluation?.dispose();
  }

  /**
   * Terminal teardown: permanently releases the charge point.
   * Shuts down the network-sim controller and closes the socket,
   * then runs final CP-side teardown.
   */
  dispose(): void {
    this._outage.dispose();
  }

  applyRemoteReset(
    type: ChargePointResetType,
    source: ChargePointResetSource = "ocpp-call",
  ): void {
    this._resetOnIdle.applyRemoteReset(type, source);
  }

  authorize(
    tagId: string,
    idTokenType?: IdTokenTypeName,
    hooks?: AuthorizeSendHooks,
  ): void {
    if (hooks !== undefined) this._outbox.authorize(tagId, idTokenType, hooks);
    else if (idTokenType === undefined) this._outbox.authorize(tagId);
    else this._outbox.authorize(tagId, idTokenType);
  }

  set status(newStatus: ChargePointStatus) {
    this._statusControl.setStationStatus(newStatus);
  }

  /** Start a transaction on a connector; the default lives in the engine
   *  (`application/engine/behaviors/transaction.ts`), reached through
   *  `deps.transactions` (#575). */
  startTransaction(
    tagId: string,
    connectorId: number,
    batteryCapacityKwh?: number,
    initialSoc?: number,
    options: StartTransactionOptions = {},
  ): Promise<StartTransactionOutcome> {
    this.assertPowered();
    return this._transactions.start(
      this,
      this.transactionPorts,
      tagId,
      connectorId,
      batteryCapacityKwh,
      initialSoc,
      options,
    );
  }

  stopTransaction(
    connectorOrId: number | Connector,
    reason?: StopTransactionReason,
    options: StopTransactionOptions = {},
  ): void {
    // The recovery decides how a transaction interrupted by a power loss
    // ends (`runPowerRecovery`); nothing ends it while the station is off.
    this.assertPowered();
    this._transactions.stop(
      this,
      this.transactionPorts,
      connectorOrId,
      reason,
      options,
    );
  }

  /** #597: record a Reset OnIdle answered `Scheduled`.
   *  @see ResetOnIdle.scheduleResetOnIdle */
  scheduleResetOnIdle(evseId?: number): void {
    this._resetOnIdle.scheduleResetOnIdle(evseId);
  }

  /** #597: drop every pending Reset OnIdle.
   *  @see ResetOnIdle.cancelPendingResetsOnIdle */
  cancelPendingResetsOnIdle(evseId?: number): void {
    this._resetOnIdle.cancelPendingResetsOnIdle(evseId);
  }

  /** #597: boot again once a pending reset has no busy target left.
   *  @see ResetOnIdle.runPendingResetOnIdle */
  runPendingResetOnIdle(): void {
    this._resetOnIdle.runPendingResetOnIdle();
  }

  /**
   * Reset one EVSE (2.x B11.FR.08, B12.FR.12/14): reported Unavailable, then
   * back to the state it had; no BootNotification (B11.FR.03/04).
   * @see ConnectorStatusControl.resetEvse
   */
  resetEvse(evseId: number): void {
    this._statusControl.resetEvse(evseId);
  }

  /** The EV side of the cable was unplugged (#488).
   *  @see PlugInFlow.evDisconnected */
  evDisconnected(connectorId: number): void {
    this._plugIn.evDisconnected(connectorId);
  }

  /** The status a connector shows when whatever held it ends.
   *  @see PlugInFlow.statusWhenFree */
  statusWhenFree(connectorId: number): OCPPStatus {
    return this._plugIn.statusWhenFree(connectorId);
  }

  /** A cable was plugged into the connector's EV side (#453).
   *  @see PlugInFlow.evPlugIn */
  evPlugIn(connectorId: number): void {
    this._plugIn.evPlugIn(connectorId);
  }

  /** #697: hold an authorized idToken until the cable is plugged in. */
  deferStartUntilPlugIn(
    connectorId: number,
    tagId: string,
    options: StartTransactionOptions,
  ): void {
    this._plugIn.deferStartUntilPlugIn(connectorId, tagId, options);
  }

  /** The EV asks for energy or stops asking (#453).
   *  @see PlugInFlow.evSetReady */
  evSetReady(connectorId: number, ready: boolean): void {
    this._plugIn.evSetReady(connectorId, ready);
  }

  cleanTransaction(connectorOrId: Connector | number): void {
    this._transactions.clean(this, connectorOrId);
  }

  private readonly transactionPorts: TransactionPorts = {
    sendTransactionEvent: (event) => this._outbox.sendTransactionEvent(event),
    startConnectionTimeout: (connectorId) =>
      this._connectionTimeouts.start(connectorId),
  };

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

  get heartbeat(): ChargePointHeartbeat {
    return this._heartbeat;
  }

  setMeterValue(connectorId: number, value: number): void {
    this._sampling.setMeterValue(connectorId, value);
  }

  sendMeterValue(
    connectorId: number,
    context?: ReadingContext,
    overrides?: MeterSampleOverrides,
  ): void {
    this._sampling.sendMeterValue(connectorId, context, overrides);
  }

  /** One sample from the connector's meter-value scheduler (#347).
   *  @see MeterSampling.sendScheduledMeterValue */
  sendScheduledMeterValue(connectorId: number): void {
    this._sampling.sendScheduledMeterValue(connectorId);
  }

  // Kept for tests that cast to reach it.
  private emitClockAlignedSamples(boundaryMs: number): void {
    this._sampling.emitClockAlignedSamples(boundaryMs);
  }

  private recordAlignedTxEndedSamples(
    measurands: string[],
    boundaryMs: number,
  ): void {
    this._sampling.recordAlignedTxEndedSamples(measurands, boundaryMs);
  }

  // @ts-expect-error TS6133: read by tests through a cast, not by this class
  private get _periodicSamplers(): Map<number, TimerHandle> {
    return this._sampling.samplers;
  }

  /** Drive an OCPP 2.x TransactionEvent(Updated) on a running transaction
   *  (#335); on 1.6 a warning and nothing sent.
   *  @see StationMessaging.sendTransactionUpdate */
  sendTransactionUpdate(
    connectorId: number,
    options: TransactionUpdateOptions,
  ): void {
    this._messaging.sendTransactionUpdate(connectorId, options);
  }

  getConnector(connectorId: number): Connector | undefined {
    return this._connectors.get(connectorId);
  }

  removeConnector(connectorId: number): boolean {
    return this._connectorWiring.removeConnector(connectorId);
  }

  updateAllConnectorsStatus(status: OCPPStatus): void {
    this._statusControl.updateAllConnectorsStatus(status);
  }

  /**
   * Change a connector's status and report it with a StatusNotification.
   * `allowInvalidTransition` sends an out-of-table 1.6 §4.9 transition under
   * `statusTransitions: "enforce"` (#618).
   * @see ConnectorStatusControl.updateConnectorStatus
   */
  updateConnectorStatus(
    connectorId: number,
    status: OCPPStatus,
    options: { readonly allowInvalidTransition?: boolean } = {},
  ): void {
    this._statusControl.updateConnectorStatus(connectorId, status, options);
  }

  /** A write to a connector's engine record (docs/concepts/charger-engine.md). */
  private writeConnector(connectorId: number, write: ConnectorWrite): void {
    this._engine.dispatch({ type: "connector.write", connectorId, write });
  }

  /**
   * The rest of a `full` status write, run by the engine after the record
   * changed: the connection-timeout timer and the StatusNotification.
   * @internal
   * @see ConnectorStatusControl.afterConnectorStatus
   */
  afterConnectorStatus(
    connectorId: number,
    status: OCPPStatus,
    sendNotification = true,
  ): void {
    this._statusControl.afterConnectorStatus(
      connectorId,
      status,
      sendNotification,
    );
  }

  /**
   * Sends a StatusNotification.req for the current state (no domain mutation)
   * for TriggerMessage; connector 0 is the main controller, omitted fans out.
   * @see ConnectorStatusControl.sendCurrentStatusNotification
   */
  sendCurrentStatusNotification(connectorId?: number): void {
    this._statusControl.sendCurrentStatusNotification(connectorId);
  }

  /**
   * The cellular modem and SIM (#928), or `null` when no modem model is
   * configured for this station (the legacy default).
   */
  get modem(): CellularModem | null {
    return this._cellular.modem;
  }

  /**
   * The BootNotification as it would be sent now (#929): the static boot data
   * with `iccid` / `imsi` of the installed SIM.
   * @see BootLifecycle.bootPayload
   */
  bootPayload(): BootNotification {
    return this._boot.bootPayload();
  }

  /**
   * The firmware the station runs from now on, for every later
   * BootNotification; emits `firmwareVersionChanged` when it changed.
   * @see BootLifecycle.setFirmwareVersion
   */
  setFirmwareVersion(firmwareVersion: string): void {
    this._boot.setFirmwareVersion(firmwareVersion);
  }

  /** #930: install the SIM-scoped policies.
   *  @see CellularLinkController.setCellularPolicies */
  setCellularPolicies(policies: CellularPolicySet): void {
    this._cellular.setCellularPolicies(policies);
  }

  /** #930: the resolved cellular link, or `null` without a modem model. */
  cellularLink(): CellularLinkState | null {
    return this._cellular.cellularLink();
  }

  /** #930: the masked modem state with its resolved link.
   *  @see CellularLinkController.modemState */
  modemState(): (RedactedModemState & { link: CellularLinkWire }) | null {
    return this._cellular.modemState();
  }

  /**
   * Public network-sim forwarding: apply network simulation config at runtime.
   * No-op for SOAP charge points (this._webSocket is null).
   * Stores a summary { enabled, manualRuleIds } for dashboard UI.
   */
  setNetworkSimConfig(resolved: ResolvedNetworkSimConfig): void {
    this._cellular.setNetworkSimConfig(resolved);
  }

  /**
   * Network simulation summary: { enabled, manualRuleIds } if a config has been
   * applied, or null for SOAP CPs / when no config has been applied yet.
   */
  networkSimSummary(): { enabled: boolean; manualRuleIds: string[] } | null {
    return this._cellular.networkSimSummary();
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
    return this._cellular.triggerNetworkSimDisconnect(ruleId);
  }
}
