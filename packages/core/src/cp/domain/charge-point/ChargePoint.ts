import { VehicleBehaviorDriver } from "./VehicleBehaviorDriver";
import {
  connectorShareW,
  stationBudgetW,
  type PowerSharingConfig,
  type ShareParticipant,
} from "./PowerSharing";
import {
  dcEfficiencyFor,
  maxDeliveryPowerWFor,
  meterRealismFor,
  type ChargerCapabilities,
} from "./ChargerCapabilities";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "../types/FirmwareLogStatus";
import {
  isActionDisabled,
  isTriggerTargetSupported,
  type ChargePointCapabilityProfile,
} from "./CapabilityProfile";
import { translatesCsmsActionNames } from "../types/csmsActionNames";
import { EventEmitter } from "../../shared/EventEmitter";
import { setTimeoutAt } from "../../shared/timers";
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
import { Connector } from "../connector/Connector";
import type { ConnectorWrite } from "../connector/ConnectorRecord";
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
import type {
  AuthorizeSendHooks,
  IChargePointMessageHandler,
} from "../transport/IChargePointMessageHandler";
import type {
  ChargePointSocket,
  SocketClose,
} from "../transport/ChargePointSocket";
import type { RawFrameSink } from "../transport/RawFrameSink";
import type { OcppCallActions } from "../transport/OcppCallActions";
import type {
  ChargePointDeps,
  ChargePointTransactions,
  ChargePointTransport,
} from "./ChargePointDeps";
import type { FileUploader } from "./FileUploader";
import type {
  CloseCause,
  GenerationToken,
  ResolvedNetworkSimConfig,
} from "../transport/networkSim";
import type { OcppSecurityProfile } from "@ocpp-cp-simulator/contracts/securityProfile";
import type { OcppTlsOptions } from "../transport/ConnectionSecurity";
import { measurandEnumFor } from "../connector/measurandEnum";
import { Outbox } from "../transport/Outbox";
import {
  type OcppCallOutcome,
  type OcppCallRequest,
  type RawFrameOutcome,
  type RawFrameRequest,
} from "../types/OcppCall";
import { OcppCallRejectedError } from "../errors/OcppCallErrors";
import {
  relayGet15118EVCertificate,
  type Get15118EVCertificateRequest,
  type Get15118EVCertificateResult,
} from "../security/get15118EVCertificate";
import type { ChargePointRepositories } from "../persistence/ChargePointRepositories";
import type { Database } from "../persistence/Database";
import type { LogSink } from "../persistence/LogSink";
import type {
  ChargePointErrorCode,
  OCPPAvailability,
  StatusNotificationOptions,
  BootNotification,
  BootReason,
  ChargePointStatus,
} from "../types/OcppTypes";
import {
  isOcpp2Version,
  isSoapVersion,
  OCPP_2_0_1,
  OCPP_2_1,
} from "../types/OcppVersion";
import { DeviceModelTargets } from "./DeviceModelTargets";
import {
  ChargingProfilePurposeType,
  isChargePointStatus,
  OCPPStatus,
} from "../types/OcppTypes";
import type {
  IdTokenTypeName,
  StopTransactionReason,
  TransactionChargingState,
  TransactionStartTriggerReason,
  TransactionStopTriggerReason,
  TransactionStoppedReason,
  TransactionUpdateOptions,
} from "../connector/Transaction";
import { TX_ENDED_SAMPLES_MAX } from "../connector/Transaction";
import {
  buildSampledValues,
  reportedActivePowerW,
  type MeterSampleOverrides,
  type ReadingContext,
} from "../connector/MeterValueBuilder";
import {
  evseValueKey,
  RUNTIME_VALUE_KEYS,
  toV2ConnectorStatus,
  V2_CONNECTOR_STATUSES,
} from "./runtimeValueKeys";
import {
  ReservationManager,
  type Reservation,
} from "../reservation/Reservation";
import { syncUnspecifiedReservations } from "../reservation/reservationModel";
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
  type ApplyChargingProfileOptions,
  type ProfileRemoveCriteria,
} from "./ChargingProfileStore";
import type { ActiveChargingProfile } from "../connector/Connector";
import { CertificateStore } from "../security/CertificateStore";
import {
  checkSecurityProfileChange,
  isValidAuthorizationKey,
  isCertificateCurrentlyValid,
} from "../security/securityProfileChange";
import {
  MONITORING_BASES,
  MonitoringStore,
} from "../monitoring/MonitoringStore";
import { DEFAULT_MONITOR_CATALOG } from "../monitoring/monitorCatalog";
import { MonitorEvaluation } from "../monitoring/MonitorEvaluation";
import type { MonitoredReading } from "../monitoring/evaluateMonitor";
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
import { renderConfigValue } from "./renderConfigValue";
import { OcmfMeter } from "../connector/SignedMeterData";
import {
  DEFAULT_ID_TAG,
  IdTagPool,
  type IdTagDistribution,
} from "../auth/IdTagPool";
import type { UrlDistribution } from "../transport/UrlDistribution";
import {
  assertWsClientOptions,
  type WsClientOptions,
} from "../../shared/WsClientOptions";
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

/** RFC 6455 Normal Closure, and No Status Received (a close without a code). */
const NORMAL_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1005]);
/**
 * #537: how long the reconnect that presents a renewed Charging Station
 * certificate waits for the transaction messages in flight (a
 * TransactionEvent awaiting its write or its answer, or one waiting to be
 * resent) to settle. The close would not lose them: the 2.x E11 queue
 * takes them and replays them, marked offline, after the next accepted
 * boot (#528). Waiting avoids marking offline, and resending, events the
 * CSMS was about to settle. Past this bound the station reconnects anyway
 * and the close queues what is still in flight.
 */
export const RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS = 60_000;
/** How often that wait checks again. */
const RENEWED_CERTIFICATE_RECONNECT_POLL_MS = 500;

export interface BasicAuthSettings {
  username: string;
  password: string;
}

export interface AutoMeterValueSetting {
  enabled: boolean;
  interval: number;
  value: number;
}

