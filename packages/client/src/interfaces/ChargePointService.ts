import type { ResponseOverrideRequest } from "@ocpp-cp-simulator/core/cp/domain/charge-point/responseOverrideRequest";
import type {
  ConfigurationKeyList,
  ConfigurationSetStatus,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/configurationAccess";
import type { StartTransactionOutcome } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { VehicleCatalog } from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleCatalog";
import type {
  AuthorizationCacheSeedEntry,
  AuthorizationCacheView,
} from "@ocpp-cp-simulator/core/cp/domain/auth/AuthorizationCacheSeed";
import type { VehicleProfile } from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleProfile";
import type { AutoTrafficConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import type {
  OcppCallOutcome,
  OcppCallRequest,
  RawFrameOutcome,
  RawFrameRequest,
  CallResultErrorOutcome,
  CallResultErrorRequest,
  OcppSendOutcome,
  OcppSendRequest,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppCall";
import type {
  Get15118EVCertificateRequest,
  Get15118EVCertificateResult,
} from "@ocpp-cp-simulator/core/cp/domain/security/get15118EVCertificate";
import type {
  DataTransferData,
  DataTransferResult,
} from "@ocpp-cp-simulator/core/cp/domain/types/DataTransfer";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/FirmwareLogStatus";
import type {
  PowerLossOptions,
  PowerRestoreOptions,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type {
  EVSettings,
  EVSettingsPatch,
} from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioMode,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ScenarioRunResult } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioAssertions";
import type {
  ScenarioRunPage,
  ScenarioRunQuery,
} from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunSummary";
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import type {
  OCPPStatus,
  StatusNotificationOptions,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type {
  TimelinePage,
  TimelineQuery,
} from "@ocpp-cp-simulator/core/cp/application/services/OperationalTimeline";
import type {
  ChargingSessionPage,
  ChargingSessionQuery,
} from "@ocpp-cp-simulator/core/cp/domain/persistence/ChargingSessionRepository";
import type { Labels } from "@ocpp-cp-simulator/contracts/labels";
import type { ModemWire as RedactedModemState } from "@ocpp-cp-simulator/contracts/events";
import type { ModemCommand as ModemCommandInput } from "@ocpp-cp-simulator/contracts/modem";
import type {
  FleetCreateParams,
  FleetCreateResult,
  FleetTemplate,
} from "@ocpp-cp-simulator/contracts/methods";
import type {
  NetworkSimLayerConfig,
  ResolvedNetworkSimConfig,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import type {
  ServerInfo,
  SimulatorConfigInput,
  WireSimulatorConfig,
} from "@ocpp-cp-simulator/contracts/index";
import type {
  MeterReadingContext,
  StartTransactionCommandOptions,
  IdTokenTypeName,
  StopTransactionCommandOptions,
  TransactionUpdateOptions,
} from "@ocpp-cp-simulator/core/cp/domain/connector/Transaction";
import type {
  ChargePointSnapshot,
  CreateChargePointParams,
  ChargePointEvent,
  ScenarioListItem,
  StoredLogEntry,
  ScenarioTemplateInfo,
  ScenarioRunOptions,
  LocalChargePointHandle,
} from "./ChargePointServiceTypes";

export * from "./ChargePointServiceTypes";

export interface ChargePointService {
  // Discovery
  listChargePoints(): Promise<ChargePointSnapshot[]>;
  getChargePoint(id: string): Promise<ChargePointSnapshot | null>;
  /** Returns the in-process domain ChargePoint when available (local mode). */
  getLocalChargePoint?(id: string): LocalChargePointHandle | null;

  // Registry (mainly relevant for remote mode; local always returns false / no-ops cleanly)
  createChargePoint?(params: CreateChargePointParams): Promise<void>;
  /** Replace the configuration of an existing CP. Remote only — the daemon
   *  tears down the existing WebSocket, persists the new row in-place
   *  (preserving any loaded scenarios), and re-instantiates the CP. The
   *  local-mode store edits its config directly without needing this
   *  method, so the interface keeps it optional. */
  updateChargePoint?(params: CreateChargePointParams): Promise<void>;
  /** #471: replace a CP's labels (#446) in place (`cp.labels.set`) — no
   *  rebuild, so unlike {@link updateChargePoint} the connection survives.
   *  Remote only: local charge points have no labels and the local service
   *  rejects with `UnsupportedFeatureError`. */
  setChargePointLabels?(cpId: string, labels: Labels): Promise<void>;
  removeChargePoint?(id: string): Promise<void>;
  /** #445: fleet templates (`fleet.template.*`, `fleet.create`). Remote only:
   *  the daemon stores them and creates the charge points; the local service
   *  rejects with `UnsupportedFeatureError`. */
  listFleetTemplates?(): Promise<FleetTemplate[]>;
  getFleetTemplate?(id: string): Promise<FleetTemplate>;
  /** Stores (or replaces) a stored template; resolves to its id. A template
   *  that came from a `--fleet-template` file is refused by the daemon. */
  saveFleetTemplate?(template: FleetTemplate): Promise<string>;
  deleteFleetTemplate?(id: string): Promise<void>;
  /** Instantiates a template. Partial success is the result, not an error. */
  createFleet?(params: FleetCreateParams): Promise<FleetCreateResult>;
  ping?(): Promise<{ ok: boolean; cps: number }>;
  /** Daemon-wide facts (`server.info`): version and the SOAP public base a
   *  charge point created without a callback URL derives one from (#183).
   *  Remote only; local mode has no daemon and no callback endpoint. */
  getServerInfo?(): Promise<ServerInfo | null>;

  /** Wipe every simulator-owned table in the backing SQLite store
   *  (scenarios, connector settings, charging profiles, configuration
   *  overrides, pending messages, logs, …). Schema is preserved.
   *
   *  In local mode this clears the browser sql.js DB. In remote mode it
   *  sends the `state.reset` socket.io RPC to the daemon. Callers should reload
   *  the UI afterwards to drop in-memory caches. */
  resetAllState?(): Promise<void>;

  /** Delete all persisted log rows for the given CP from the SQLite store.
   *  Does NOT touch the in-memory log buffer the UI is reading from — the
   *  caller is expected to clear that separately so the user keeps control
   *  over the screen-side state. */
  clearStoredLogs?(cpId: string): Promise<void>;

  /** Return every persisted log row for the given CP, oldest-first. Used
   *  by the Download Logs button — the returned shape is what the JSONL
   *  file ends up containing, one JSON object per line. */
  listStoredLogs?(cpId: string): Promise<StoredLogEntry[]>;

  /** #388: the daemon's finished scenario runs across every charge point,
   *  newest first, filtered and paged (`scenario.runs.list`). Summaries only —
   *  {@link getScenarioReport} returns a run's full report. Remote only:
   *  local mode keeps no run history. */
  listScenarioRuns?(query: ScenarioRunQuery): Promise<ScenarioRunPage>;

  /** #448: a charge point's operational timeline (`timeline.get`), oldest
   *  first unless `query.order` is `"desc"`. Optional so a test double need
   *  not implement it. */
  getOperationalTimeline?(
    cpId: string,
    query?: TimelineQuery,
  ): Promise<TimelinePage>;

  /** #447: a charge point's charging-session history (`sessions.list`),
   *  newest first unless `query.order` is `"asc"`. Optional so a test double
   *  need not implement it. */
  listChargingSessions?(
    cpId: string,
    query?: Omit<ChargingSessionQuery, "cpId">,
  ): Promise<ChargingSessionPage>;

  /** #612: a running charge point's OCPP configuration keys
   *  (`cp.config_keys.get`); empty `keys` lists them all. Optional so a test
   *  double need not implement it. */
  getConfigurationKeys?(
    cpId: string,
    keys?: readonly string[],
  ): Promise<ConfigurationKeyList>;
  /** #612: write one key (`cp.config_keys.set`). Rejects with
   *  `UnknownConfigurationKeyError` / `ConfigurationWriteRejectedError`
   *  locally and `RpcFailure` (`not_found` / `invalid_params`) remotely. */
  setConfigurationKey?(
    cpId: string,
    key: string,
    value: string,
  ): Promise<ConfigurationSetStatus>;

  // Saved vehicle profiles (#458). Local mode keeps them in the browser's
  // sql.js database, Remote mode on the daemon (`vehicle_profiles.*`). Both
  // implement these; they are optional so a test double need not.
  listVehicleProfiles?(): Promise<VehicleProfile[]>;
  /** Inserts or replaces by id; resolves with what was stored. */
  saveVehicleProfile?(profile: VehicleProfile): Promise<VehicleProfile>;
  deleteVehicleProfile?(id: string): Promise<void>;
  /** #458: the daemon's vehicle catalog, called with the daemon's API key.
   *  Remote only: in Local mode the console calls the catalog itself with a
   *  key the user typed (see `apps/web/src/console/lib/vehicleCatalog.ts`). */
  getVehicleCatalog?(): VehicleCatalog;

  // Persisted simulator config. Reads may be redacted over wire adapters.
  loadConfig(): Promise<WireSimulatorConfig | null>;
  saveConfig(config: SimulatorConfigInput | null): Promise<void>;
  subscribeConfig(
    handler: (config: WireSimulatorConfig | null) => void,
  ): () => void;

  // Network simulation
  getNetworkSimGlobal(): Promise<NetworkSimLayerConfig | null>;
  saveNetworkSimGlobal(config: NetworkSimLayerConfig | null): Promise<void>;
  getNetworkSimCp(cpId: string): Promise<{
    config: NetworkSimLayerConfig | null;
    resolved: ResolvedNetworkSimConfig;
  }>;
  saveNetworkSimCp(
    cpId: string,
    config: NetworkSimLayerConfig | null,
  ): Promise<void>;
  triggerNetworkSimDisconnect(
    cpId: string,
    ruleId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;

  /** #928: the masked modem and SIM state, or `no_modem_model`. */
  getModem(
    cpId: string,
  ): Promise<
    { ok: true; modem: RedactedModemState } | { ok: false; error: string }
  >;
  /** #928: one lifecycle command; a refused transition answers its typed code. */
  modemCommand(
    cpId: string,
    command: ModemCommandInput,
  ): Promise<
    { ok: true; modem: RedactedModemState } | { ok: false; error: string }
  >;

  /** #455: the station loses power (socket gone, transactions kept). */
  powerLoss(
    cpId: string,
    options?: PowerLossOptions,
  ): Promise<{ ok: true; transactions: number } | { ok: false; error: string }>;
  /** #455: power returns; the station boots and recovers its transactions. */
  powerRestore(
    cpId: string,
    options?: PowerRestoreOptions,
  ): Promise<
    | {
        ok: true;
        outageMs: number;
        recovery: "resume" | "end" | "none";
        transactions: number;
      }
    | { ok: false; error: string }
  >;

  // Lifecycle
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  reset(id: string): Promise<void>;
  sendHeartbeat(id: string): Promise<void>;
  startHeartbeat(id: string, intervalSeconds: number): Promise<void>;
  stopHeartbeat(id: string): Promise<void>;
  /** `idTokenType`: OCPP 2.x `IdToken.type`, default `ISO14443` (#599). */
  authorize(
    id: string,
    tagId: string,
    idTokenType?: IdTokenTypeName,
  ): Promise<void>;
  /** Station-initiated DataTransfer.req; resolves with the CSMS's answer
   *  (#348). `data`: string, or an object (JSON-encoded on 1.6). */
  sendDataTransfer(
    id: string,
    vendorId: string,
    messageId?: string,
    data?: DataTransferData,
  ): Promise<DataTransferResult>;
  /** Expert OCPP call (#389): any station-initiated CALL, payload as given;
   *  resolves with the CALLRESULT or CALLERROR. See
   *  `ChargePoint.sendOcppCall`. */
  sendOcppCall(id: string, request: OcppCallRequest): Promise<OcppCallOutcome>;
  /** OCPP 2.1 SEND (message type 6, #1096), e.g. NotifyPeriodicEventStream:
   *  unconfirmed, so it resolves once the frame is written. See
   *  `ChargePoint.sendOcppSend`. */
  sendOcppSend(id: string, request: OcppSendRequest): Promise<OcppSendOutcome>;
  /** Expert raw frame (#393): one text frame as given, valid OCPP-J or
   *  not. See `ChargePoint.sendRawFrame`. */
  sendRawFrame(id: string, request: RawFrameRequest): Promise<RawFrameOutcome>;
  /** Arm what the station answers a CSMS CALL of an action with (#1090): a
   *  CALLERROR, a raw payload or frame, a CALLRESULTERROR, a delay or
   *  silence, for the next CALL(s) of it. See `ChargePoint.setResponseOverride`. */
  setResponseOverride(
    id: string,
    request: ResponseOverrideRequest,
  ): Promise<{ action: string; mode: string }>;
  /** Drop the armed response overrides, or only the one for `action`;
   *  resolves with how many were dropped (#1090). */
  clearResponseOverrides(id: string, action?: string): Promise<number>;
  /** OCPP 2.1 CALLRESULTERROR (message type 5) for a CALLRESULT the station
   *  received (#1090). See `ChargePoint.sendCallResultError`. */
  sendCallResultError(
    id: string,
    request: CallResultErrorRequest,
  ): Promise<CallResultErrorOutcome>;
  /** 2.0.1 / 2.1 Get15118EVCertificate relay (#537): sends the EXI request
   *  as the EV would and resolves with the CSMS's answers. See
   *  `ChargePoint.get15118EVCertificate`. */
  get15118EVCertificate(
    id: string,
    request: Get15118EVCertificateRequest,
  ): Promise<Get15118EVCertificateResult>;
  /** The Authorization Cache and its switch (#452 test seam). */
  getAuthorizationCache(id: string): Promise<AuthorizationCacheView>;
  /** Write cache entries whatever the switch says (#452 test seam);
   *  resolves with the number written. Refused entries write nothing. */
  seedAuthorizationCache(
    id: string,
    entries: readonly AuthorizationCacheSeedEntry[],
  ): Promise<number>;
  /** Empty the cache whatever the switch says (#452 test seam); false when
   *  the stored copy could not be cleared. */
  clearAuthorizationCache(id: string): Promise<boolean>;

  // Connector operations
  startTransaction(
    id: string,
    connectorId: number,
    tagId: string,
    options?: StartTransactionCommandOptions,
  ): Promise<StartTransactionOutcome | void>;
  stopTransaction(
    id: string,
    connectorId: number,
    options?: StopTransactionCommandOptions,
  ): Promise<void>;
  /** Drive an OCPP 2.x TransactionEvent(Updated) on a running transaction
   *  (#335). No-op with a warning on OCPP 1.6. */
  sendTransactionUpdate(
    id: string,
    connectorId: number,
    options: TransactionUpdateOptions,
  ): Promise<void>;
  /** The EV side of the cable was unplugged (#488): with a running
   *  transaction, StopTransactionOnEVSideDisconnect stops it
   *  (`EVDisconnected`) or suspends it (SuspendedEV); without one the
   *  connector goes Available. */
  evDisconnected(id: string, connectorId: number): Promise<void>;
  /** A cable was plugged into the EV side of the connector (#453): an idle
   *  Available connector reports Preparing; any other state is unchanged. */
  evPlugIn(id: string, connectorId: number): Promise<void>;
  /** The EV asks for energy or stops asking (#453). With a running
   *  transaction "not ready" suspends it (SuspendedEV) and "ready" resumes
   *  Charging. Rejects when no cable is plugged in. */
  evSetReady(id: string, connectorId: number, ready: boolean): Promise<void>;
  sendStatusNotification(
    id: string,
    connectorId: number,
    status: OCPPStatus,
    opts?: StatusNotificationOptions,
  ): Promise<void>;
  // #377: the statuses are the domain vocabularies; untyped input is
  // narrowed where it enters, not cast here.
  sendDiagnosticsStatusNotification(
    id: string,
    status: DiagnosticsStatus,
  ): Promise<void>;
  sendFirmwareStatusNotification(
    id: string,
    status: FirmwareStatus,
    requestId?: number,
  ): Promise<void>;
  /** LogStatusNotification.req (#345). */
  sendLogStatusNotification(
    id: string,
    status: UploadLogStatus,
    requestId?: number,
  ): Promise<void>;
  sendSecurityEventNotification(
    id: string,
    type: string,
    techInfo?: string,
  ): Promise<void>;
  sendSignCertificate(id: string, csr?: string): Promise<void>;
  setMeterValue(id: string, connectorId: number, value: number): Promise<void>;
  sendMeterValue(
    id: string,
    connectorId: number,
    context?: MeterReadingContext,
  ): Promise<void>;
  removeConnector(id: string, connectorId: number): Promise<void>;

  // Connector settings
  /** A merge patch: absent keys keep their value, `null` removes one (#458). */
  setEVSettings(
    id: string,
    connectorId: number,
    settings: EVSettingsPatch,
  ): Promise<void>;
  getEVSettings(id: string, connectorId: number): Promise<EVSettings | null>;
  /**
   * Push the (new) Default EV Settings onto every existing connector. New
   * connectors already pick the default up at construction via
   * `getDefaultEVSettings()`; this propagates a mid-session change to the
   * connectors that are already live so the editor reflects it without a page
   * reload (#107).
   */
  applyDefaultEVSettings(settings: EVSettings): Promise<void>;
  setAutoMeterValueConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void>;
  getAutoMeterValueConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null>;
  getAutoMeterConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null>;
  saveAutoMeterConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void>;
  /** Seeded background traffic (#300). */
  setAutoTrafficConfig(
    id: string,
    connectorId: number,
    config: AutoTrafficConfig,
  ): Promise<void>;
  getAutoTrafficConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoTrafficConfig | null>;
  saveAutoTrafficConfig(
    id: string,
    connectorId: number,
    config: AutoTrafficConfig,
  ): Promise<void>;

  setAutoResetToAvailable(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void>;
  setConnectorMode(
    id: string,
    connectorId: number,
    mode: ScenarioMode,
  ): Promise<void>;
  /**
   * Override the connector's current State-of-Charge percentage. Pass null
   * to clear the SoC (so subsequent meter values don't carry the field).
   */
  setConnectorSoc(
    id: string,
    connectorId: number,
    soc: number | null,
  ): Promise<void>;
  /**
   * Enable/disable SoC ↔ Meter auto-sync for a connector. When on, any
   * meter-value update (UI, scenario auto-meter, etc.) derives a SoC value
   * from EV-settings (initialSoc + delivered_kWh / capacity_kWh × 100) and
   * pushes it into the connector. UI persists the preference through
   * `saveSocMeterSync`; pushing it down here makes it stick on every
   * connector instance.
   */
  setConnectorSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void>;
  getSocMeterSync(id: string, connectorId: number): Promise<boolean>;
  saveSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void>;
  getChargingProfiles(
    id: string,
    connectorId: number,
  ): Promise<ReadonlyArray<ActiveChargingProfile>>;

  // State history
  getStateHistory(
    id: string,
    options?: HistoryOptions,
  ): Promise<StateHistoryEntry[]>;

  // Scenarios
  listScenarioDefinitions(
    id: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition[]>;
  saveScenarioDefinition(
    id: string,
    connectorId: number | null,
    definition: ScenarioDefinition,
  ): Promise<ScenarioDefinition>;
  replaceConnectorScenarioDefinitions(
    id: string,
    connectorId: number | null,
    definitions: readonly ScenarioDefinition[],
  ): Promise<ScenarioDefinition[]>;
  deleteScenarioDefinition(
    id: string,
    connectorId: number | null,
    definitionId: string,
  ): Promise<void>;
  subscribeScenarioDefinitions(
    id: string,
    connectorId: number | null,
    handler: (definitions: ScenarioDefinition[]) => void,
  ): () => void;
  getScenarioTemplates(): Promise<ScenarioTemplateInfo[]>;
  loadScenarioTemplate(
    id: string,
    templateId: string,
    connectorId: number,
    evSettings?: Partial<EVSettings>,
  ): Promise<{ scenarioId: string }>;
  loadScenario(
    id: string,
    connectorId: number,
    definition: ScenarioDefinition,
  ): Promise<{ scenarioId: string }>;
  listScenarios(id: string, connectorId: number): Promise<ScenarioListItem[]>;
  runScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void>;
  runScenarioFile(
    id: string,
    path: string,
    opts?: ScenarioRunOptions,
  ): Promise<{ scenarioId: string }>;
  runScenarioTemplate(
    id: string,
    templateId: string,
    opts?: ScenarioRunOptions,
  ): Promise<{ scenarioId: string }>;
  stopScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void>;
  resetScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void>;
  stepScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
    force?: boolean,
  ): Promise<void>;
  /** #240: push the parked wait's deadline back by `seconds`. Rejects when
   *  the run is not running, not waiting, or its wait has no timeout. */
  extendScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
    seconds: number,
  ): Promise<void>;
  /** #240: withdraw the parked wait and arm it again with its full timeout. */
  retryScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void>;
  /** #240: move past the parked wait without the awaited event. */
  continueScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void>;
  stopAllScenarios(id: string, connectorId: number): Promise<void>;
  /** Drop a single scenario from the runtime + persistence. Used by the
   *  editor when the operator switches templates so stale ones don't
   *  keep coming back on next reload. */
  removeScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void>;
  getScenarioStatus(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioExecutionContext | null>;
  /**
   * #179 Phase 3: the machine-readable certification report for a finished
   * scenario run — verdict, assertion results, correlated transcript, and
   * initial/final state snapshots. `runId` omitted returns the latest run.
   * Null when no run has finished (or in local mode, which has no run-report
   * machinery — only the headless/CLI service records reports).
   */
  getScenarioReport(
    id: string,
    connectorId: number,
    scenarioId: string,
    runId?: string,
  ): Promise<ScenarioRunResult | null>;
  /**
   * Returns the loaded scenario definition (or null) for a given connector
   * + scenarioId. Lets the browser inspect scenarios that the server
   * loaded out-of-band (e.g. via `--scenario-template-file`).
   */
  getScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioDefinition | null>;

  // Event subscription
  subscribe(id: string, handler: (event: ChargePointEvent) => void): () => void;
}
