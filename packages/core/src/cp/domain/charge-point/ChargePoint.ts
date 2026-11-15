import type { VehicleBehaviorDriver } from "./VehicleBehaviorDriver";

import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "../types/FirmwareLogStatus";

import {
  capabilityProfileConflicts,
  disabledActionErrorCode,
  isActionDisabled,
  isTriggerTargetSupported,
  type ChargePointCapabilityProfile,
  type DisabledActionErrorCode,
} from "./CapabilityProfile";

import { translatesCsmsActionNames } from "../types/csmsActionNames";

import { DeviceModelPublisher } from "./DeviceModelPublisher";

import { ConfigurationWiring } from "./ConfigurationWiring";

import { AuthorizationFlow } from "./AuthorizationFlow";

import { MeterSampling } from "./MeterSampling";

import { PowerLossController } from "./PowerLossController";

import { ConnectionTimeouts } from "./ConnectionTimeouts";

import { ResetOnIdle } from "./ResetOnIdle";

import { PlugInFlow } from "./PlugInFlow";

import { ConnectorWiring } from "./ConnectorWiring";

import { BootLifecycle, type BootState } from "./BootLifecycle";

import { OutageLifecycle } from "./OutageLifecycle";

import { StationMessaging } from "./StationMessaging";

import { ConnectorStatusControl } from "./ConnectorStatusControl";

import { ChargingProfileControl } from "./ChargingProfileControl";
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

import { CallOverrides } from "./CallOverrides";

import { ScenarioCallOwnership } from "./ScenarioCallOwnership";

import { CellularLinkController } from "./CellularLinkController";

import { ClientCertificateSwitch } from "./ClientCertificateSwitch";

import { bootNotificationFor } from "../modem/bootIdentifiers";

import {
  type CellularLinkState,
  type CellularLinkWire,
  type CellularPolicySet,
} from "../modem/cellularLink";

import type { OcppCallActions } from "../transport/OcppCallActions";