export interface StartTransactionOptions {
  triggerReason?: TransactionStartTriggerReason;
  remoteStartId?: number;
  /** OCPP 2.x Started-event chargingState (#335); `Charging` when absent. */
  chargingState?: TransactionChargingState;
  /** Target SoC of this session in percent (#327); the writer of
   *  `Transaction.targetSoc`. Absent: the connector's EV settings default. */
  targetSoc?: number;
  /** Stop the session when it reaches the target SoC (#327); absent: the
   *  connector's `stopAtTargetSoc` setting decides. */
  stopAtTarget?: boolean;
  /** OCPP 2.x `IdToken.type` of the transaction's Authorize and
   *  TransactionEvents (#599); `ISO14443` when absent. */
  idTokenType?: IdTokenTypeName;
  /** The `groupIdToken` of a RequestStartTransaction (F01.FR.21/22): the group
   *  the reservation check uses for this start, before what the station
   *  knows of the token. */
  groupIdToken?: string;
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

export interface StopTransactionOptions {
  triggerReason?: TransactionStopTriggerReason;
  /** OCPP 2.x Ended-event stoppedReason named explicitly (#335); when
   *  absent the encoder derives it from the 1.6 `reason`. */
  stoppedReason?: TransactionStoppedReason;
  /** The instant the transaction ended when it is not now: the power loss a
   *  recovery reports after the reboot (#455). */
  stoppedAt?: Date;
}

/** What survives a power loss (#455): the instant and the transactions that
 *  were running, the persisted state a recovery works from. */
export interface PowerLossRecord {
  at: Date;
  transactions: { connectorId: number; transactionId: number }[];
}

/**
 * How a restored station treats the transactions the power loss interrupted
 * (#455).
 * - `resume` keeps them running (1.6 leaves this to the implementation; 2.1
 *   E17.FR.10-14 requires it within `TxResumptionTimeout`).
 * - `end` reports them ended with reason `PowerLoss` (1.6 §7.36 StopTransaction
 *   reasons; 2.x E17.FR.20-21).
 */
export type PowerRecovery = "resume" | "end";

export interface PowerRestoreOptions {
  /** Default: `resume` on 1.x and 2.1, `end` on 2.0.1 (no `TxResumed`). */
  transactions?: PowerRecovery;
  /** OCPP 2.1 `TxCtrlr.TxResumptionTimeout` stand-in: a transaction resumes
   *  only when the outage lasted at most this many seconds. Absent or 0
   *  means the station does not resume (E17.FR.01, TC_E_114/115). */
  txResumptionTimeoutSeconds?: number;
}

/** `restoreAfterMs`: power returns by itself after this long (the outage
 *  duration); without it the station stays off until {@link ChargePoint.restorePower}. */
export interface PowerLossOptions extends PowerRestoreOptions {
  restoreAfterMs?: number;
}

export interface PowerRestoreResult {
  outageMs: number;
  recovery: PowerRecovery | "none";
  transactions: number;
}

/**
 * `powerLoss` while off, `powerRestore` while on, and a transaction, boot or
 * reset command while the station is without power (`powered_off`, #798).
 */
export class PowerStateError extends Error {
  constructor(
    readonly code:
      | "already_powered_off"
      | "not_powered_off"
      | "unsupported_transport"
      | "powered_off",
  ) {
    super(
      code === "already_powered_off"
        ? "The charge point is already without power"
        : code === "unsupported_transport"
          ? "Power loss is not simulated for OCPP-S (SOAP) charge points"
          : code === "powered_off"
            ? "The charge point is without power; restore it first"
            : "The charge point has power",
    );
  }
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

/**
 * What makes a run replayable (docs/concepts/charger-engine.md): the clock
 * every timer and timestamp of the charge point reads, and the seed its
 * random streams derive from. With neither, the platform clock and
 * `Math.random` are used and nothing differs from a charge point built
 * without this argument.
 */
export interface ChargePointSimulationOptions {
  readonly clock?: SimClock;
  /** A seed (a string or a number) or ready-made streams. */
  readonly seed?: string | number | RngSource;
}

export type ChargePointResetType = "Hard" | "Soft";
type ChargePointResetSource = "ocpp-call" | "ocpp15-soap";

/**
 * What an OCPP 1.6J charge point does with an inbound CALL whose payload
 * breaks the request schema (#593): `off` skips the check, `warn` logs it and
 * runs the handler anyway, `enforce` answers a CALLERROR (OCPP-J 1.6 §4.2.3).
 */
export type InboundValidationMode = "off" | "warn" | "enforce";
export const DEFAULT_INBOUND_VALIDATION: InboundValidationMode = "warn";

export interface ChargePointTransportOptions {
  /** What the charger hardware delivers per connector (#327). Absent:
   *  no connector is capped. */
  readonly chargerCapabilities?: ChargerCapabilities;
  /** Static capability profile (#618). Absent: nothing is disabled. */
  readonly capabilityProfile?: ChargePointCapabilityProfile;
  /** OCPP 1.6J only. Default `warn`. */
  readonly inboundValidation?: InboundValidationMode;
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
  /**
   * #609: reconnect policy and BootNotification retry limit. Omitted fields
   * keep {@link DEFAULT_RECONNECT_POLICY}, which is the behaviour before the
   * policy was configurable. OCPP-J only for the reconnect part; the boot
   * retry limit applies to every transport.
   */
  readonly reconnect?: Partial<ReconnectPolicy>;
  /**
   * #611: WebSocket client options (handshake timeout, compression, max
   * payload, proxy, local address). OCPP-J only. The constructor throws
   * `UnsupportedWsOptionError` for an option this runtime would ignore.
   */
  readonly ws?: WsClientOptions;
  /** Resolved idTags this charge point draws from (#299). */
  readonly idTags?: readonly string[];
  readonly idTagDistribution?: IdTagDistribution;
  /**
   * OCPP 1.6 ReserveNow: authorize the reservation's idTag (local rules, then
   * Authorize.req) before accepting; a tag that is not `Accepted` answers
   * `Rejected` (#595). Default `false`.
   */
  readonly reservationAuthorizeIdTag?: boolean;
}

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
  /** #609: automatic BootNotification re-sends since the last Accepted. */
  private _bootRetries = 0;
  /** A boot give-up waiting for its `bootNotificationResult` to be emitted. */
  private _bootGaveUp: number | null = null;

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
  /** #393: level C expert sends; null on SOAP. */
  private readonly _rawFrames: RawFrameSink | null;
  /** #389: null on SOAP. */
  private readonly _callCatalog: OcppCallActions | null;
  /** SOAP dialect dispatch check; see {@link ChargePointTransport.receivesCsmsCall}. */
  private readonly _receivesCsmsCall: ChargePointTransport["receivesCsmsCall"];
  private readonly _messageHandler: IChargePointMessageHandler;
  private readonly _transportUrl: string;
  /** #537: waits for the transaction messages in flight before reconnecting
   *  with a renewed certificate (A02.FR.08). */
  private _cancelClientCertificateSwitchTimer: (() => void) | null = null;
  /** #537: bumped by every switch request and every cancel, so a request
   *  still reading the store when a newer one (or a cancel) arrives does
   *  nothing once it resumes. */
  private _clientCertificateSwitchSeq = 0;
  /** #537: set by {@link releaseRenewedClientCertificate} (and dispose):
   *  no switch is started any more. */
  private _clientCertificateSwitchReleased = false;
  /** #537: stops following the certificate store (dispose). */
  private _unwatchClientIdentity: (() => void) | null = null;
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
  private readonly _periodicSamplers: Map<number, TimerHandle> = new Map();
  /** Applies each connector's vehicle behavior to the station (#835). */
  private _powerSharing: PowerSharingConfig | undefined;
  private readonly _vehicleDrivers: Map<number, VehicleBehaviorDriver> =
    new Map();
  /** #702: the next socket open is a (re)start of the link — the first
   *  connect, an operator `connect()`, a Reset — and sends a
   *  BootNotification. Only the transport's automatic reconnect after a
   *  connection loss finds it false. */
  private _bootOnNextOpen = true;
  /** #702: a BootNotification was sent and not answered yet; a close in
   *  between loses it, so the next open sends one again. */
  private _bootUnanswered = false;
  /** #702: the BootNotification payload last sent, as JSON. */
  private _bootSentFingerprint: string | null = null;
  /** #702: the payload of the last BootNotification the CSMS Accepted; null
   *  while the last one was Pending or Rejected, or none was sent. */
  private _bootedWith: string | null = null;
  /** #702: when the current outage began (first teardown of it). */
  private _offlineSince: number | null = null;
  /** #702: the statuses (0 = the charge point) the station had when the
   *  outage began, before the teardown made them Unavailable. */
  private _statusAtDrop: Map<number, OCPPStatus> = new Map();
  /** #702: the connectors whose Unavailable was made by the teardown
   *  cascade (not by an availability change), with the status they had. */
  private _cascadedAtDrop: Map<number, OCPPStatus> = new Map();
  /** #702: the reservations held when the outage began; a resumed link gets
   *  them back (a reboot does not). */
  private _reservationsAtDrop: Reservation[] = [];
  /** #799: the station-level charging profiles held when the outage began.
   *  The teardown empties the store; a resumed link (no BootNotification, so
   *  the CSMS has no cue to push its limits again) gets them back. */
  private _stationProfilesAtDrop: ActiveChargingProfile[] = [];
  /** #702: the status the CSMS last *answered* for each connector (0 = the
   *  charge point). A StatusNotification still in flight when the link closed
   *  is not in it, so a resume sends that one again (B04.FR.02). */
  private _ackedStatus: Map<number, OCPPStatus> = new Map();
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
  private _pendingResetsOnIdle: { evseId?: number }[] = [];
  /** Reason of the next BootNotification (2.x B01.FR.09); see {@link boot}. */
  private _bootReason: BootReason = "PowerUp";
  /** #455: set while the station is without power. */
  private _powerLoss: PowerLossRecord | null = null;
  /** #455: the recovery to run once the next BootNotification is Accepted. */
  private _powerRestoreTimer: TimerHandle | null = null;
  private _powerRecovery: {
    loss: PowerLossRecord;
    options: PowerRestoreOptions;
    restoredAt: Date;
  } | null = null;
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
  /** #347: see {@link sendScheduledMeterValue}. Off by default. */
  private _txUpdatedMeterValues = false;
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
  private readonly _connectionTimeoutTimers: Map<number, TimerHandle> =
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
    private readonly _bootNotification: BootNotification,
    connectorCount: number,
    wsUrl: string,
    basicAuthSettings: BasicAuthSettings | null,
    autoMeterValueSetting: AutoMeterValueSetting | null,
    /** SQLite-backed persistence for PendingMessageQueue and CertificateStore
     *  (the other stores go through `deps.repositories`, #878). `null` keeps
     *  them in-memory — used by the daemon's `:memory:` mode and by tests. */
    private readonly _database: Database | null = null,
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
    this._certificateStore = new CertificateStore(
      this._id,
      this._database,
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

    for (let connectorId = 1; connectorId <= connectorCount; connectorId++) {
      const connector = new Connector(
        connectorId,
        this._logger,
        () => this._stationProfiles,
        this._clock,
      );
      connector.setMaxDeliveryPowerW(
        maxDeliveryPowerWFor(transportOptions.chargerCapabilities, connectorId),
      );
      connector.setMeterRealism(
        meterRealismFor(transportOptions.chargerCapabilities, connectorId),
      );
      connector.setDcEfficiency(
        dcEfficiencyFor(transportOptions.chargerCapabilities, connectorId),
      );
      // §5.2: Unavailable set via ChangeAvailability persists across
      // reboots. Restore the persisted value before any event listeners
      // have a chance to react.
      this._engine.attachConnector(connector);
      const persisted = this.loadAvailability(connectorId);
      if (persisted) {
        this.writeConnector(connectorId, {
          kind: "availability",
          availability: persisted,
        });
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
        if (this._powerLoss) return;
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
        } else if (
          !paused &&
          connector.status === OCPPStatus.SuspendedEVSE &&
          !connector.energyHeld
        ) {
          this._logger.info(
            `Connector ${connectorId} schedule period limit=${watts}W, resuming → Charging`,
            LogType.OCPP,
          );
          this.updateConnectorStatus(connectorId, OCPPStatus.Charging);
        }
      });
      // #722: MeterValueSampleInterval drives the periodic MeterValues of a
      // 1.x transaction; the interval is read when the transaction starts.
      connector.events.on("transactionChange", ({ transaction }) => {
        if (transaction && connector.hasRunningTransaction) {
          this.startPeriodicSampling(connector);
        } else this.stopPeriodicSampling(connectorId);
      });
      // A transaction restored after a daemon restart is running again and
      // gets its sampler back (the restore itself emits no transactionChange).
      connector.events.on("transactionRestored", () =>
        this.startPeriodicSampling(connector),
      );
      // The MaxEnergyOnInvalidId allowance ran out (E05.FR.03 → .02).
      connector.events.on("invalidIdEnergyExhausted", () => {
        this.reportEnergyHeld(connector);
      });
      this._connectors.set(connectorId, connector);
      this._vehicleDrivers.set(
        connectorId,
        new VehicleBehaviorDriver(
          connector,
          this._clock,
          {
            setReady: (id, ready) => {
              if (this._powerLoss) return;
              if (this.getConnector(id)?.evConnection === "disconnected") {
                return;
              }
              this.evSetReady(id, ready);
            },
            requestStop: (id) => {
              if (this._powerLoss) return;
              this._logger.info(
                `Connector ${id} vehicle asked to end the session`,
                LogType.TRANSACTION,
              );
              this.stopTransaction(connector, undefined, {
                triggerReason: "EnergyLimitReached",
              });
            },
          },
          connectorId,
        ),
      );
    }

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
        this.onReservationExpired(connectorId, reservation),
      this._clock,
    );
    this._localAuthListManager = new LocalAuthListManager(this._logger);
    // #452: the policy is read on every decision, so ChangeConfiguration
    // applies at once. `_configuration` is assigned further down; nothing
    // reads the policy before the constructor returns.
    this._authorization = new StationAuthorization({
      cache: new AuthorizationCache(
        this._id,
        this._repositories.authorizationCache,
        {
          clock: this._clock,
        },
      ),
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
    this.wireConfigurationListeners();
    this.wirePowerSharing(transportOptions.chargerCapabilities?.powerSharing);
    if (!isOcpp2Version(this._ocppVersion) && this._webSocket) {
      this.wireSecurityConfiguration();
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
      this.wireVariableMonitoring();
      this.wireCertificateEntries();
      this.wireRenewedClientIdentity();
    }
    // A persisted override never fires onChange; the scheduler only runs
    // once a boot is Accepted (#454).
    this._clockAligned.setIntervalSeconds(
      this._configuration.clockAlignedDataInterval(),
    );
    if (isOcpp2Version(this._ocppVersion)) {
      this.applyRetryBackOff();
      this._txEndedAligned.setIntervalSeconds(
        this._configuration.alignedDataTxEndedInterval(),
      );
    }
    // A value persisted with --state-db is in force from the first open.
    this._webSocket?.setPingInterval(
      this._configuration.webSocketPingInterval(),
    );
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

  /** Exposed so OCPPMessageHandler (PendingMessageQueue) can share the
   *  same Database instance. `null` means the CP is running in-memory. */
  get database(): Database | null {
    return this._database;
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
   * OCPP 2.x variable monitoring (#457): restore the persisted monitors
   * (N07.FR.13), keep the table in step with the store, and evaluate the
   * monitors whenever SetVariables or a scenario `configSet` node changes
   * the value they watch (N07). Events go out after the answer that caused
   * them, and only while the boot is Accepted (B02.FR.02): reporting starts
   * off and `applyBootAccepted` turns it on.
   */
  private wireVariableMonitoring(): void {
    const repository = this._repositories.variableMonitors;
    const persisted = repository.load();
    const storedBase = repository.loadActiveBase();
    // #538: the hardwired monitors, the persisted ones, and on a station
    // that never stored its catalog state, the preconfigured ones. The
    // station's own monitors are stored too, so they keep their triggered
    // flag (N07.FR.14) and a later start knows which were deleted.
    const { dropped, added } = this._monitoring.initialize(
      persisted.map((p) => p.monitor),
      storedBase,
    );
    // A hardwired row the catalog no longer has was ignored: drop it, so a
    // later monitor under its id does not inherit its triggered flag.
    for (const monitor of dropped) repository.delete(monitor.id);
    for (const monitor of added) repository.save(monitor);
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
        // Sent after the answer to the message that caused them. A
        // disposal in between (cp.delete, the instance a cp.update
        // replaces) drops them: queued now, they would be a row for a
        // charge point that is gone (#538).
        emit: (events) =>
          queueMicrotask(() => {
            if (!evaluation.disposed) this._outbox.sendNotifyEvent(events);
          }),
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
        // The reports a previous run queued keep their eventIds (#538).
        lastQueuedEventId: () => this._outbox.highestQueuedNotifyEventId(),
        clock: this._clock,
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
    this._events.on("statusChange", () => this.publishStationAvailability());
    this._events.on("connectorRemoved", ({ connectorId }) =>
      this.withdrawConnectorValues(connectorId),
    );
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

  /**
   * A removed connector's EVSE leaves the device model (#538): its runtime
   * keys and its `EVSE.Power` target go. A monitor on them stays installed
   * and reads no value, so it reports nothing, periodic ticks included.
   */
  private withdrawConnectorValues(connectorId: number): void {
    const keys = RUNTIME_VALUE_KEYS;
    for (const prefix of [
      keys.evsePower,
      keys.evseState,
      keys.connectorState,
    ]) {
      this._configuration.removeRuntimeKey(evseValueKey(prefix, connectorId));
    }
    this._deviceModelTargets.undeclare(
      evseValueKey(keys.evsePower, connectorId),
    );
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

  /**
   * #537: 2.x `SecurityCtrlr.CertificateEntries` is the number of installed
   * trust anchors, the set M05.FR.06 limits. The certificate store stays
   * the source; the configuration value follows it, so GetVariables,
   * GetBaseReport and variable monitors read it like any other variable,
   * and a change fires the configuration listeners monitors evaluate on.
   */
  private wireCertificateEntries(): void {
    const sync = (): void => {
      this._configuration.setRuntimeValue(
        "CertificateEntries",
        this._certificateStore.listRootCertificates().length,
      );
    };
    sync();
    this._certificateStore.onChange(sync);
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
    const webSocket = this._webSocket;
    if (!webSocket?.usesClientCertificate()) return;
    this._unwatchClientIdentity = this._certificateStore.onChange(() => {
      if (!this._certificateStore.hasTlsClientIdentity()) {
        webSocket.clearRenewedClientCertificate();
      }
    });
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

  /**
   * #724 (1.6 security whitepaper A01, A05): the transport sends the
   * stored `AuthorizationKey` and `SecurityProfile` from the next attempt
   * on, and a `SecurityProfile` change is checked against the A05
   * prerequisites. Installed after the constructor applied its own initial
   * values, which are not ChangeConfiguration requests.
   */
  private wireSecurityConfiguration(): void {
    // §7.2: with profile 1 or 2 the key is the Basic Auth password; one the
    // transport cannot derive it from (an empty value or one of another length) would stop
    // every later connection attempt, so it is refused and the old key kept.
    this._configuration.setChangeGuard("AuthorizationKey", (_current, next) => {
      const profile = this._configuration.getInteger("SecurityProfile") ?? 0;
      if (
        (profile !== 1 && profile !== 2) ||
        isValidAuthorizationKey(`${next}`)
      ) {
        return true;
      }
      this._logger.warn(
        `ChangeConfiguration AuthorizationKey refused: security profile ${profile} needs a key of 16-20 bytes (32-40 hex digits, or 16-20 plain characters), whitepaper §7.2`,
        LogType.CONFIGURATION,
      );
      return false;
    });
    this._configuration.setChangeGuard("SecurityProfile", (current, next) => {
      const now = this.nowDate();
      const verdict = checkSecurityProfileChange({
        current: typeof current === "number" ? current : 0,
        next: typeof next === "number" ? next : 0,
        authorizationKey:
          this._configuration.getString("AuthorizationKey") ?? "",
        // Only what the TLS connection validates the CSMS with: roots that
        // InstallCertificate stored do not join its trust, so counting them
        // would accept an upgrade that cannot connect.
        hasCentralSystemRoot:
          this._webSocket?.hasConfiguredTrustAnchors() ?? false,
        hasChargePointCertificate:
          this._certificateStore
            .listSignedChains("ChargingStationCertificate")
            .some((chain) => isCertificateCurrentlyValid(chain.pems[0], now)) ||
          (this._webSocket?.hasClientCertificate() ?? false),
      });
      if (!verdict.allowed) {
        this._logger.warn(
          `ChangeConfiguration SecurityProfile=${next} refused (${verdict.requirement}): ${verdict.reason}`,
          LogType.CONFIGURATION,
        );
      }
      return verdict.allowed;
    });
    this._configuration.onChange((key, value) => {
      if (key === "AuthorizationKey" && typeof value === "string") {
        this._webSocket?.setSecurityCredentials({ authorizationKey: value });
      } else if (key === "SecurityProfile" && typeof value === "number") {
        this._webSocket?.setSecurityCredentials({
          securityProfile: value as OcppSecurityProfile,
        });
      }
    });
  }

  /**
   * #724 A05.FR.06-08: after the CALLRESULT of an accepted `SecurityProfile`
   * upgrade the station disconnects and reconnects with the new profile.
   * When that connection does not open, the previous profile is put back
   * and used for the next attempt (A05.FR.08).
   */
  switchSecurityProfile(previousProfile: number): void {
    this._webSocket?.armSecurityProfileFallback(() => {
      this._logger.warn(
        `Could not connect with security profile ${this._configuration.getInteger("SecurityProfile")}; falling back to profile ${previousProfile} (A05.FR.08)`,
        LogType.CONFIGURATION,
      );
      this._configuration.applyChange(
        "SecurityProfile",
        String(previousProfile),
        { bypassGuard: true },
      );
    });
    this._logger.info(
      "SecurityProfile changed: reconnecting with the new profile (A05.FR.06/07)",
      LogType.CONFIGURATION,
    );
    this.reset();
  }

  /**
   * Let the connectors share the station's power budget (#608). The share is
   * read at every operating point resolve from the connectors' transactions
   * at that instant, so a transaction that starts or stops moves it with no
   * bookkeeping. A declared current limit key becomes a writable configuration
   * key; it is read here at resolve time too, so `ChangeConfiguration`
   * changes the budget at once.
   */
  private wirePowerSharing(config: PowerSharingConfig | undefined): void {
    if (!config) return;
    this._powerSharing = config;
    const limit = config.currentLimit;
    if (limit) {
      const declared = this._configuration.defineWritableIntegerKey(
        limit.key,
        Math.round(limit.valueA),
        { min: 1 },
      );
      if (!declared) {
        this._logger.warn(
          `powerSharing.currentLimit.key ${limit.key} is already a configuration key; the declared limit is ignored`,
          LogType.CONFIGURATION,
        );
      }
    }
    const strategy = config.strategy ?? "equal";
    for (const [connectorId, connector] of this._connectors) {
      connector.setStationShareProvider(() => {
        const participants: ShareParticipant[] = [];
        for (const [id, c] of this._connectors) {
          participants.push({
            connectorId: id,
            capW: c.maxDeliveryPowerW ?? Infinity,
            active: c.hasRunningTransaction,
          });
        }
        return connectorShareW(
          this.stationPowerBudgetW(),
          strategy,
          participants,
          connectorId,
        );
      });
    }
  }

  /** The station's power budget in watts now, `Infinity` without sharing. */
  stationPowerBudgetW(): number {
    const limit = this._powerSharing?.currentLimit;
    return stationBudgetW(
      this._powerSharing,
      limit ? this._configuration.getInteger(limit.key) : undefined,
    );
  }

  /** Hook up subsystems that react to live Configuration changes. */
  /** #609: hand the 2.x `RetryBackOff*` variables to the transport. */
  private applyRetryBackOff(): void {
    this._webSocket?.setRetryBackOff({
      waitMinimumSeconds: this._configuration.retryBackOffWaitMinimum(),
      randomRangeSeconds: this._configuration.retryBackOffRandomRange(),
      repeatTimes: this._configuration.retryBackOffRepeatTimes(),
    });
  }

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
          // §3.16.1 / §9.1.19 ask for a sample "every MeterValueSampleInterval
          // seconds" and, at 0, for none: the samplers of the running
          // transactions are re-armed with the new value (#839, #722). 2.x
          // does not run them.
          this._logger.info(
            `MeterValueSampleInterval=${String(value)}`,
            LogType.CONFIGURATION,
          );
          this.rearmPeriodicSampling();
          break;
        case "WebSocketPingInterval":
          // #406: re-arms the ping timer at once on an open socket.
          if (typeof value === "number") {
            this._webSocket?.setPingInterval(value);
          }
          break;
        case "RetryBackOffWaitMinimum":
        case "RetryBackOffRandomRange":
        case "RetryBackOffRepeatTimes":
          // #609: applies from the next reconnect attempt.
          this.applyRetryBackOff();
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
        case "AlignedDataTxEndedInterval":
          // #607: the grid of the 2.x transaction-end history.
          if (typeof value === "number") {
            this._txEndedAligned.setIntervalSeconds(value);
          }
          break;
        default:
          break;
      }
    });
  }

  /**
   * #347: whether the meter-value scheduler's samples taken during an OCPP
   * 2.x transaction ride TransactionEvent(Updated, MeterValuePeriodic)
   * instead of MeterValues. Off by default; ignored on 1.x.
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
   * A reservation lapsed (its expiry timer, or the ReservationManager sweep)
   * without an explicit CancelReservation. OCPP 2.x first reports it
   * (H04.FR.01, ReservationStatusUpdate `Expired`), then mirrors the cancel
   * path (H04.FR.03, OCPP 1.6 §5.13): drive the connector back to Available
   * through updateConnectorStatus so the CSMS sees the transition on the wire,
   * but only when it's still Reserved: a connector that moved to
   * Charging/Preparing/etc. in the meantime must not be clobbered.
   */
  private onReservationExpired(
    connectorId: number,
    reservation: Reservation,
  ): void {
    if (isOcpp2Version(this._ocppVersion)) {
      this._outbox.sendReservationStatusUpdate(
        reservation.reservationId,
        "Expired",
      );
    }
    const connector = this.getConnector(connectorId);
    if (connector && connector.status === OCPPStatus.Reserved) {
      this.updateConnectorStatus(connectorId, this.statusWhenFree(connectorId));
    }
    syncUnspecifiedReservations(this);
  }

  /**
   * OCPP 1.6 §5.13 ("a reservation SHALL be terminated ... when the Charge
   * Point or connector are set to Faulted or Unavailable") and 2.0.1
   * H01.FR.16/17: a connector (or, for connector 0, the whole station) that
   * became Faulted or Unavailable ends the reservations it held. OCPP 2.x
   * reports each as ReservationStatusUpdate `Removed`. The connector keeps
   * the status it just took.
   */
  private terminateReservationsOf(connectorId: number): void {
    const terminated = this._reservationManager.terminateReservations(
      connectorId === 0 ? "all" : { connectorId },
    );
    if (!isOcpp2Version(this._ocppVersion)) return;
    for (const reservation of terminated) {
      this._outbox.sendReservationStatusUpdate(
        reservation.reservationId,
        "Removed",
      );
    }
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
   * connector, replacing any profile with the same id in that scope (and,
   * with `options.replaceSameSlot`, the one with the same stackLevel and
   * purpose), and
   * emit `chargingProfileApplied`. Validation is the caller's job.
   *
   * @returns `false`, changing nothing, when the connector does not exist.
   */
  applyChargingProfile(
    profile: ActiveChargingProfile,
    source: ChargingProfileSource,
    options: ApplyChargingProfileOptions = {},
  ): boolean {
    const idsBefore = (list: readonly ActiveChargingProfile[]) =>
      list.map((p) => p.chargingProfileId);
    let before: number[];
    let after: number[];
    if (profile.connectorId === 0) {
      before = idsBefore(this._stationProfiles.all());
      this._stationProfiles.add(profile, options);
      after = idsBefore(this._stationProfiles.all());
    } else {
      const connector = this.getConnector(profile.connectorId);
      if (!connector) return false;
      before = idsBefore(connector.chargingProfiles);
      connector.addChargingProfile(profile, options);
      after = idsBefore(connector.chargingProfiles);
    }
    const replaced = before.includes(profile.chargingProfileId);
    // Other profiles the same-slot rule displaced (#594).
    const replacedIds = before.filter(
      (id) => id !== profile.chargingProfileId && !after.includes(id),
    );
    this._events.emit("chargingProfileApplied", {
      connectorId: profile.connectorId,
      profile,
      replaced,
      replacedIds,
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
    now: Date = this._nowDate(),
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
   *  was false at delivery time. See _lastDefaultHandledRemoteStart. */
  noteDefaultHandledRemoteStart(connectorId: number): void {
    this._lastDefaultHandledRemoteStart.set(connectorId, this._clock.now());
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
    this._lastDefaultHandledRemoteStop.set(connectorId, this._clock.now());
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

  /**
   * `StopTransactionOnInvalidId=false` and the id was not accepted: keep the
   * transaction but stop the energy delivery (2.0.1
   * E05.FR.02/03, C15.FR.06; 2.x only, 1.6 errata 3.17 is #736). With `MaxEnergyOnInvalidId` > 0 that much energy
   * is delivered first; the connector reports SuspendedEVSE either way once
   * the delivery has stopped.
   */
  holdEnergyOnInvalidId(connector: Connector): void {
    const allowance = this._configuration.maxEnergyOnInvalidId();
    if (connector.holdEnergyForInvalidId(allowance)) {
      this.reportEnergyHeld(connector);
    }
  }

  private reportEnergyHeld(connector: Connector): void {
    if (!connector.hasRunningTransaction) return;
    if (
      connector.status === OCPPStatus.Charging ||
      connector.status === OCPPStatus.Preparing ||
      connector.status === OCPPStatus.SuspendedEV
    ) {
      this._logger.info(
        `Connector ${connector.id} energy delivery stopped after a non-Accepted id → SuspendedEVSE`,
        LogType.TRANSACTION,
      );
      this.updateConnectorStatus(connector.id, OCPPStatus.SuspendedEVSE);
    }
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
   * (#762), and lasts at least `MessageTimeout`. `failClosed` (F01.FR.01: energy
   * transfer only after authorization was obtained) makes an unanswered
   * Authorize resolve "Unknown" instead of warn-and-proceed "Accepted".
   */
  authorizeAndWait(
    tagId: string,
    timeoutMs = 10000,
    idTokenType?: IdTokenTypeName,
    options: { failClosed?: boolean } = {},
  ): Promise<string> {
    const decision = this._authorization.decide(tagId, this.isOnline());
    if (decision.kind !== "askCsms") {
      return Promise.resolve(this.localAuthorizationStatus(tagId, decision));
    }

    const queued = isOcpp2Version(this.ocppVersion);
    let armTimeout: () => void = () => undefined;
    let onNotSent: () => void = () => undefined;
    const result = new Promise<string>((resolve) => {
      let settled = false;
      let timeoutId: TimerHandle | null = null;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timeoutId) this._clock.clearTimeout(timeoutId);
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

      const waitMs = queued
        ? Math.max(timeoutMs, this.configuration.messageTimeout() * 1000)
        : timeoutMs;
      armTimeout = () => {
        if (settled || timeoutId) return;
        timeoutId = this._clock.setTimeout(onTimeout, waitMs);
      };

      const onTimeout = () => {
        cleanup();
        if (!this.isOnline()) {
          decideOffline(`Timeout (${waitMs}ms) and offline`);
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
        if (options.failClosed) {
          this._logger.warn(
            `Timeout (${waitMs}ms) awaiting Authorize.conf for ${tagId}; not authorized (F01.FR.01)`,
            LogType.TRANSACTION,
          );
          resolve("Unknown");
          return;
        }
        this._logger.warn(
          `Timeout (${waitMs}ms) awaiting Authorize.conf for ${tagId}; proceeding as Accepted`,
          LogType.TRANSACTION,
        );
        resolve("Accepted");
      };

      // Never written (not connected, dropped, socket closed): offline the
      // offline rules decide at once, otherwise the timeout decides, as for
      // an unanswered CALL.
      onNotSent = () => {
        if (settled) return;
        if (!this.isOnline()) {
          cleanup();
          decideOffline("Authorize not sent");
          return;
        }
        armTimeout();
      };

      // The listeners and timer are set before the CALL goes out, so a
      // synchronous write arms the timer.
      if (queued) {
        this.authorize(tagId, idTokenType, {
          onWritten: () => armTimeout(),
          onDropped: () => onNotSent(),
        });
      } else {
        if (idTokenType === undefined) this.authorize(tagId);
        else this.authorize(tagId, idTokenType);
        armTimeout();
      }
    });

    return result;
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
    if (this._powerLoss) {
      this._logger.warn(
        "connect() ignored: the charge point has no power (power.restore first)",
        LogType.WEBSOCKET,
      );
      return;
    }
    if (!this._webSocket) {
      this._logger.info(
        `Connecting via ${this._ocppVersion} SOAP client`,
        LogType.OCPP,
      );
      this._bootRetries = 0;
      this.boot();
      this._events.emit("connected", undefined);
      this._engine.observe({ type: "connected" });
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
    this._bootOnNextOpen = true;
    this._webSocket.connect(
      () => {
        // A new connection starts a fresh BootNotification budget (#609).
        this._bootRetries = 0;
        const resumed = this.onSocketOpen();
        this._events.emit("connected", undefined);
        if (resumed) this._events.emit("reconnectResumed", resumed);
        this._engine.observe({ type: "connected" });
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
        this._engine.observe({
          type: "disconnected",
          code: ev.code,
          reason: ev.reason,
        });
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
    const catalog = this._callCatalog;
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

  /**
   * Expert raw frame (#393, level C of #389): one text frame written to the
   * WebSocket as given, valid OCPP-J or not, outside the 1.6 serial CALL
   * queue. Replies are correlated best effort and kept from the station's
   * handlers. See {@link RawFrameSink}.
   */
  sendRawFrame(request: RawFrameRequest): Promise<RawFrameOutcome> {
    if (!this._rawFrames) {
      return Promise.reject(
        new OcppCallRejectedError(
          "unsupported_transport",
          `Raw frames need an OCPP-J station; ${this._ocppVersion} is SOAP`,
        ),
      );
    }
    return this._rawFrames.send(request);
  }

  /**
   * 2.0.1 / 2.1 Get15118EVCertificate relay (M01 / M02, #537): sends the EXI
   * request the caller supplies, standing in for an EV, and resolves with
   * the CSMS's answers. See {@link relayGet15118EVCertificate}. Each request
   * goes through {@link sendOcppCall}, so it is refused before anything is
   * written on 1.6 and SOAP stations, which have no such message, and when
   * the payload fails the version's schema (a 2.1-only field or an
   * over-long `exiRequest` on 2.0.1).
   */
  async get15118EVCertificate(
    request: Get15118EVCertificateRequest,
  ): Promise<Get15118EVCertificateResult> {
    return relayGet15118EVCertificate(
      request,
      (payload) =>
        this.sendOcppCall({ action: "Get15118EVCertificate", payload }),
      {
        warn: (message) => this._logger.warn(message, LogType.OCPP),
        clock: this._clock,
      },
    );
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
    await this.switchClientCertificate(true);
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
    await this.switchClientCertificate(false);
  }

  private async switchClientCertificate(reconnect: boolean): Promise<void> {
    if (this._clientCertificateSwitchReleased) return;
    this.cancelClientCertificateSwitch();
    const request = this._clientCertificateSwitchSeq;
    const webSocket = this._webSocket;
    if (!webSocket?.usesClientCertificate()) return;
    const identity = await this._certificateStore.tlsClientIdentity();
    // Superseded by a newer request, or cancelled (dispose, cp.update),
    // while the store was read: that one decides, this one does nothing.
    if (request !== this._clientCertificateSwitchSeq) return;
    if (!identity) {
      webSocket.clearRenewedClientCertificate();
      return;
    }
    // No wait for `notBefore` (A02.FR.08): CertificateSigned refuses a leaf
    // that is not valid yet (A02.FR.06/07, #587), so a stored identity is
    // valid when it is handed over.
    webSocket.useRenewedClientCertificate(identity);
    if (!reconnect) return;
    // A station that is not connected (back-off, simulated outage, manual
    // disconnect) presents it at its next connection, on that one's timing.
    if (!webSocket.isOpenOrConnecting()) {
      this._logger.info(
        "Renewed Charging Station certificate presented at the next connection (A02.FR.08)",
        LogType.WEBSOCKET,
      );
      return;
    }
    this.reconnectWithRenewedCertificate(
      webSocket.currentGeneration(),
      this._clock.now() + RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS,
      identity.cert,
    );
  }

  /** Reconnects once no transaction message awaits its write, an answer
   *  or a resend, or at `deadline`. A connection that closed meanwhile is
   *  not reconnected: the next one presents the renewed certificate. */
  private reconnectWithRenewedCertificate(
    generation: GenerationToken,
    deadline: number,
    cert: string,
  ): void {
    this._cancelClientCertificateSwitchTimer = null;
    const webSocket = this._webSocket;
    if (!webSocket?.isOpenOrConnecting()) return;
    if (webSocket.currentGeneration() !== generation) return;
    // Opened with it meanwhile (#564): nothing to switch.
    if (webSocket.presentsClientCertificate(cert)) return;
    if (
      this._outbox.hasTransactionMessagesInFlight() &&
      this._clock.now() < deadline
    ) {
      this._cancelClientCertificateSwitchTimer = setTimeoutAt(
        Math.min(
          this._clock.now() + RENEWED_CERTIFICATE_RECONNECT_POLL_MS,
          deadline,
        ),
        () => this.reconnectWithRenewedCertificate(generation, deadline, cert),
        { clock: this._clock },
      );
      return;
    }
    this._logger.info(
      "Reconnecting with the renewed Charging Station certificate (A02.FR.08)",
      LogType.WEBSOCKET,
    );
    this.reset();
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
    this._clientCertificateSwitchReleased = true;
    this.cancelClientCertificateSwitch();
    this._unwatchClientIdentity?.();
    this._unwatchClientIdentity = null;
    this._webSocket?.clearRenewedClientCertificate();
    this._certificateStore.forgetPrivateKeys();
  }

  private cancelClientCertificateSwitch(): void {
    this._clientCertificateSwitchSeq++;
    this._cancelClientCertificateSwitchTimer?.();
    this._cancelClientCertificateSwitchTimer = null;
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

  /** Send FirmwareStatusNotification.req — see OCPPMessageHandler doc. */
  sendFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    this._outbox.sendFirmwareStatusNotification(status, requestId);
  }

  /** Send LogStatusNotification.req — see OCPPMessageHandler doc. */
  sendLogStatusNotification(status: UploadLogStatus, requestId?: number): void {
    this._logStatusSeq++;
    this._lastLogStatusRequestId = requestId ?? this._lastLogRequestId;
    this._outbox.sendLogStatusNotification(status, requestId);
  }

  /** Counts every LogStatusNotification this station sent, so the automatic
   *  GetLog lifecycle can tell that something else (the control plane, a
   *  scenario `notify` node) is driving the status train of its request
   *  (N01.FR.09: one final status per requestId). */
  private _logStatusSeq = 0;
  private _lastLogStatusRequestId: number | undefined;
  get logStatusSeq(): number {
    return this._logStatusSeq;
  }
  get lastLogStatusRequestId(): number | undefined {
    return this._lastLogStatusRequestId;
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

  /** #734: the device has (re)started and has not reported it yet. */
  private _startupEventPending = true;
  /** The CSMS answered a StatusNotification for `connectorId` (0 = the charge
   *  point) with `status` (#702). */
  noteStatusAcknowledged(connectorId: number, status: OCPPStatus): void {
    this._ackedStatus.set(connectorId, status);
  }

  /** Boot-notification gate accessors used by BootNotificationResultHandler. */
  markBootAccepted(): void {
    this._bootReason = "PowerUp";
    this._bootAccepted = true;
    this._outbox.setBootStatus({ status: "Accepted" });
    if (this._ocppVersion === "OCPP-1.6J") {
      // #734 A04.FR.02: events raised while the station could not send them
      // (ResetOrReboot among them) go out first, with their own timestamps.
      this._outbox.flushQueuedSecurityEvents();
      // StartupOfTheDevice reports a start of the device: once per process
      // start, per reset and per power restore, not per reconnect or
      // triggered boot. It is
      // consumed by the first Accepted boot either way, so a later change of
      // the security profile does not report a startup that already passed.
      if (this._startupEventPending) {
        this._startupEventPending = false;
        if ((this._configuration.getInteger("SecurityProfile") ?? 0) >= 1) {
          void this._outbox.sendSecurityEventNotification("StartupOfTheDevice");
        }
      }
    }
    // §4.7/§4.8/§4.10 + errata 3.18: flush queued transaction-related
    // messages now that the boot gate is open. Run via queueMicrotask so
    // any post-boot StatusNotification fan-out goes first.
    queueMicrotask(() => this._outbox.flushPendingQueue());
    // After the post-boot status fan-out, and with the gate already open.
    queueMicrotask(() => this.engine.bootAccepted());
  }

  /** §4.2: run `fn` as the answer to an accepted TriggerMessage. */
  runTriggered<T>(fn: () => T): T {
    return this._outbox.runTriggered(fn);
  }

  markBootPending(): void {
    this._bootAccepted = false;
    this._outbox.setBootStatus({ status: "Pending" });
  }

  markBootRejected(retryAfterSeconds: number): void {
    this._bootAccepted = false;
    this._outbox.setBootStatus({
      status: "Rejected",
      retryAfter: new Date(this._clock.now() + retryAfterSeconds * 1000),
    });
    // #609: `bootRetryLimit` caps the automatic re-sends (-1: no cap).
    const limit = this._reconnectPolicy.bootRetryLimit;
    if (limit >= 0 && this._bootRetries >= limit) {
      this._logger.warn(
        `Giving up BootNotification after ${this._bootRetries} retr${this._bootRetries === 1 ? "y" : "ies"} (reconnect.bootRetryLimit=${limit})`,
        LogType.OCPP,
      );
      // Reported once `bootNotificationResult` (Rejected), its cause, is out.
      this._bootGaveUp = this._bootRetries;
      return;
    }
    this._bootRetries++;
    // Re-send BootNotification.req once the interval elapses (§4.2).
    this._clock.setTimeout(() => {
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
    this._bootUnanswered = false;
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
        this._bootRetries = 0;
        this._logger.info("Boot notification accepted", LogType.OCPP);
        this._bootedWith = this._bootSentFingerprint;
        this.clearOutage();
        this.markBootAccepted();
        break;
      case "Pending":
        this._bootedWith = null;
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
        this._bootedWith = null;
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
    if (this._bootGaveUp !== null) {
      const attempts = this._bootGaveUp;
      this._bootGaveUp = null;
      this._events.emit("gaveUp", { target: "boot_notification", attempts });
    }
    if (status === "Accepted") {
      this.applyBootAccepted(interval);
    } else {
      this.stopHeartbeat();
      this._clockAligned.disable();
      this._txEndedAligned.disable();
      // B02.FR.02: no NotifyEvent until the boot is Accepted.
      this._monitorEvaluation?.setReporting(false);
    }
  }

  private applyBootAccepted(interval: number): void {
    // Send connector 0 (charge point level) status first
    this.updateConnectorStatus(0, OCPPStatus.Available);
    // #455: a transaction the power-loss recovery is about to end was already
    // decided at the loss. Reporting its pre-loss status (Charging) after the
    // reboot would suggest energy flowed after the restart, so the recovery's
    // own Finishing / Available is the first thing the CSMS hears (#811).
    const ending = this.connectorsEndedByPowerRecovery();
    this.connectors.forEach((connector) => {
      if (ending.has(connector.id)) return;
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
      if (
        connector.availability !== "Inoperative" &&
        connector.autoResetToAvailable &&
        !connector.hasRunningTransaction
      ) {
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
    this._txEndedAligned.enable();
    // #455: after the status fan-out and the flush of the queue (both
    // already scheduled), so the recovery's messages come last.
    queueMicrotask(() => this.runPowerRecovery());
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
    // 1.6 samples the transaction-end history on the same grid
    // (`StopTxnAlignedData`, 1.6 §3.16.2); 2.x has a
    // grid of its own (`_txEndedAligned`).
    if (!isOcpp2Version(this._ocppVersion)) {
      this.recordAlignedTxEndedSamples(
        this._configuration.stopTxnAlignedData(),
        boundaryMs,
      );
    }
    // Empty by default; the interval change already logged that it is.
    const measurands = this._configuration.meterValuesAlignedData();
    if (measurands.length === 0) return;
    const timestamp = new Date(boundaryMs);
    // 2.x AlignedDataCtrlr.SendDuringIdle is a station-level variable: while
    // any transaction runs, no clock-aligned values go out for any EVSE or the
    // main meter (J01.FR.20; J01.FR.19 is the per-EVSE form the variable does
    // not have here).
    if (
      isOcpp2Version(this._ocppVersion) &&
      this._configuration.alignedDataSendDuringIdle() &&
      [...this._connectors.values()].some((c) => c.hasRunningTransaction)
    ) {
      return;
    }
    this._connectors.forEach((connector) => {
      if (
        this.sendSampleInTransactionEvent(connector, {
          triggerReason: "MeterValueClock",
          context: "Sample.Clock",
          measurands,
          timestamp,
        })
      ) {
        return;
      }
      // `0` until StartTransaction.conf assigns the id.
      const id = connector.transaction?.id;
      const transactionId =
        connector.hasRunningTransaction && id ? id : undefined;
      this._outbox.sendMeterValue(transactionId, connector.id, "Sample.Clock", {
        measurands,
        timestamp,
      });
    });
    if (this._mainMeter) {
      this._outbox.sendMeterValue(undefined, 0, "Sample.Clock", {
        measurands,
        timestamp,
      });
    }
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
    const transaction = connector.transaction;
    if (!transaction || !connector.hasRunningTransaction) return;
    // 2.x: the same MeasurandEnumType filter and unit multiplier as every
    // other sample of the dialect (#714, #826); a name outside the enum is
    // never recorded (B05.FR.07 rejects it in SetVariables, but a persisted
    // or scenario-set list may still carry one).
    const ocpp2 = isOcpp2Version(this._ocppVersion);
    const allowed = ocpp2 ? measurandEnumFor(this._ocppVersion) : null;
    const kept = allowed
      ? measurands.filter((m) => allowed.has(m))
      : measurands;
    if (kept.length === 0) return;
    const sampledValue = buildSampledValues(connector, kept, context, {
      unitMultiplier: ocpp2,
      intervalStream:
        context === "Sample.Clock" ? "txEnded-aligned" : "txEnded-sampled",
    });
    if (sampledValue.length === 0) return;
    const history = transaction.txEndedSamples ?? [];
    const next = [
      ...history,
      { timestamp: timestamp.toISOString(), sampledValue },
    ].slice(-TX_ENDED_SAMPLES_MAX);
    connector.patchTransaction({ txEndedSamples: next });
  }

  /**
   * The scheduler-tick sample of the history (`StopTxnSampledData`). 1.6
   * samples at every tick, the cadence of the MeterValues it accompanies
   * (1.6 §3.16.1). 2.x samples when `TxEndedInterval`
   * seconds have passed since the previous one (or the start), judged at the
   * tick, so the interval cannot be finer than the tick.
   */
  private recordSampledTxEndedSample(connector: Connector): void {
    const transaction = connector.transaction;
    if (!transaction || !connector.hasRunningTransaction) return;
    const measurands = this._configuration.stopTxnSampledData();
    if (measurands.length === 0) return;
    const now = this._clock.now();
    if (isOcpp2Version(this._ocppVersion)) {
      const intervalMs = this._configuration.txEndedInterval() * 1000;
      if (intervalMs <= 0) return;
      const history = transaction.txEndedSamples ?? [];
      const last = [...history]
        .reverse()
        .find((e) => e.sampledValue[0]?.context === "Sample.Periodic");
      const lastMs = last
        ? Date.parse(last.timestamp)
        : transaction.startTime.getTime();
      if (now - lastMs < intervalMs) return;
    }
    this.recordTxEndedSample(
      connector,
      measurands,
      "Sample.Periodic",
      new Date(now),
    );
  }

  private recordAlignedTxEndedSamples(
    measurands: string[],
    boundaryMs: number,
  ): void {
    if (measurands.length === 0) return;
    const timestamp = new Date(boundaryMs);
    this._connectors.forEach((connector) =>
      this.recordTxEndedSample(
        connector,
        measurands,
        "Sample.Clock",
        timestamp,
      ),
    );
  }

  /**
   * The socket is open. A (re)start of the link sends a BootNotification; the
   * transport's automatic reconnect after a connection loss on OCPP 2.x does
   * not while the boot data is unchanged and the last boot was Accepted
   * (OCPP-J 2.0.1 §5.4: "SHOULD NOT send a BootNotification unless one or
   * more of the elements … have changed"; #702). `BootOnReconnect` keeps the
   * boot on every connect.
   */
  private onSocketOpen(): ChargePointEvents["reconnectResumed"] | null {
    const restart = this._bootOnNextOpen;
    this._bootOnNextOpen = false;
    if (
      !restart &&
      isOcpp2Version(this._ocppVersion) &&
      !this._configuration.bootOnReconnect() &&
      this._bootedWith !== null &&
      this._bootedWith === JSON.stringify(this._bootNotification)
    ) {
      return this.resumeAfterReconnect();
    }
    this.clearOutage();
    this.boot();
    return null;
  }

  /** The outage is over: forget what it recorded (#702). */
  private clearOutage(): void {
    this._offlineSince = null;
    this._statusAtDrop = new Map();
    this._cascadedAtDrop = new Map();
    this._reservationsAtDrop = [];
    this._stationProfilesAtDrop = [];
  }

  /**
   * The effects of an Accepted boot that a reconnect still needs, without the
   * BootNotification (#702): B04.FR.01/02 status reports, the heartbeat, the
   * clock-aligned and monitoring timers and the E11 replay of the queued
   * TransactionEvents (E11.FR.02).
   *
   * The connection loss left the connectors `Unavailable` locally (the CSMS
   * never heard of it). They get their status back without a wire message;
   * a StatusNotification goes out for those whose status differs from what
   * the CSMS knew, and for all of them when the outage was longer than
   * `OfflineThreshold`.
   */
  private resumeAfterReconnect(): ChargePointEvents["reconnectResumed"] {
    const offlineMs =
      this._offlineSince === null ? 0 : this._clock.now() - this._offlineSince;
    const atDrop = this._statusAtDrop;
    const cascaded = this._cascadedAtDrop;
    const reservations = this._reservationsAtDrop;
    const stationProfiles = this._stationProfilesAtDrop;
    this.clearOutage();
    const reportAll = offlineMs > this._configuration.offlineThreshold() * 1000;
    this._logger.info(
      `Reconnected after ${Math.round(offlineMs / 1000)}s offline; no BootNotification (boot data unchanged), reporting ${
        reportAll ? "all connectors" : "the connectors that changed"
      }`,
      LogType.OCPP,
    );
    this._outbox.setBootStatus({ status: "Accepted" });
    this._bootAccepted = true;
    this.error = "";

    // A link loss is not a reboot: the reservations survive it (B01.FR.13
    // keeps Reserved even across a reboot), with their expiry timer.
    const reserved = new Set(
      this._reservationManager
        .restore(reservations)
        .map((reservation) => reservation.connectorId),
    );

    // Likewise the station-level charging profiles (ChargingStationMaxProfile,
    // station TxDefaultProfile): without a boot the CSMS has no cue to push
    // them again, and nothing allows dropping them on a connection loss
    // (#799). A profile that expired during the outage stays gone.
    const resumedAt = this._nowDate();
    for (const profile of stationProfiles) {
      if (profile.validTo && new Date(profile.validTo) <= resumedAt) continue;
      this.applyChargingProfile(profile, "SetChargingProfile");
    }

    // What the CSMS last answered is what it knows; the station's own state
    // now decides what is true, and the difference is reported (B04.FR.02).
    const acked = this._ackedStatus;
    const cpAtDrop = (atDrop.get(0) ?? OCPPStatus.Available) as
      OCPPStatus.Available | OCPPStatus.Unavailable | OCPPStatus.Faulted;
    const cpNow = this._status;
    const cpTarget = cpNow === OCPPStatus.Unavailable ? cpAtDrop : cpNow;
    if (cpTarget !== cpNow) this.status = cpTarget;
    // Compared as the 2.x wire carries them (Preparing and Charging are both
    // `Occupied`): the CSMS knows nothing else.
    const knows = (id: number, target: OCPPStatus): boolean => {
      const known = acked.get(id);
      return (
        known !== undefined &&
        toV2ConnectorStatus(known) === toV2ConnectorStatus(target)
      );
    };
    if (reportAll || !knows(0, cpTarget)) {
      this.updateConnectorStatus(0, cpTarget);
    }
    this.connectors.forEach((connector) => {
      let target = connector.status;
      const made = cascaded.get(connector.id);
      if (
        target === OCPPStatus.Unavailable &&
        made !== undefined &&
        connector.transaction === null &&
        // An availability change made while the link was going down is real.
        connector.availability !== "Inoperative"
      ) {
        target =
          made === OCPPStatus.Reserved && !reserved.has(connector.id)
            ? OCPPStatus.Available
            : made;
        this.writeConnector(connector.id, {
          kind: "status",
          status: target,
          scope: "event",
        });
      }
      if (reportAll || !knows(connector.id, target)) {
        this.updateConnectorStatus(connector.id, target);
      }
    });

    // The interval in force (the CSMS's, or one set since) survives the
    // teardown, which only stopped the timer; re-arm it.
    this.startHeartbeat(this._heartbeat.intervalSeconds);
    this._clockAligned.enable();
    this._monitorEvaluation?.setReporting(true);
    // After the status reports, as for an accepted boot.
    queueMicrotask(() => this._outbox.flushPendingQueue());
    return { offlineMs, reportedAll: reportAll };
  }

  /** A station without power starts, stops and boots nothing (#798). */
  private assertPowered(): void {
    if (this._powerLoss) throw new PowerStateError("powered_off");
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
    if (!this.isOnline()) this._bootOnNextOpen = true;
    this._bootUnanswered = true;
    this._ackedStatus = new Map();
    this._bootSentFingerprint = JSON.stringify(this._bootNotification);
    // OCPP 1.6J §4.2: the CP MUST NOT send any other CALL message until
    // BootNotification has been Accepted. The connector-level
    // StatusNotification fan-out happens in BootNotificationResultHandler
    // after we get the Accepted response.
    this._outbox.sendBootNotification(this._bootNotification, this._bootReason);
    this.error = "";
  }

  disconnect(): void {
    this._logger.info(
      this._webSocket
        ? "Disconnecting from WebSocket"
        : `Disconnecting ${this._ocppVersion} SOAP client`,
      this._webSocket ? LogType.WEBSOCKET : LogType.OCPP,
    );
    // A renewed certificate is presented at the next connect() (#537).
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
    this._bootAccepted = false;
    // #702: remember what the CSMS knew when the outage began; a repeated
    // teardown of the same outage must not record the Unavailable it made.
    if (this._bootUnanswered) this._bootOnNextOpen = true;
    if (this._offlineSince === null) {
      this._offlineSince = this._clock.now();
      this._statusAtDrop = new Map([
        [0, this._status],
        ...[...this._connectors.values()].map(
          (connector) => [connector.id, connector.status] as const,
        ),
      ]);
      this._reservationsAtDrop = this._reservationManager.getAllReservations();
      this._stationProfilesAtDrop = [...this._stationProfiles.all()];
    }
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
    if (this._cascadedAtDrop.size === 0) {
      // First teardown of the outage: which Unavailable did the cascade make?
      for (const connector of this._connectors.values()) {
        const before = this._statusAtDrop.get(connector.id);
        if (
          before !== undefined &&
          before !== OCPPStatus.Unavailable &&
          connector.status === OCPPStatus.Unavailable
        ) {
          this._cascadedAtDrop.set(connector.id, before);
        }
      }
    }
    this._heartbeat.cleanup();
    this._clockAligned.disable();
    this._txEndedAligned.disable();
    // Offline: events at or below OfflineQueuingSeverity are queued
    // (N07.FR.04, N08.FR.03) until the next boot is Accepted (#538).
    this._monitorEvaluation?.setOffline();
    this._connectors.forEach((connector) => connector.cleanup());
    this._reservationManager.dispose();
    // The Local Authorization List is kept: it is what authorizes while the
    // connection is down (§3.5.3, LocalAuthorizeOffline), so a connection
    // loss must not empty it (#534). Only dispose() drops it.
    this.clearChargingProfiles(0, {}, "ConnectionClosed");
    // The engine ends the follow-up of answers a behavior of the user gave
    // (they are bound to the connection). The follow-up of a default behavior,
    // such as the firmware status train, goes on: it did before the engine.
    this._engine.connectionClosed();
    this._scenarioHandledConnectors.clear();
    this._scenarioStopHandledConnectors.clear();
    this._lastDefaultHandledRemoteStart.clear();
    this._lastDefaultHandledRemoteStop.clear();
    // Issue #110: stale response overrides must not survive a
    // disconnect — they would silently answer the next real CSMS call.
    this._responseOverrides.clear();
    // Cancel all ConnectionTimeOut watchdogs so the timer doesn't fire
    // against a disconnected CP.
    this._connectionTimeoutTimers.forEach((t) => this._clock.clearTimeout(t));
    this._connectionTimeoutTimers.clear();
    // §4.1.1 serializer: drop the in-flight CALL + queued CALLs since the
    // WebSocket they target is gone. Transaction-related ones go to the
    // PendingMessageQueue (1.6 §3.7; 2.x E11 TransactionEvents, #528).
    this._outbox.onWebSocketClosed();
    // Flush any buffered log lines so the operator can still see the
    // last seconds of activity after the CP went down.
    this._logSink.flush();
  }

  reset(reason: BootReason = "LocalReset"): void {
    this._bootReason = reason;
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

  /** Whether the station is without power (#455). */
  get poweredOff(): boolean {
    return this._powerLoss !== null;
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
    if (this.isSoapChargePoint()) {
      throw new PowerStateError("unsupported_transport");
    }
    if (this._powerLoss) throw new PowerStateError("already_powered_off");
    const record: PowerLossRecord = {
      at: this._nowDate(),
      transactions: [...this._connectors.values()]
        .filter((connector) => connector.hasRunningTransaction)
        .map((connector) => ({
          connectorId: connector.id,
          transactionId: connector.transaction?.id ?? 0,
        })),
    };
    this._powerLoss = record;
    // Power was lost before it was restored: a recovery still waiting for a
    // boot is moot, the new loss defines it.
    this._powerRecovery = null;
    this._logger.warn(
      `Power loss: ${record.transactions.length} transaction(s) interrupted`,
      LogType.TRANSACTION,
    );
    this._events.emit("powerLost", {
      transactions: record.transactions.length,
    });
    this._webSocket?.disconnect();
    this.teardownAfterClose();
    const { restoreAfterMs, ...restore } = options;
    if (restoreAfterMs !== undefined) {
      this._powerRestoreTimer = this._clock.setTimeout(() => {
        this._powerRestoreTimer = null;
        if (this._powerLoss) this.restorePower(restore);
      }, restoreAfterMs);
    }
    return record;
  }

  /**
   * Power returns (#455). The station boots: BootNotification first (1.6
   * §4.2, 2.x B01.FR.03 "after a reboot (for instance due to ... power
   * outage)"), nothing else before it is Accepted, then the transaction
   * messages the outage left queued, then the recovery of the interrupted
   * transactions (see {@link PowerRestoreOptions}).
   */
  restorePower(options: PowerRestoreOptions = {}): PowerRestoreResult {
    const loss = this._powerLoss;
    if (!loss) throw new PowerStateError("not_powered_off");
    if (this._powerRestoreTimer !== null) {
      this._clock.clearTimeout(this._powerRestoreTimer);
      this._powerRestoreTimer = null;
    }
    const restoredAt = this._nowDate();
    const outageMs = Math.max(0, restoredAt.getTime() - loss.at.getTime());
    this._powerLoss = null;
    // Power returning is a start of the device: the Accepted boot that follows
    // reports StartupOfTheDevice again (#734, A04.FR.01).
    this._startupEventPending = true;
    const recovery = this.planPowerRecovery(loss, outageMs, options);
    this._powerRecovery =
      loss.transactions.length > 0
        ? { loss, options: { ...options, transactions: recovery }, restoredAt }
        : null;
    this._logger.info(
      `Power restored after ${Math.round(outageMs / 1000)}s`,
      LogType.TRANSACTION,
    );
    this._events.emit("powerRestored", {
      outageMs,
      recovery: loss.transactions.length > 0 ? recovery : "none",
      transactions: loss.transactions.length,
    });
    this.connect();
    return {
      outageMs,
      recovery: loss.transactions.length > 0 ? recovery : "none",
      transactions: loss.transactions.length,
    };
  }

  /**
   * 1.x: the spec leaves it open, so `resume` is the default and `end` is
   * available. 2.1 E17.FR.10/20: resume only when the outage lasted at most
   * `TxResumptionTimeout` (> 0), otherwise end. 2.0.1 has no resumption
   * (no `TxResumed` trigger reason): the default is `end`.
   */
  private planPowerRecovery(
    loss: PowerLossRecord,
    outageMs: number,
    options: PowerRestoreOptions,
  ): PowerRecovery {
    if (loss.transactions.length === 0) return options.transactions ?? "resume";
    const wanted =
      options.transactions ??
      (this._ocppVersion === OCPP_2_0_1 ? "end" : "resume");
    if (wanted === "end") return "end";
    if (this._ocppVersion !== OCPP_2_1) return "resume";
    const timeout = options.txResumptionTimeoutSeconds ?? 0;
    return timeout > 0 && outageMs <= timeout * 1000 ? "resume" : "end";
  }

  /** Connectors whose running transaction the pending recovery will end. */
  private connectorsEndedByPowerRecovery(): ReadonlySet<number> {
    const pending = this._powerRecovery;
    const out = new Set<number>();
    if (!pending || pending.options.transactions !== "end") return out;
    for (const { connectorId } of pending.loss.transactions) {
      if (this.getConnector(connectorId)?.hasRunningTransaction) {
        out.add(connectorId);
      }
    }
    return out;
  }

  /** Run the pending power-loss recovery; the boot is Accepted. */
  private runPowerRecovery(): void {
    const pending = this._powerRecovery;
    if (!pending) return;
    this._powerRecovery = null;
    const recovery = pending.options.transactions ?? "resume";
    const twoX = isOcpp2Version(this._ocppVersion);
    for (const { connectorId } of pending.loss.transactions) {
      const connector = this.getConnector(connectorId);
      if (!connector?.hasRunningTransaction) continue;
      if (recovery === "end") {
        // 1.6 reason `PowerLoss`; 2.x E17.FR.21 Ended + AbnormalCondition +
        // PowerLoss. Stamped with the loss, the moment the station recorded
        // the shutdown (E17.FR.02).
        this.stopTransaction(connector, "PowerLoss", {
          triggerReason: "AbnormalCondition",
          stoppedReason: "PowerLoss",
          stoppedAt: pending.loss.at,
        });
        continue;
      }
      if (!connector.isAutoMeterValueActive()) {
        connector.startConfiguredMeterValue();
      }
      if (this._ocppVersion === OCPP_2_1) {
        // B13.FR.30, E17.FR.14: Updated + TxResumed with the charging state.
        const status = connector.status;
        this._outbox.sendTransactionUpdate(connectorId, {
          // Not in the 2.0.1 vocabulary the encoder is typed against; 2.1 only.
          triggerReason: "TxResumed" as TransactionStopTriggerReason,
          chargingState:
            status === OCPPStatus.Charging
              ? "Charging"
              : status === OCPPStatus.SuspendedEV
                ? "SuspendedEV"
                : status === OCPPStatus.SuspendedEVSE
                  ? "SuspendedEVSE"
                  : "EVConnected",
        });
      } else if (twoX) {
        this._logger.info(
          `Transaction on connector ${connectorId} continues; OCPP 2.0.1 has no TxResumed trigger reason`,
          LogType.TRANSACTION,
        );
      }
    }
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
    for (const driver of this._vehicleDrivers.values()) driver.dispose();
    this._vehicleDrivers.clear();
    if (this._powerRestoreTimer !== null) {
      this._clock.clearTimeout(this._powerRestoreTimer);
      this._powerRestoreTimer = null;
    }
    this.releaseRenewedClientCertificate();
    for (const connectorId of [...this._periodicSamplers.keys()]) {
      this.stopPeriodicSampling(connectorId);
    }
    this._webSocket?.dispose(); // terminal: shuts controller down, clears reservation, closes socket
    this.teardownAfterClose(); // final CP-side teardown
    this._engine.dispose();
    // Offline monitoring keeps the periodic timers running: stop them.
    this.stopMonitoring();
    this._localAuthListManager.dispose();
    this._timelineProjector.dispose();
    // The socket's real close event still arrives asynchronously and its
    // handler logs "WebSocket closed" through this log sink. Closing it
    // here (not in teardownAfterClose, which a plain disconnect shares)
    // drops that late line instead of buffering it — otherwise a `cp.delete`
    // that just cascaded to `logs` gets one row back for the deleted id
    // (#326).
    this._logSink.close();
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
    this._startupEventPending = true;
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
        this.writeConnector(connector.id, {
          kind: "status",
          status: OCPPStatus.Unavailable,
          scope: "event",
        });
      });
    }
    this._events.emit("statusChange", { status: newStatus, previousStatus });
    this._stateManager.transitionChargePointStatus(newStatus, {
      source: "boundary-setter",
      timestamp: this._nowDate(),
    });
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
    this._pendingResetsOnIdle.push({ evseId });
    // The transaction can end after the handler decided to answer Scheduled
    // but before this callback runs. Recheck after enqueueing to avoid leaving
    // an already-runnable reset stranded until a later transaction ends.
    this.runPendingResetOnIdle();
  }

  /**
   * #597: drop every pending Reset OnIdle. An Immediate reset reboots the
   * station now, which already satisfies them; keeping them would boot
   * again on a later transaction end.
   */
  cancelPendingResetsOnIdle(evseId?: number): void {
    this._pendingResetsOnIdle =
      evseId === undefined
        ? []
        : this._pendingResetsOnIdle.filter(
            (pending) => pending.evseId !== evseId,
          );
  }

  /**
   * #597: boot again once a pending reset has no targeted connector left
   * with a transaction. Called when a transaction ends (the engine's default stop) and when a
   * connector is removed. Each pending
   * reset stays queued while its targets are still busy; the station
   * boots once if any of them became runnable.
   */
  runPendingResetOnIdle(): void {
    if (this._pendingResetsOnIdle.length === 0) return;
    const isBusy = (pending: { evseId?: number }): boolean =>
      [...this._connectors.values()].some(
        (connector) =>
          (pending.evseId === undefined || connector.id === pending.evseId) &&
          connector.hasRunningTransaction,
      );
    const remaining = this._pendingResetsOnIdle.filter(isBusy);
    if (remaining.length === this._pendingResetsOnIdle.length) return;
    const runnable = this._pendingResetsOnIdle.filter(
      (pending) => !remaining.includes(pending),
    );
    this._pendingResetsOnIdle = remaining;
    // A station-wide reset reboots everything and subsumes EVSE resets.
    if (runnable.some((pending) => pending.evseId === undefined)) {
      this.boot("ScheduledReset");
      return;
    }
    for (const evseId of new Set(runnable.map((pending) => pending.evseId))) {
      if (evseId !== undefined) this.resetEvse(evseId);
    }
  }

  /**
   * Reset one EVSE (2.x B11.FR.08, B12.FR.12/14): it is reported Unavailable
   * and returns to the state it had, which stays Unavailable for an
   * Inoperative EVSE (B11.FR.02) and Reserved for a reserved one (B11.FR.05).
   * No BootNotification: that belongs to a reset of the whole station
   * (B11.FR.03/04). The caller has already ended the EVSE's transaction.
   */
  resetEvse(evseId: number): void {
    const connector = this.getConnector(evseId);
    if (!connector) return;
    const previous = connector.status;
    if (previous === OCPPStatus.Unavailable) return;
    this.updateConnectorStatus(evseId, OCPPStatus.Unavailable);
    this.updateConnectorStatus(evseId, previous);
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
    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(
        `Connector ${connectorId} not found`,
        LogType.TRANSACTION,
      );
      return;
    }

    connector.markEvUnplugged();
    if (!connector.hasRunningTransaction) {
      // Only the states that exist because a cable is plugged in fall back
      // to Available (#453); an unplug does not lift an Unavailable, Faulted
      // or Reserved connector, nor repeat an Available.
      if (
        connector.status === OCPPStatus.Preparing ||
        connector.status === OCPPStatus.Finishing ||
        connector.status === OCPPStatus.SuspendedEV ||
        connector.status === OCPPStatus.SuspendedEVSE
      ) {
        this.updateConnectorStatus(connectorId, OCPPStatus.Available);
      }
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

  /**
   * The status a connector shows when whatever held it (an unavailable
   * period, a reservation, a firmware hold) ends: `Preparing` (2.x `Occupied`)
   * while a cable is recorded and no transaction runs (1.6 §4.9; 2.0.1 G01,
   * H03.FR.10), else `Available`. Without this a plug-in during the hold stayed
   * recorded while `Available` was shown, and the next plug-in was swallowed
   * (#830 review).
   */
  statusWhenFree(connectorId: number): OCPPStatus {
    const connector = this.getConnector(connectorId);
    return connector &&
      connectorId !== 0 &&
      !this.poweredOff &&
      !connector.hasRunningTransaction &&
      connector.evConnection !== "disconnected"
      ? OCPPStatus.Preparing
      : OCPPStatus.Available;
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
    const connector = this.getConnector(connectorId);
    if (!connector || connectorId === 0) {
      this._logger.error(
        `Connector ${connectorId} not found`,
        LogType.TRANSACTION,
      );
      return;
    }
    if (connector.evConnection !== "disconnected") {
      // A cable recorded while the connector shows Available (a path that
      // freed it without looking at the cable) still reports the plug-in.
      if (
        !this.poweredOff &&
        !connector.hasRunningTransaction &&
        connector.status === OCPPStatus.Available
      ) {
        this.updateConnectorStatus(connectorId, OCPPStatus.Preparing);
      }
      return;
    }
    connector.markEvPluggedIn();
    if (
      isOcpp2Version(this._ocppVersion) &&
      connector.hasRunningTransaction &&
      !this.poweredOff
    ) {
      // E03 (idToken first): the cable arrives after the transaction began.
      // E03.FR.12 / E02.FR.17: Updated, CablePluggedIn, chargingState
      // EVConnected; the EVConnectionTimeOut is over (E03.FR.05 applies only
      // when no EV connects); the energy offer then starts (Charging).
      this.clearConnectionTimeout(connectorId);
      this._outbox.sendTransactionUpdate(connectorId, {
        triggerReason: "CablePluggedIn",
        chargingState: "EVConnected",
      });
      if (connector.status === OCPPStatus.Preparing) {
        this.updateConnectorStatus(connectorId, OCPPStatus.Charging);
      }
      return;
    }
    if (
      !this.poweredOff &&
      !connector.hasRunningTransaction &&
      connector.status === OCPPStatus.Available
    ) {
      this.updateConnectorStatus(connectorId, OCPPStatus.Preparing);
    }
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
    const connector = this.getConnector(connectorId);
    if (!connector || connectorId === 0) {
      this._logger.error(
        `Connector ${connectorId} not found`,
        LogType.TRANSACTION,
      );
      return;
    }
    if (connector.evConnection === "disconnected") {
      throw new Error(`Connector ${connectorId} has no EV plugged in`);
    }
    connector.markEvReady(ready);
    if (!connector.hasRunningTransaction) return;
    if (!ready) {
      if (connector.status !== OCPPStatus.Charging) return;
      connector.suspendEnergyOffer();
      // On 2.x the status write carries the TransactionEvent(Updated).
      this.updateConnectorStatus(connectorId, OCPPStatus.SuspendedEV);
      return;
    }
    if (
      connector.status !== OCPPStatus.SuspendedEV ||
      !connector.energyOfferSuspended
    ) {
      return;
    }
    this.updateConnectorStatus(connectorId, OCPPStatus.Charging);
  }

  cleanTransaction(connectorOrId: Connector | number): void {
    this._transactions.clean(this, connectorOrId);
  }

  private readonly transactionPorts: TransactionPorts = {
    sendTransactionEvent: (event) => this._outbox.sendTransactionEvent(event),
    startConnectionTimeout: (connectorId) =>
      this.startConnectionTimeout(connectorId),
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
   * #722, 1.6 errata 3.15 (Part 2 §4.7) and §3.16.1 / §9.1.19: while a
   * transaction runs and `MeterValueSampleInterval` > 0, a MeterValues.req
   * with the `MeterValuesSampledData` measurands goes out every interval,
   * whatever drives the register. The connector's configured meter strategy
   * (auto-meter curve, increment fallback) then only moves the register, so
   * there is one sample per tick, not two schedules. 1.x only (SOAP
   * included): on 2.x the existing sampling is unchanged.
   *
   * The interval is read when the sampler starts (the transaction's start,
   * or its restore after a restart) and again when a ChangeConfiguration of
   * `MeterValueSampleInterval` re-arms the running samplers (#839); at 0
   * none runs. Called again for the same running transaction (the
   * `transactionChange` that persists a `startCallError` or an id), it keeps
   * the timer and so the phase.
   */
  private startPeriodicSampling(connector: Connector): void {
    if (isOcpp2Version(this._ocppVersion)) return;
    if (this._periodicSamplers.has(connector.id)) return;
    connector.setStationOwnsMeterSampling(true);
    const seconds = this._configuration.meterValueSampleInterval();
    if (seconds <= 0) return;
    const timer = this._clock.setInterval(() => {
      // A connector removed (or replaced under the same id) while its timer
      // ran is not sampled any more (#839).
      if (
        !connector.hasRunningTransaction ||
        this._connectors.get(connector.id) !== connector
      ) {
        this.stopPeriodicSampling(connector.id);
        return;
      }
      // A transaction whose StartTransaction.req was answered with a
      // CALLERROR (#527) is sampled too (errata 3.15, §4.7: every interval,
      // SHALL): the MeterValues.req carries the id its StartTransaction got,
      // or -1 until it has one (errata 3.18, §4.8; #565).
      // Offline too: §3.7 "When offline, the Charge Point MUST queue any
      // transaction-related messages", periodic MeterValues included. The
      // outbox queues it (a MeterValues of a transaction) and replays it in
      // order after the reconnect.
      this.sendScheduledMeterValue(connector.id);
    }, seconds * 1000);
    this._periodicSamplers.set(connector.id, timer);
  }

  /** #839: a new `MeterValueSampleInterval` starts the cadence over on every
   *  running transaction; 0 leaves them without a sampler. */
  private rearmPeriodicSampling(): void {
    for (const connectorId of [...this._periodicSamplers.keys()]) {
      this.stopPeriodicSampling(connectorId);
    }
    for (const connector of this._connectors.values()) {
      if (connector.hasRunningTransaction)
        this.startPeriodicSampling(connector);
    }
  }

  private stopPeriodicSampling(connectorId: number): void {
    const timer = this._periodicSamplers.get(connectorId);
    if (timer === undefined) return;
    this._clock.clearInterval(timer);
    this._periodicSamplers.delete(connectorId);
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
    const connector = this.getConnector(connectorId);
    if (connector) this.recordSampledTxEndedSample(connector);
    if (
      this._txUpdatedMeterValues &&
      connector &&
      this.sendSampleInTransactionEvent(connector, {
        triggerReason: "MeterValuePeriodic",
        context: "Sample.Periodic",
        skipWithoutMeterValue: true,
      })
    ) {
      return;
    }
    this.sendMeterValue(connectorId);
  }

  /**
   * The OCPP 2.x routing shared by the clock-aligned (#454) and scheduled
   * (#347) samples: with a transaction running on the connector, the sample
   * rides TransactionEvent(Updated) and this returns true. Otherwise it
   * sends nothing and returns false, leaving the caller to send its own
   * MeterValues.
   */
  private sendSampleInTransactionEvent(
    connector: Connector,
    sample: Omit<TransactionUpdateOptions, "meterValues">,
  ): boolean {
    if (
      !isOcpp2Version(this._ocppVersion) ||
      !connector.hasRunningTransaction
    ) {
      return false;
    }
    this._outbox.sendTransactionUpdate(connector.id, {
      ...sample,
      meterValues: true,
    });
    return true;
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
    this.stopPeriodicSampling(connectorId);
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
      this._events.emit("statusChange", { status, previousStatus });
      this._stateManager.transitionChargePointStatus(status, {
        source: "connector-0-update",
        timestamp: this._nowDate(),
      });
      this._logger.info(
        `Charge point status updated: ${previousStatus} -> ${status} (connector 0)`,
        LogType.SYSTEM,
      );
      // CP-level Faulted: send via the same path, no specific connector
      // errorCode available, so we'd pass NoError by default. Callers that
      // want to set a CP-level fault should use sendCpFaultedNotification.
      this._outbox.sendStatusNotification(0, status);
      // The station is out of service: no reservation survives (after the
      // status, which the CSMS sees first: H01.FR.16/17).
      if (status !== OCPPStatus.Available) this.terminateReservationsOf(0);
      return;
    }

    const connector = this.getConnector(connectorId);
    if (!connector) {
      this._logger.error(`Connector ${connectorId} not found`, LogType.SYSTEM);
      return;
    }

    // Energy held after a non-Accepted id (E05.FR.02): whichever path asks
    // for Charging, the register is stopped, so report SuspendedEVSE.
    if (
      status === OCPPStatus.Charging &&
      connector.energyHeld &&
      connector.hasRunningTransaction
    ) {
      if (connector.status === OCPPStatus.SuspendedEVSE) return;
      status = OCPPStatus.SuspendedEVSE;
    }

    this._engine.dispatch({
      type: "connector.write",
      connectorId,
      write: { kind: "status", status, scope: "full" },
    });
  }

  /** A write to a connector's engine record (docs/concepts/charger-engine.md). */
  private writeConnector(connectorId: number, write: ConnectorWrite): void {
    this._engine.dispatch({ type: "connector.write", connectorId, write });
  }

  /**
   * The rest of a `full` status write, run by the engine right after the
   * record changed and the listeners were told: the connection-timeout timer
   * and the StatusNotification.
   * @internal
   */
  afterConnectorStatus(connectorId: number, status: OCPPStatus): void {
    const connector = this.getConnector(connectorId);
    if (!connector) return;

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

    // A connector that is Faulted or Unavailable holds no reservation: it is
    // ended after the status the CSMS just saw (H01.FR.16/17).
    if (status === OCPPStatus.Faulted || status === OCPPStatus.Unavailable) {
      this.terminateReservationsOf(connectorId);
    }
    syncUnspecifiedReservations(this);
  }

  /** OCPP 1.x (#527): a connector whose transaction runs is past
   *  ConnectionTimeOut. It waits in Preparing for StartTransaction.conf,
   *  which a CALLERROR resend can hold back for longer than the timeout.
   *  On 2.x the setting is TxCtrlr/EVConnectionTimeOut, which targets
   *  exactly a transaction started before the cable is plugged in, so a
   *  running transaction does not hold it back there. */
  private holdsConnectionTimeout(connectorId: number): boolean {
    return (
      !isOcpp2Version(this._ocppVersion) &&
      !!this.getConnector(connectorId)?.hasRunningTransaction
    );
  }

  private startConnectionTimeout(connectorId: number): void {
    this.clearConnectionTimeout(connectorId);
    const timeoutSec = this._configuration?.connectionTimeOut();
    if (timeoutSec <= 0 || this.holdsConnectionTimeout(connectorId)) return;
    const handle = this._clock.setTimeout(() => {
      this._connectionTimeoutTimers.delete(connectorId);
      if (this._powerLoss) return; // no power: nothing ends or changes (#798)
      const connector = this.getConnector(connectorId);
      if (!connector || connector.status !== OCPPStatus.Preparing) return;
      // E03.FR.05: on 2.x a transaction already started without the EV
      // connecting in time is ended (stoppedReason Timeout, triggerReason
      // EVConnectTimeout). 1.6 keeps the B6 Preparing → Finishing move.
      if (
        isOcpp2Version(this._ocppVersion) &&
        connector.hasRunningTransaction
      ) {
        this._logger.info(
          `Connector ${connectorId} EVConnectionTimeOut elapsed; ending the transaction (E03.FR.05)`,
          LogType.TRANSACTION,
        );
        this.stopTransaction(connector, undefined, {
          triggerReason: "EVConnectTimeout",
          stoppedReason: "Timeout",
        });
        if (connector.status === OCPPStatus.Preparing) {
          this.updateConnectorStatus(connectorId, OCPPStatus.Finishing);
        }
        return;
      }
      if (this.holdsConnectionTimeout(connectorId)) return;
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
      this._clock.clearTimeout(handle);
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