import type {
  ChargePointDeps,
  ChargePointTransactions,
  ChargePointTransport,
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

import { isOcpp2Version, isSoapVersion, OCPP_1_6 } from "../types/OcppVersion";

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

import { idTokenMaxLength } from "../auth/AuthorizationCacheSeed";

import { AuthorizationCache } from "../auth/AuthorizationCache";

import {
  StationAuthorization,
  type CsmsAuthorizationResult,
} from "../auth/StationAuthorization";

import {
  ChargingProfileStore,
  type ApplyChargingProfileOptions,
  type ProfileRemoveCriteria,
} from "./ChargingProfileStore";

import type { ActiveChargingProfile } from "../connector/Connector";

import { CertificateStore } from "../security/CertificateStore";

import {
  checkNetworkProfile,
  NetworkProfileStore,
  type NetworkConnectionProfile,
  type NetworkProfileVerdict,
} from "../security/networkProfiles";

import { MonitoringStore } from "../monitoring/MonitoringStore";

import { DEFAULT_MONITOR_CATALOG } from "../monitoring/monitorCatalog";

import type { MonitorEvaluation } from "../monitoring/MonitorEvaluation";

import { OcmfMeter } from "../connector/SignedMeterData";

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
  /** SOAP dialect dispatch check; see {@link ChargePointTransport.receivesCsmsCall}. */
  private readonly _receivesCsmsCall: ChargePointTransport["receivesCsmsCall"];
  private readonly _messageHandler: IChargePointMessageHandler;
  private readonly _transportUrl: string;
  private readonly _certSwitch = new ClientCertificateSwitch({
    logger: () => this._logger,
    clock: () => this._clock,
    webSocket: () => this._webSocket,
    certificateStore: () => this._certificateStore,
    outbox: () => this._outbox,
    reset: () => this.reset(),
  });
  /** Tests read the pending wait's canceller through this name. */
  // @ts-expect-error TS6133: read by tests through a cast, not by this class
  private get _cancelClientCertificateSwitchTimer(): (() => void) | null {
    return this._certSwitch.pendingCancel;
  }
  private readonly _idTagPool: IdTagPool | null;
  private _bootAccepted = false;
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
  /** #702: a BootNotification was sent and not answered yet; a close in
   *  between loses it, so the next open sends one again. */
  private _bootUnanswered = false;
  /** #702: the BootNotification payload last sent, as JSON. */
  private _bootSentFingerprint: string | null = null;
  /** #702: the payload of the last BootNotification the CSMS Accepted; null
   *  while the last one was Pending or Rejected, or none was sent. */
  private _bootedWith: string | null = null;
  private readonly _stateManager: ChargePointStateManager;
  private readonly _timeline: ChargePointTimeline;
  private readonly _timelineProjector: ChargePointTimelineProjector;
  private readonly _logSink: LogSink;
  /** #878: the stores this charge point persists its own state through. */
  private readonly _repositories: ChargePointRepositories;
  private readonly _fileUploader: FileUploader;
  private readonly _reservationManager: ReservationManager;
  /** Parent id / groupIdToken of the tags the CSMS authorized (reservations). */
  private readonly _authorizedParents = new Map<string, string>();
  /** #597: Reset OnIdle requests answered `Scheduled`, each run once its transactions end. */
  /** Reason of the next BootNotification (2.x B01.FR.09); see {@link boot}. */
  private _bootReason: BootReason = "PowerUp";
  /** #455: set while the station is without power. */
  private readonly _localAuthListManager: LocalAuthListManager;
  private readonly _authorization: StationAuthorization;
  // §3.13.3: profiles installed with connectorId=0 (ChargePointMaxProfile,
  // station-wide TxDefaultProfile) belong at the CP level, not duplicated
  // onto every connector. Connectors consult this store at composite time.
  private readonly _stationProfiles: ChargingProfileStore =
    new ChargingProfileStore();
  private readonly _certificateStore: CertificateStore;
  private readonly _messaging = new StationMessaging({
    chargePoint: this,
    callCatalog: () => this._callCatalog,
    clock: () => this._clock,
    engine: () => this._engine,
    logger: () => this._logger,
    ocppVersion: () => this._ocppVersion,
    outbox: () => this._outbox,
    rawFrames: () => this._rawFrames,
  });
  private readonly _statusControl = new ConnectorStatusControl({
    chargePoint: this,
    connectionTimeouts: () => this._connectionTimeouts,
    connectors: () => this._connectors,
    engine: () => this._engine,
    events: () => this._events,
    logger: () => this._logger,
    nowDate: () => this._nowDate(),
    ocppVersion: () => this._ocppVersion,
    outbox: () => this._outbox,
    reservationManager: () => this._reservationManager,
    status: () => this._status,
    setStatus: (status) => {
      this._status = status;
    },
    stateManager: () => this._stateManager,
    writeConnector: (connectorId, write) =>
      this.writeConnector(connectorId, write),
  });
  private readonly _profileControl = new ChargingProfileControl({
    chargePoint: this,
    connectors: () => this._connectors,
    events: () => this._events,
    nowDate: () => this._nowDate(),
    stationProfiles: () => this._stationProfiles,
  });
  // OCPP 2.x variable monitors and monitoring level (N04-N06, #457).
  private readonly _monitoring = new MonitoringStore(DEFAULT_MONITOR_CATALOG);
  // #538: Target attributes of the 2.1 device model (EVSE.Power).
  private readonly _deviceModelTargets = new DeviceModelTargets();
  private readonly _authorizationFlow = new AuthorizationFlow({
    chargePoint: this,
    authorization: () => this._authorization,
    clock: () => this._clock,
    events: () => this._events,
    logger: () => this._logger,
  });
  private readonly _sampling = new MeterSampling({
    chargePoint: this,
    clock: () => this._clock,
    configuration: () => this._configuration,
    connectors: () => this._connectors,
    mainMeter: () => this._mainMeter,
    outbox: () => this._outbox,
  });
  private readonly _power = new PowerLossController({
    chargePoint: this,
    clock: () => this._clock,
    connectors: () => this._connectors,
    events: () => this._events,
    logger: () => this._logger,
    nowDate: () => this._nowDate(),
    ocppVersion: () => this._ocppVersion,
    outbox: () => this._outbox,
    markStartupEventPending: () => {
      this._boot.startupEventPending = true;
    },
    teardownAfterClose: () => this._outage.teardownAfterClose(),
    webSocket: () => this._webSocket,
  });
  private readonly _resetOnIdle = new ResetOnIdle({
    chargePoint: this,
    connectors: () => this._connectors,
  });
  private readonly _connectionTimeouts = new ConnectionTimeouts({
    chargePoint: this,
    clock: () => this._clock,
    configuration: () => this._configuration,
    logger: () => this._logger,
    ocppVersion: () => this._ocppVersion,
  });
  private readonly _plugIn = new PlugInFlow({
    chargePoint: this,
    configuration: () => this._configuration,
    connectionTimeouts: () => this._connectionTimeouts,
    logger: () => this._logger,
    ocppVersion: () => this._ocppVersion,
    outbox: () => this._outbox,
  });
  private readonly _connectorWiring = new ConnectorWiring({
    chargePoint: this,
    authorizationFlow: () => this._authorizationFlow,
    clock: () => this._clock,
    connectors: () => this._connectors,
    engine: () => this._engine,
    loadAvailability: (connectorId) => this.loadAvailability(connectorId),
    logger: () => this._logger,
    sampling: () => this._sampling,
    stationProfiles: () => this._stationProfiles,
    vehicleDrivers: () => this._vehicleDrivers,
    writeConnector: (connectorId, write) =>
      this.writeConnector(connectorId, write),
  });
  private readonly _bootState: BootState = (() => {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const cp = this;
    return {
      get bootAccepted() {
        return cp._bootAccepted;
      },
      set bootAccepted(value) {
        cp._bootAccepted = value;
      },
      get bootReason() {
        return cp._bootReason;
      },
      set bootReason(value) {
        cp._bootReason = value;
      },
      get bootedWith() {
        return cp._bootedWith;
      },
      set bootedWith(value) {
        cp._bootedWith = value;
      },
      get bootSentFingerprint() {
        return cp._bootSentFingerprint;
      },
      set bootSentFingerprint(value) {
        cp._bootSentFingerprint = value;
      },
      get bootUnanswered() {
        return cp._bootUnanswered;
      },
      set bootUnanswered(value) {
        cp._bootUnanswered = value;
      },
    };
  })();
  private readonly _boot: BootLifecycle = new BootLifecycle({
    chargePoint: this,
    state: this._bootState,
    clearOutage: () => this._outage.clearOutage(),
    clock: () => this._clock,
    clockAligned: () => this._clockAligned,
    configuration: () => this._configuration,
    events: () => this._events,
    logger: () => this._logger,
    monitorEvaluation: () => this._monitorEvaluation,
    ocppVersion: () => this._ocppVersion,
    outbox: () => this._outbox,
    power: () => this._power,
    reconnectPolicy: () => this._reconnectPolicy,
    txEndedAligned: () => this._txEndedAligned,
  });
  private readonly _outage: OutageLifecycle = new OutageLifecycle({
    chargePoint: this,
    state: this._bootState,
    boot: () => this._boot,
    callOverrides: () => this._callOverrides,
    cellular: () => this._cellular,
    certSwitch: () => this._certSwitch,
    clock: () => this._clock,
    clockAligned: () => this._clockAligned,
    configuration: () => this._configuration,
    connectionTimeouts: () => this._connectionTimeouts,
    connectors: () => this._connectors,
    engine: () => this._engine,
    events: () => this._events,
    heartbeat: () => this._heartbeat,
    localAuthListManager: () => this._localAuthListManager,
    logSink: () => this._logSink,
    logger: () => this._logger,
    monitorEvaluation: () => this._monitorEvaluation,
    nowDate: () => this._nowDate(),
    ocppVersion: () => this._ocppVersion,
    outbox: () => this._outbox,
    power: () => this._power,
    reservationManager: () => this._reservationManager,
    sampling: () => this._sampling,
    scenarioCalls: () => this._scenarioCalls,
    stationProfiles: () => this._stationProfiles,
    timelineProjector: () => this._timelineProjector,
    txEndedAligned: () => this._txEndedAligned,
    vehicleDrivers: () => this._vehicleDrivers,
    webSocket: () => this._webSocket,
    warnCapabilityProfileConflicts: () => this.warnCapabilityProfileConflicts(),
    writeConnector: (connectorId, write) =>
      this.writeConnector(connectorId, write),
  });
  private readonly _configWiring = new ConfigurationWiring({
    chargePoint: () => this,
    certificateStore: () => this._certificateStore,
    clockAligned: () => this._clockAligned,
    configuration: () => this._configuration,
    connectors: () => this._connectors,
    heartbeat: () => this._heartbeat,
    localAuthListManager: () => this._localAuthListManager,
    logger: () => this._logger,
    nowDate: () => this.nowDate(),
    ocppVersion: () => this._ocppVersion,
    rearmPeriodicSampling: () => this._sampling.rearmPeriodicSampling(),
    txEndedAligned: () => this._txEndedAligned,
    webSocket: () => this._webSocket,
  });
  private readonly _deviceModel = new DeviceModelPublisher({
    clock: () => this._clock,
    configuration: () => this._configuration,
    connectors: () => this._connectors,
    deviceModelTargets: () => this._deviceModelTargets,
    events: () => this._events,
    monitoring: () => this._monitoring,
    ocppVersion: () => this._ocppVersion,
    outbox: () => this._outbox,
    repositories: () => this._repositories,
    status: () => this._status,
    topology: () => this._topology,
    evseIdOf: (connectorId: number) => this.evseIdOf(connectorId),
  });
  // OCPP 2.x NetworkConnectionProfiles stored by SetNetworkProfile (B09).
  private readonly _networkProfiles = new NetworkProfileStore();
  // Their evaluation into NotifyEvent (kept by the device model publisher).
  private get _monitorEvaluation(): MonitorEvaluation | undefined {
    return this._deviceModel.evaluation;
  }
  private readonly _configuration: ConfigurationStore;
  // #315: one simulated signing meter per connector, made on first use.
  private readonly _signedMeters = new Map<number, OcmfMeter>();

  // §7.7: connectorId=0 status MUST be Available / Unavailable / Faulted.
  // The narrower type stops the rest of the code from accidentally setting
  // Charging / Preparing / Reserved etc. on the CP main controller.
  private _status: ChargePointStatus = OCPPStatus.Unavailable;
  private _error = "";
  private _autoMeterValueSetting: AutoMeterValueSetting | null;
  /** #347: see {@link sendScheduledMeterValue}. On by default (#551). */
  private _txUpdatedMeterValues = true;
  private readonly _scenarioCalls = new ScenarioCallOwnership({
    clock: () => this._clock,
  });
  private readonly _callOverrides = new CallOverrides();
  // §4.9 S3: whether this SOAP CP has a soapCallbackUrl (server-hosted) vs
  // send-only (browser local mode). For non-SOAP versions, always false.
  private readonly _hasSoapCallbackUrl: boolean;
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
  private readonly _capabilityProfile: ChargePointCapabilityProfile | undefined;

  /** See {@link ChargePointCapabilityProfile}. */
  get capabilityProfile(): ChargePointCapabilityProfile | undefined {
    return this._capabilityProfile;
  }

  /** Is the inbound `action` disabled by the capability profile (#618)? */
  isActionDisabled(action: string): boolean {
    return isActionDisabled(
      this._capabilityProfile,
      action,
      translatesCsmsActionNames(this._ocppVersion),
    );
  }

  /** The CALLERROR code a disabled action is answered with (#618). */
  disabledActionErrorCode(): DisabledActionErrorCode {
    return disabledActionErrorCode(this._capabilityProfile);
  }

  /**
   * Does this station keep a connector status change the OCPP 1.6 §4.9 table
   * does not list off the wire (`statusTransitions: "enforce"`, #618)? OCPP
   * 1.6J only: the table is written in the 1.6 status vocabulary, which 2.x
   * reports through a different ConnectorStatusEnumType with no such table.
   */
  get enforcesStatusTransitions(): boolean {
    return (
      this._capabilityProfile?.statusTransitions === "enforce" &&
      this._ocppVersion === OCPP_1_6
    );
  }

  /**
   * Log every place the capability profile contradicts the 1.6
   * `SupportedFeatureProfiles` configuration key (#618). Advisory: nothing
   * is refused.
   */
  private warnCapabilityProfileConflicts(): void {
    if (this._ocppVersion !== OCPP_1_6 || !this._capabilityProfile) return;
    const conflicts = capabilityProfileConflicts(
      this._capabilityProfile,
      this._configuration?.getArray("SupportedFeatureProfiles"),
    );
    for (const conflict of conflicts) {
      this._logger.warn(conflict.message, LogType.SYSTEM);
    }
  }

  /** May TriggerMessage request `target` under the capability profile (#618)? */
  isTriggerTargetSupported(target: string): boolean {
    return isTriggerTargetSupported(
      this._capabilityProfile,
      target,
      translatesCsmsActionNames(this._ocppVersion),
    );
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
    private _bootNotification: BootNotification,
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
    this._capabilityProfile = transportOptions.capabilityProfile;
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
    this._hasSoapCallbackUrl = !!transportOptions.soapCallbackUrl;

    // Setup logger callback to emit log events
    this._logger.loggingCallback = (entry) => {
      this._events.emit("log", {
        timestamp: entry.timestamp,
        level: entry.level,
        type: entry.type,
        message: entry.message,
      });
      // Buffered write — the default LogRepository batches up to 50
      // entries before hitting the DB so high-frequency log lines don't
      // thrash the IndexedDB flush in the browser.
      this._logSink.append(this._id, entry);
    };

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
    this._receivesCsmsCall = (action) => transport.receivesCsmsCall(action);
    if (this._webSocket) {
      this._webSocket.setWsClientOptions(wsClientOptions);
      // Seeded even without `simulation.seed` (no CLI flag or `cp.create`
      // field sets one): by the charge point id, so the same id draws the
      // same jitter on every run, like the SupervisionUrlPool's hash (#609).
      const reconnectRng =
        simulation.seed === undefined
          ? new RngStreams(this._id).stream(this._id, "reconnect")
          : this.rng("reconnect");
      this._webSocket.setReconnectPolicy(this._reconnectPolicy, () =>
        reconnectRng.next(),
      );
      this._webSocket.observers.on("reconnectGaveUp", ({ attempts }) =>
        this._events.emit("gaveUp", { target: "reconnect", attempts }),
      );
      this._webSocket.observers.on("simulatedDisconnect", (fault) =>
        this._events.emit("networkFaultInjected", fault),
      );
      this._webSocket.observers.on("reconnectScheduled", (info) =>
        this._events.emit("reconnecting", info),
      );
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
      (connectorId, reservation) =>
        this._statusControl.onReservationExpired(connectorId, reservation),
      this._clock,
    );
    this._localAuthListManager = new LocalAuthListManager(this._logger);
    // #452: the policy is read on every decision, so ChangeConfiguration
    // applies at once. `_configuration` is assigned further down; nothing
    // reads the policy before the constructor returns.
    this._authorization = new StationAuthorization({
      cache: new AuthorizationCache(this._repositories.authorizationCache, {
        clock: this._clock,
      }),
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
      clock: this._clock,
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
    this._configWiring.wireConfigurationListeners();
    this._configWiring.wirePowerSharing(
      transportOptions.chargerCapabilities?.powerSharing,
    );
    if (isOcpp2Version(this._ocppVersion)) {
      // 2.x: only the BasicAuthPassword (AuthorizationKey) guard; the
      // SecurityProfile prerequisites are the 1.6 ChangeConfiguration's (#704).
      this._configWiring.wireAuthorizationKeyGuard();
    } else if (this._webSocket) {
      this._configWiring.wireSecurityConfiguration();
    }
    // §5.2: a CP-level Unavailable set previously must survive a reboot.
    // We don't actually transition status here (no WebSocket yet); the
    // saved flag is reapplied when ChangeAvailability runs or when the
    // operator inspects the persisted state. Read before the 2.x runtime
    // values are first published, so ChargingStation.AvailabilityState
    // starts from it (#538).
    const persistedCp = this.loadAvailability(0);
    if (persistedCp === "Inoperative") {
      this._status = OCPPStatus.Unavailable;
    }
    if (isOcpp2Version(this._ocppVersion)) {
      this._deviceModel.wireVariableMonitoring();
      this._configWiring.wireCertificateEntries();
      this._configWiring.wireClockAndLocalList();
      this.wireRenewedClientIdentity();
    }
    // A persisted override never fires onChange; the scheduler only runs
    // once a boot is Accepted (#454).
    this._clockAligned.setIntervalSeconds(
      this._configuration.clockAlignedDataInterval(),
    );
    if (isOcpp2Version(this._ocppVersion)) {
      this._configWiring.applyRetryBackOff();
      this._txEndedAligned.setIntervalSeconds(
        this._configuration.alignedDataTxEndedInterval(),
      );
    }
    // A value persisted with --state-db is in force from the first open.
    this._webSocket?.setPingInterval(
      this._configuration.webSocketPingInterval(),
    );
    // #930: a suspended SIM on a cellular station keeps the link down from
    // the very first connect, also after a restart.
    this._cellular.reevaluateCellularLink();
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

  /**
   * #537: the transport presents a renewed Charging Station certificate
   * only while the store holds its key. Once the store's current chain has
   * none (replaced by a chain signed for a caller-supplied CSR, removed),
   * the transport forgets every renewed identity and presents the
   * configured `--tls-cert` again. A new keyed chain is switched to by
   * {@link useRenewedClientCertificate}, not here.
   */
  private wireRenewedClientIdentity(): void {
    this._certSwitch.watchClientIdentity();
  }

  /**
   * #724 A05.FR.06-08: after the CALLRESULT of an accepted `SecurityProfile`
   * upgrade the station disconnects and reconnects with the new profile.
   * When that connection does not open, the previous profile is put back
   * and used for the next attempt (A05.FR.08).
   */
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

  /** Whether the Central System's latest BootNotification answer was
   *  `Accepted` and the connection has not closed since (#603). */
  get bootAccepted(): boolean {
    return this._bootAccepted;
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
    return this._receivesCsmsCall(action) === true;
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
   * The pool's tags and distribution (#603), for traffic that keeps its own
   * seeded cursor instead of advancing the one `nextIdTag` shares. `null`
   * without a pool.
   */
  idTagPoolInfo(): {
    tags: readonly string[];
    distribution: IdTagDistribution;
  } | null {
    return this._idTagPool
      ? {
          tags: this._idTagPool.list(),
          distribution: this._idTagPool.distributionPolicy,
        }
      : null;
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
   * The parent id (1.6) or groupIdToken (2.x) the station knows for `idTag`:
   * Local Authorization List, then Authorization Cache, then the last
   * Authorize.conf (kept even when the cache is off). Reservation matching by
   * parent (1.6 §5.13, H03.FR.04/07) uses it; it never asks the CSMS itself.
   */
  knownParentIdOf(idTag: string): string | undefined {
    // A malformed CALL (warn mode runs the handler anyway) can name no tag.
    if (typeof idTag !== "string") return undefined;
    return (
      this._localAuthListManager.getEntry(idTag)?.parentIdTag ??
      this._authorization.cache.get(idTag)?.parentId ??
      this._authorizedParents.get(idTag)
    );
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

  /**
   * B09 SetNetworkProfile: validate `profile` against the station
   * (`checkNetworkProfile`) and, when valid, store it in
   * `configurationSlot`. The connection is left as it is: the stored profile
   * is used only by a later Reset or NetworkConfigurationPriority change.
   */
  setNetworkProfile(
    configurationSlot: number,
    profile: NetworkConnectionProfile,
  ): NetworkProfileVerdict {
    const verdict = checkNetworkProfile({
      configurationSlot,
      profile,
      currentSecurityProfile:
        this._configuration.getInteger("SecurityProfile") ?? 0,
      allowSecurityProfileDowngrade:
        this._configuration.allowSecurityProfileDowngrade(),
    });
    if (verdict.accepted) {
      this._networkProfiles.set(configurationSlot, profile);
      this._logger.info(
        `SetNetworkProfile: stored a profile in slot ${configurationSlot} (security profile ${profile.securityProfile}); the connection is unchanged`,
        LogType.CONFIGURATION,
      );
    } else {
      this._logger.warn(
        `SetNetworkProfile slot ${configurationSlot} rejected (${verdict.reasonCode}): ${verdict.additionalInfo}`,
        LogType.CONFIGURATION,
      );
    }
    return verdict;
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
   *  report a conflict with the Local Authorization List (#744):
   *  called by the Authorize / StartTransaction / StopTransaction result
   *  handlers. A no-op while the cache is disabled or for an identifier of
   *  the Local Authorization List (1.6 §3.5.3). */
  recordAuthorizationResult(
    idToken: string,
    result: CsmsAuthorizationResult,
  ): void {
    if (result.parentId !== undefined) {
      this._authorizedParents.set(idToken, result.parentId);
    } else {
      this._authorizedParents.delete(idToken);
    }
    if (this._authorization.recordCsmsResult(idToken, result)) {
      this._logger.debug(
        `Authorization cache updated: ${idToken} → ${result.status}`,
        LogType.TRANSACTION,
      );
    }
    // 1.6 §3.5.2: tell the CSMS when its verdict contradicts the Local
    // Authorization List. 2.x has no such notification (its StatusNotification
    // carries no errorCode).
    if (
      !isOcpp2Version(this._ocppVersion) &&
      this._authorization.conflictsWithLocalList(idToken, result.status)
    ) {
      this._logger.warn(
        `CSMS verdict ${result.status} for ${idToken} conflicts with the Local Authorization List; sending LocalListConflict`,
        LogType.OCPP,
      );
      this.sendStatusNotificationRaw(0, this._status, {
        errorCode: "LocalListConflict",
      });
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

  /**
   * Register a connector as being handled by a scenario.
   * When registered, RemoteStartTransaction handler will emit
   * remoteStartReceived instead of calling startTransaction directly.
   */
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

  /** Record that RemoteStartTransaction for `connectorId` was just handled
   *  by the default (non-scenario) path — i.e. isScenarioHandled(connectorId)
   *  was false at delivery time. See ScenarioCallOwnership. */
  noteDefaultHandledRemoteStart(connectorId: number): void {
    this._scenarioCalls.noteDefaultHandledRemoteStart(connectorId);
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
    return this._scenarioCalls.takeDefaultHandledRemoteStart(
      connectorId,
      sinceMs,
    );
  }

  /**
   * Counterpart of registerScenarioHandler for the stop side: a
   * RemoteStopTrigger scenario node registers here so the next
   * RemoteStopTransaction.req from CSMS gets routed into the scenario
   * via `remoteStopReceived` instead of the default handler running
   * stopTransaction() right away.
   */
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

  /**
   * `StopTransactionOnInvalidId=false` and the id was not accepted: keep the
   * transaction but stop the energy delivery (2.0.1
   * E05.FR.02/03, C15.FR.06; 2.x only, 1.6 errata 3.17 is #736). With `MaxEnergyOnInvalidId` > 0 that much energy
   * is delivered first; the connector reports SuspendedEVSE either way once
   * the delivery has stopped.
   */
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
   *
   * On OCPP 2.x the CALL may wait behind another one (Part 4 §4.1.1, #708), so
   * the timeout is armed when the Authorize is written, not when it is queued
   * (#762), and lasts at least `MessageTimeout`. `failClosed` (2.x F01.FR.01,
   * 1.6 §5.11: a remote start only after authorization was obtained, #921)
   * makes an unanswered Authorize resolve "Unknown" instead of
   * warn-and-proceed "Accepted".
   */
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

  /**
   * #537 A02.FR.08: after CertificateSigned accepted a new Charging Station
   * certificate, a security-profile-3 station switches to it by
   * reconnecting with it as its TLS client certificate, once its notBefore
   * has passed (2.0.1 asks for that; 2.1 gets the same wait). A station
   * that is not connected presents it at its next connection instead of
   * reconnecting. The reconnect waits, up to
   * {@link RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS}, for the transaction
   * messages in flight. Nothing happens on other profiles; when the store
   * holds no private key for the chain (a CSR the caller supplied) the
   * transport forgets any renewed identity. A restart or a `cp.update`
   * presents the configured `--tls-cert` again: the key is never
   * persisted. A call made while an earlier one still reads the store
   * supersedes it.
   */
  async useRenewedClientCertificate(): Promise<void> {
    await this._certSwitch.switchClientCertificate(true);
  }

  /**
   * #564: the same switch without the reconnect: the renewed certificate is
   * handed to the transport as soon as the chain is stored, so the next
   * connection presents it even if the CertificateSigned answer is dropped
   * before it is written (a manual disconnect while network simulation holds
   * it). The reconnect of an open connection stays with
   * {@link useRenewedClientCertificate}, run once the answer is written, so
   * the answer goes out on the connection that received the request.
   * Handing the same identity over again changes nothing, and neither call
   * runs on a connect, so no connection reconnects for it again.
   */
  async adoptRenewedClientCertificate(): Promise<void> {
    await this._certSwitch.switchClientCertificate(false);
  }

  /**
   * #537: ends the renewed certificate switch for good on an instance being
   * replaced (`cp.update`) or disposed: cancels the in-flight
   * wait, stops following the store, and drops every in-memory key — the
   * transport's renewed identities and the store's private keys. The
   * stored chains stay; the replacement presents the configured
   * `--tls-cert`, as after a restart.
   */
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

  /**
   * The single entry point for a processed BootNotification.conf, whatever
   * the OCPP version or transport. A status outside the three the spec
   * defines is treated as Rejected. The boot gate takes the new status first,
   * then `bootNotificationResult` is emitted, then the answer's own effects
   * run — so the event precedes every status change it causes (#395).
   */
  onBootNotificationResult(result: BootNotificationResult): void {
    this._boot.onBootNotificationResult(result);
  }

  /**
   * #607: append one formatted sample to the connector's transaction-end
   * history. Formatted now, from the point the sample set of this instant
   * reads, so a later configuration change cannot reformat it (#327 §3.3).
   */
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
    if (reason) this._bootReason = reason;
    // A boot asked for while the socket is down (a Reset, a retry timer) is
    // lost on the wire: the next open must send it (#702).
    if (!this.isOnline()) this._outage.bootOnNextOpen = true;
    this._bootUnanswered = true;
    this._outage.ackedStatus = new Map();
    this._bootSentFingerprint = JSON.stringify(this.bootPayload());
    // OCPP 1.6J §4.2: the CP MUST NOT send any other CALL message until
    // BootNotification has been Accepted. The connector-level
    // StatusNotification fan-out happens in BootNotificationResultHandler
    // after we get the Accepted response.
    this._outbox.sendBootNotification(this.bootPayload(), this._bootReason);
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

  /**
   * Simulate a power loss (#455): the station disappears without a clean
   * stop. The socket closes at once, nothing is sent until
   * {@link restorePower}, and no transaction ends. What a real station keeps
   * in non-volatile storage stays: the transactions (id, meter, tag) and the
   * queue of transaction messages that could not be delivered. A network
   * loss, an OCPP Reset and this are different events: a Reset ends the
   * transactions first (1.6 §5.14, 2.x B11/B12), a network loss keeps the
   * station running.
   */
  powerLoss(options: PowerLossOptions = {}): PowerLossRecord {
    return this._power.powerLoss(options);
  }

  /**
   * Power returns (#455). The station boots: BootNotification first (1.6
   * §4.2, 2.x B01.FR.03 "after a reboot (for instance due to ... power
   * outage)"), nothing else before it is Accepted, then the transaction
   * messages the outage left queued, then the recovery of the interrupted
   * transactions (see {@link PowerRestoreOptions}).
   */
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
    this.assertPowered();
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
    if (
      this._ocppVersion === "OCPP-1.6J" &&
      (this._configuration.getInteger("SecurityProfile") ?? 0) >= 1
    ) {
      // #734: reported once the station is back with an Accepted boot.
      this._outbox.queueSecurityEventNotification("ResetOrReboot", reason);
    }
    this._boot.startupEventPending = true;
    if (type === "Hard") {
      this.reset("RemoteReset");
    } else {
      this.boot("RemoteReset");
    }
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

  /**
   * #597: record a Reset OnIdle that was answered `Scheduled`. `evseId`
   * undefined targets every connector. It runs when the last targeted
   * transaction ends (see {@link runPendingResetOnIdle}).
   */
  scheduleResetOnIdle(evseId?: number): void {
    this._resetOnIdle.scheduleResetOnIdle(evseId);
  }

  /**
   * #597: drop every pending Reset OnIdle. An Immediate reset reboots the
   * station now, which already satisfies them; keeping them would boot
   * again on a later transaction end.
   */
  cancelPendingResetsOnIdle(evseId?: number): void {
    this._resetOnIdle.cancelPendingResetsOnIdle(evseId);
  }

  /**
   * #597: boot again once a pending reset has no targeted connector left
   * with a transaction. Called when a transaction ends (the engine's default stop) and when a
   * connector is removed. Each pending
   * reset stays queued while its targets are still busy; the station
   * boots once if any of them became runnable.
   */
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
   * Without a transaction a Preparing, Finishing or Suspended* connector goes
   * Available (1.6 §4.9 B1); an Unavailable, Faulted or Reserved one keeps its
   * status. The EV and cable model (#453) records the cable as unplugged.
   */
  evDisconnected(connectorId: number): void {
    this._plugIn.evDisconnected(connectorId);
  }

  /**
   * The status a connector shows when whatever held it (an unavailable
   * period, a reservation, a firmware hold) ends: `Preparing` (2.x `Occupied`)
   * while a cable is recorded and no transaction runs (1.6 §4.9; 2.0.1 G01,
   * H03.FR.10), else `Available`. Without this a plug-in during the hold stayed
   * recorded while `Available` was shown, and the next plug-in was swallowed
   * (#830 review).
   */
  statusWhenFree(connectorId: number): OCPPStatus {
    return this._plugIn.statusWhenFree(connectorId);
  }

  /**
   * A cable was plugged into the connector's EV side (#453). Idempotent: a
   * second plug-in changes nothing. An idle `Available` connector reports
   * `Preparing` (1.6 §4.9 transition A2, "insert plug"; 2.x StatusNotification
   * `Occupied`, the cable plugged in before the driver authorizes), which starts the
   * ConnectionTimeOut and allows the authorize / start that follows. In any
   * other state (a running transaction, Unavailable, Faulted, Reserved,
   * power lost) the cable is recorded and the status stays: the plug-in
   * does not lift them. Unplug with {@link evDisconnected}.
   */
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

  /**
   * The EV asks for energy (`ready`) or stops asking (#453). Needs a
   * plugged-in cable. With a running transaction, "not ready" suspends the
   * energy offer and reports `SuspendedEV` (1.6 §4.9 C4; 2.x TransactionEvent
   * Updated, chargingState `SuspendedEV`, triggerReason `ChargingStateChanged`),
   * and "ready" resumes `Charging` from that (D3). Without a transaction
   * the readiness is recorded and nothing is sent. Idempotent.
   */
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

  sendMeterValue(
    connectorId: number,
    context?: ReadingContext,
    overrides?: MeterSampleOverrides,
  ): void {
    if (connectorId === 0 && this._mainMeter) {
      this._outbox.sendMeterValue(undefined, 0, context, overrides);
      return;
    }
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
      overrides,
    );
  }

  /**
   * One sample from the connector's meter-value scheduler (#347).
   *
   * With {@link txUpdatedMeterValues} on and an OCPP 2.x transaction
   * running, it rides TransactionEvent(Updated, MeterValuePeriodic) with
   * `MeterValuesSampledData` (2.0.1 `SampledDataCtrlr.TxUpdatedMeasurands`),
   * so the E13 transaction-message retries cover it. A sample with nothing
   * in it sends nothing, as MeterValues does. Otherwise — option off, no
   * transaction, or OCPP 1.x — it is the MeterValues of
   * {@link sendMeterValue}. Only the scheduler calls this: a MeterValues a
   * caller or a TriggerMessage asks for stays a MeterValues.
   */
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
    this._sampling.stopPeriodicSampling(connectorId);
    // The driver's own 1 s timer outlives Connector.dispose() and would keep
    // calling evSetReady / stopTransaction on a connector the station no longer
    // has (#864 review).
    this._vehicleDrivers.get(connectorId)?.dispose();
    this._vehicleDrivers.delete(connectorId);
    connector.dispose();
    this._engine.detachConnector(connectorId);
    const removed = this._connectors.delete(connectorId);
    if (removed) {
      this._events.emit("connectorRemoved", { connectorId });
      // Removing a busy connector may make a station-wide OnIdle reset
      // runnable. runPendingResetOnIdle still waits if any remaining target
      // has a running transaction.
      this.runPendingResetOnIdle();
    }
    return removed;
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
   * The BootNotification as it would be sent now (#929): the static boot
   * data, with `iccid` / `imsi` taken from the installed SIM when a modem
   * model is configured. Read at the moment of every boot and of the 2.x
   * "did the boot data change" comparison on reconnect (#702); a SIM change
   * therefore shows up in the next real or triggered BootNotification and
   * never causes one by itself.
   */
  bootPayload(): BootNotification {
    return bootNotificationFor(this._bootNotification, this._cellular.modem);
  }

  /**
   * The firmware the station runs from now on: the `firmwareVersion` of
   * every later BootNotification (OCPP 1.6 §4.2, 2.0.1 B01). Set by a
   * simulated firmware update that ended in Installed with `bumpVersion`
   * (OCPP 1.6 §5.19, 2.0.1 L01), before the reboot's BootNotification. Sends
   * nothing by itself; emits `firmwareVersionChanged` when the value changed,
   * so a host can persist it. The boot data object is replaced, never
   * mutated: it may be shared with the caller that built the station.
   */
  setFirmwareVersion(firmwareVersion: string): void {
    const previous = this._bootNotification.firmwareVersion;
    if (previous === firmwareVersion) return;
    this._bootNotification = { ...this._bootNotification, firmwareVersion };
    this._logger.info(
      `Firmware version ${String(previous)} -> ${firmwareVersion}`,
      LogType.OCPP,
    );
    this._events.emit("firmwareVersionChanged", {
      firmwareVersion,
      ...(previous === undefined ? {} : { previous }),
    });
  }

  /**
   * #930: install the SIM-scoped policies (the daemon pushes the whole set to
   * every charge point, also to one created later). The selection is dynamic:
   * it is recomputed against the card in the slot now and after every SIM
   * change, so a replaced card is governed by the policies that match the new
   * one. Ignored by a station without a modem model.
   */
  setCellularPolicies(policies: CellularPolicySet): void {
    this._cellular.setCellularPolicies(policies);
  }

  /** #930: the resolved cellular link, or `null` without a modem model. */
  cellularLink(): CellularLinkState | null {
    return this._cellular.cellularLink();
  }

  /**
   * #930: the masked modem state with its resolved link, or `null` without a
   * modem model. `enforced` is false for a SOAP station: its transport is not
   * a socket the link gate can hold down.
   */
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
