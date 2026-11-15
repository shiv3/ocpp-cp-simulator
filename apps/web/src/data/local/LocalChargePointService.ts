import {
  type ConfigurationKeyList,
  type ConfigurationSetStatus,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/configurationAccess";
import { VehicleProfileRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/VehicleProfileRepository";
import type {
  AuthorizationCacheSeedEntry,
  AuthorizationCacheView,
} from "@ocpp-cp-simulator/core/cp/domain/auth/AuthorizationCacheSeed";
import type { VehicleProfile } from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleProfile";
import {
  type DiagnosticsStatus,
  type FirmwareStatus,
  type UploadLogStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/FirmwareLogStatus";
import type {
  FleetCreateParams,
  FleetCreateResult,
  FleetTemplate,
} from "@ocpp-cp-simulator/contracts/methods";
import { getDefaultStore } from "jotai";
import type {
  DataTransferData,
  DataTransferResult,
} from "@ocpp-cp-simulator/core/cp/domain/types/DataTransfer";
import type {
  OcppCallOutcome,
  OcppCallRequest,
  RawFrameOutcome,
  RawFrameRequest,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppCall";
import type {
  Get15118EVCertificateRequest,
  Get15118EVCertificateResult,
} from "@ocpp-cp-simulator/core/cp/domain/security/get15118EVCertificate";
import {
  type PowerLossOptions,
  type PowerRestoreOptions,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import { runModemCommand } from "@ocpp-cp-simulator/core/cp/domain/modem/index";
import type { ModemCommand as ModemCommandInput } from "@ocpp-cp-simulator/contracts/modem";
import {
  type MeterReadingContext,
  type StartTransactionCommandOptions,
  type IdTokenTypeName,
  type StopTransactionCommandOptions,
  type TransactionUpdateOptions,
} from "@ocpp-cp-simulator/core/cp/domain/connector/Transaction";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { resetSimulatorState } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/resetState";
import type { LocalScenarioRuntime } from "./LocalScenarioRuntime";
import {
  attachLocalEventForwarders,
  type LocalEventForwardersHost,
} from "./localEventForwarders";
import { toChargePointSnapshot } from "./snapshotMapping";
import type { ScenarioRunRepository } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRepository";
import { createScenarioRunRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/createScenarioRunRepository";
import type {
  ScenarioRunPage,
  ScenarioRunQuery,
} from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunSummary";
import { SqliteScenarioRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/SqliteScenarioRepository";
import type { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import { type StatusNotificationOptions } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type {
  ChargePointEvent,
  ChargePointService,
  ChargePointSnapshot,
  ScenarioRunOptions,
  ScenarioListItem,
  ScenarioTemplateInfo,
  StoredLogEntry,
} from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import type { ConfigRepository } from "@ocpp-cp-simulator/client/interfaces/ConfigRepository";
import type { ConnectorSettingsRepository } from "@ocpp-cp-simulator/client/interfaces/ConnectorSettingsRepository";
import {
  BROWSER_AUTO_TRAFFIC_UNSUPPORTED_MESSAGE,
  BROWSER_FLEET_TEMPLATES_UNSUPPORTED_MESSAGE,
  BROWSER_LABELS_UNSUPPORTED_MESSAGE,
  UnsupportedFeatureError,
} from "@ocpp-cp-simulator/client/interfaces/UnsupportedFeatureError";
import {
  type EVSettings,
  type EVSettingsPatch,
} from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { AutoTrafficConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioMode,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ScenarioRunResult } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioAssertions";
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import type {
  TimelinePage,
  TimelineQuery,
} from "@ocpp-cp-simulator/core/cp/application/services/OperationalTimeline";
import type {
  ChargingSessionPage,
  ChargingSessionQuery,
  ChargingSessionRepository,
} from "@ocpp-cp-simulator/core/cp/domain/persistence/ChargingSessionRepository";
import { createChargingSessionRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/createChargingSessionRepository";
import type {
  NetworkSimLayerConfig,
  ResolvedNetworkSimConfig,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import { networkSimAtom, type NetworkSimStore } from "../../store/store";
import {
  getNetworkSimCp,
  getNetworkSimGlobal,
  getResolvedFor,
  readNetworkSimStore,
  reapplyToAllLiveCps,
  saveNetworkSimCp,
  saveNetworkSimGlobal,
  triggerNetworkSimDisconnect,
  type LocalNetworkSimHost,
} from "./localNetworkSim";
import { powerLoss, powerRestore } from "./localPower";
import { SqliteConfigRepository } from "../sqlite/SqliteConfigRepository";
import { SqliteConnectorSettingsRepository } from "@ocpp-cp-simulator/client/sqlite/SqliteConnectorSettingsRepository";
import type {
  Labels,
  SimulatorConfigInput,
  WireSimulatorConfig,
} from "@ocpp-cp-simulator/contracts/index";
import { mergeWriteOnlyConfigSecrets } from "@ocpp-cp-simulator/client/configPort";

import {
  reset,
  sendHeartbeat,
  startHeartbeat,
  stopHeartbeat,
  authorize,
  sendDataTransfer,
  sendOcppCall,
  sendRawFrame,
  get15118EVCertificate,
  getAuthorizationCache,
  seedAuthorizationCache,
  clearAuthorizationCache,
  startTransaction,
  stopTransaction,
  sendTransactionUpdate,
  evDisconnected,
  evPlugIn,
  evSetReady,
  sendStatusNotification,
  sendDiagnosticsStatusNotification,
  sendFirmwareStatusNotification,
  sendLogStatusNotification,
  sendSecurityEventNotification,
  sendSignCertificate,
  setMeterValue,
  sendMeterValue,
  removeConnector,
} from "./localCpCommands";
import {
  setEVSettings,
  getEVSettings,
  applyDefaultEVSettings,
  setAutoMeterValueConfig,
  getAutoMeterValueConfig,
  getAutoMeterConfig,
  saveAutoMeterConfig,
  setAutoResetToAvailable,
  setConnectorMode,
  setConnectorSoc,
  setConnectorSocMeterSync,
  getSocMeterSync,
  saveSocMeterSync,
  getChargingProfiles,
  getStateHistory,
  getOperationalTimeline,
  listChargingSessions,
  getConfigurationKeys,
  setConfigurationKey,
} from "./localConnectorOps";
import {
  getScenarioTemplates,
  listScenarioDefinitions,
  saveScenarioDefinition,
  replaceConnectorScenarioDefinitions,
  deleteScenarioDefinition,
  subscribeScenarioDefinitions,
  loadScenarioTemplate,
  loadScenario,
  listScenarios,
  runScenario,
  runScenarioFile,
  runScenarioTemplate,
  stopScenario,
  resetScenario,
  stepScenario,
  extendScenarioWait,
  retryScenarioWait,
  continueScenarioWait,
  stopAllScenarios,
  removeScenario,
  getScenarioStatus,
  getScenarioReport,
  listScenarioRuns,
  getScenario,
  createScenarioRuntime,
} from "./localScenarios";
import {
  getExistingChargePointOrThrow,
  type LocalServiceHost,
} from "./localHost";
import {
  assertBrowserLocalTlsSupported,
  buildChargePoint,
  type LocalChargePointDefinition,
} from "./localBuildChargePoint";
import { loadBehaviorBundleInto } from "./localBehaviorBundle";

export type { LocalChargePointDefinition };

export class LocalChargePointService implements ChargePointService {
  private readonly chargePoints = new Map<string, ChargePoint>();
  private readonly listeners = new Map<
    string,
    Set<(event: ChargePointEvent) => void>
  >();
  private readonly eventSubscriptions = new Map<string, Array<() => void>>();
  private readonly scenarioRuntimes = new Map<string, LocalScenarioRuntime>();

  /** SQLite-backed persistence for ConfigurationStore, PendingMessageQueue,
   *  and per-connector availability. Passed through to every ChargePoint we
   *  build. `null` keeps everything in-memory (test / boot-before-DB). */
  private readonly configRepository: ConfigRepository;
  private readonly connectorSettingsRepository: ConnectorSettingsRepository;
  private readonly scenarioRepository: SqliteScenarioRepository;
  private readonly vehicleProfiles: VehicleProfileRepository;
  /** #447: the browser's sql.js `charging_sessions` table, or in memory. */
  private readonly chargingSessions: ChargingSessionRepository;
  /** #394: the browser's sql.js `scenario_runs` table, or in memory. */
  private readonly scenarioRuns: ScenarioRunRepository;
  private readonly forwardersHost: LocalEventForwardersHost;
  private readonly simHost: LocalNetworkSimHost;
  private readonly localHost: LocalServiceHost;

  constructor(
    private readonly database: Database | null = null,
    private readonly store = getDefaultStore(),
  ) {
    this.configRepository = new SqliteConfigRepository(database);
    this.connectorSettingsRepository = new SqliteConnectorSettingsRepository(
      database,
    );
    this.scenarioRepository = new SqliteScenarioRepository(database);
    this.vehicleProfiles = new VehicleProfileRepository(database);
    this.chargingSessions = createChargingSessionRepository(database);
    this.scenarioRuns = createScenarioRunRepository(database);
    this.forwardersHost = {
      database,
      chargingSessions: this.chargingSessions,
      emit: (id, event) => this.emit(id, event),
    };

    this.simHost = { store: this.store, chargePoints: this.chargePoints };
    this.localHost = {
      chargePoints: this.chargePoints,
      scenarioRuntimes: this.scenarioRuntimes,
      database,
      scenarioRepository: this.scenarioRepository,
      scenarioRuns: this.scenarioRuns,
      chargingSessions: this.chargingSessions,
      connectorSettingsRepository: this.connectorSettingsRepository,
    };

    // Subscribe to networkSim atom changes for live re-apply
    this.store.sub(networkSimAtom, () => {
      this.reapplyToAllLiveCps();
    });
  }

  registerChargePoint(chargePoint: ChargePoint): void {
    if (this.chargePoints.has(chargePoint.id)) {
      this.unregisterChargePoint(chargePoint.id);
    }

    this.chargePoints.set(chargePoint.id, chargePoint);
    this.attachEventForwarders(chargePoint);
    this.scenarioRuntimes.set(
      chargePoint.id,
      createScenarioRuntime(this.localHost, chargePoint, (id, event) =>
        this.emit(id, event),
      ),
    );
  }

  /**
   * Load a built behavior bundle (`ocpp-cp-sim behavior build`) into one
   * registered charge point of this page and return the ids it registered.
   * The code runs with the full authority of the page: it comes from a file
   * the user picked, never from the network. The bundle is a Blob (or its
   * text); it is imported through a blob URL, which is revoked afterwards.
   * Behaviors are not persisted: reload the page and load them again.
   *
   * Calling it again with a bundle whose behavior id is already loaded on
   * that charge point replaces that behavior (a reload), under the engine's
   * rules: new CALLs use the new code, exchanges in flight finish on the old
   * one, `ctx.state` stays, a running `main` is asked to stop and gets a grace
   * time before the new `main` starts. A version the station cannot take
   * leaves everything as it was.
   */
  async loadBehaviorBundle(
    id: string,
    bundle: Blob | string,
  ): Promise<string[]> {
    return loadBehaviorBundleInto(
      this.getExistingChargePointOrThrow(id),
      bundle,
    );
  }

  /** Unload a behavior loaded with {@link loadBehaviorBundle}. */
  unloadBehavior(id: string, behaviorId: string): boolean {
    return this.getExistingChargePointOrThrow(id).unloadBehavior(behaviorId);
  }

  unregisterChargePoint(id: string): void {
    const cp = this.chargePoints.get(id);
    this.scenarioRuntimes.get(id)?.dispose();
    this.scenarioRuntimes.delete(id);
    if (cp) {
      cp.disconnect();
    }
    this.chargePoints.delete(id);

    const subs = this.eventSubscriptions.get(id);
    if (subs) {
      subs.forEach((unsubscribe) => {
        try {
          unsubscribe();
        } catch (error) {
          console.error(
            `[LocalChargePointService] Failed to unsubscribe listener for ${id}`,
            error,
          );
        }
      });
      this.eventSubscriptions.delete(id);
    }

    this.listeners.delete(id);

    // Clean up per-CP networkSim config when CP is removed
    const store = this.readNetworkSimStore();
    if (store.perCp[id]) {
      const newPerCp = { ...store.perCp };
      delete newPerCp[id];
      this.store.set(networkSimAtom, { ...store, perCp: newPerCp });
    }
  }

  listChargePoints(): Promise<ChargePointSnapshot[]> {
    const snapshots = Array.from(this.chargePoints.values()).map((cp) =>
      toChargePointSnapshot(cp),
    );
    return Promise.resolve(snapshots);
  }

  getChargePoint(id: string): Promise<ChargePointSnapshot | null> {
    const cp = this.chargePoints.get(id);
    return Promise.resolve(cp ? toChargePointSnapshot(cp) : null);
  }

  getChargePointHandle(id: string): ChargePoint | null {
    return this.chargePoints.get(id) ?? null;
  }

  getLocalChargePoint(id: string): ChargePoint | null {
    return this.getChargePointHandle(id);
  }

  async resetAllState(): Promise<void> {
    // Disconnect and forget every in-memory CP first so they don't write
    // back to the DB while we're truncating it. The follow-up UI reload
    // will rebuild them from the (now empty) Config + scenario tables.
    const ids = Array.from(this.chargePoints.keys());
    for (const id of ids) this.unregisterChargePoint(id);
    // Also reaches the in-memory stores a service without a database keeps.
    this.vehicleProfiles.clear();
    this.chargingSessions.clear();
    this.scenarioRuns.clear();
    if (this.database) {
      resetSimulatorState(this.database);
      await this.database.flush?.();
    }

    // Clear the networkSim atom to reset all network-sim configuration
    this.store.set(networkSimAtom, { version: 1, global: null, perCp: {} });
  }

  async listVehicleProfiles(): Promise<VehicleProfile[]> {
    return this.vehicleProfiles.list();
  }

  async saveVehicleProfile(profile: VehicleProfile): Promise<VehicleProfile> {
    const stored = this.vehicleProfiles.save(profile);
    await this.database?.flush?.();
    return stored;
  }

  async deleteVehicleProfile(id: string): Promise<void> {
    if (!this.vehicleProfiles.delete(id)) {
      throw new Error(`vehicle profile not found: ${id}`);
    }
    await this.database?.flush?.();
  }

  async clearStoredLogs(cpId: string): Promise<void> {
    if (!this.database) return;
    this.database.run("DELETE FROM logs WHERE cp_id = ?", [cpId]);
    await this.database.flush?.();
  }

  async listStoredLogs(cpId: string): Promise<StoredLogEntry[]> {
    if (!this.database) return [];
    // Flush any pending in-memory log writes so the download includes the
    // last seconds of activity the buffered LogRepository hasn't pushed
    // out yet.
    const cp = this.chargePoints.get(cpId);
    cp?.flushLogs();
    const rows = this.database.all<{
      timestamp: string;
      level: string;
      log_type: string;
      message: string;
    }>(
      "SELECT timestamp, level, log_type, message FROM logs " +
        "WHERE cp_id = ? ORDER BY id ASC",
      [cpId],
    );
    return rows.map((r) => ({
      timestamp: r.timestamp,
      level: r.level,
      type: r.log_type,
      cpId,
      message: r.message,
    }));
  }

  async loadConfig(): Promise<WireSimulatorConfig | null> {
    return this.configRepository.load();
  }

  async saveConfig(config: SimulatorConfigInput | null): Promise<void> {
    const existing = await this.configRepository.load();
    await this.configRepository.save(
      mergeWriteOnlyConfigSecrets(config, existing),
    );
  }

  subscribeConfig(
    handler: (config: WireSimulatorConfig | null) => void,
  ): () => void {
    return this.configRepository.subscribe(handler);
  }

  async connect(id: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).connect();
    // Remember the operator's intent so a reload re-connects this CP
    // automatically. The actual WebSocket may not be open yet (open is
    // async, may fail) — that's fine, the next boot will retry.
    this.setDesiredConnected(id, true);
  }

  async disconnect(id: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).disconnect();
    this.setDesiredConnected(id, false);
  }

  private setDesiredConnected(id: string, desired: boolean): void {
    if (!this.database) return;
    this.database.run(
      "INSERT INTO charge_point_state (cp_id, desired_connected, updated_at) " +
        "VALUES (?, ?, ?) " +
        "ON CONFLICT (cp_id) DO UPDATE SET " +
        "  desired_connected = excluded.desired_connected, " +
        "  updated_at = excluded.updated_at",
      [id, desired ? 1 : 0, new Date().toISOString()],
    );
  }

  /** Re-issue connect() for every CP the operator previously had
   *  connected. Called after `syncLocalChargePoints` so the CP instances
   *  exist. Skips CPs whose WebSocket is already open — useChargePoints
   *  re-runs on config changes and we don't want to orphan an existing
   *  socket by issuing a duplicate connect. */
  async restoreConnections(): Promise<void> {
    if (!this.database) return;
    const rows = this.database.all<{ cp_id: string }>(
      "SELECT cp_id FROM charge_point_state WHERE desired_connected = 1",
    );
    for (const { cp_id } of rows) {
      const cp = this.chargePoints.get(cp_id);
      if (!cp || cp.isWebSocketConnected) continue;
      cp.connect();
    }
  }

  async reset(id: string): Promise<void> {
    return reset(this.localHost, id);
  }

  async sendHeartbeat(id: string): Promise<void> {
    return sendHeartbeat(this.localHost, id);
  }

  async startHeartbeat(id: string, intervalSeconds: number): Promise<void> {
    return startHeartbeat(this.localHost, id, intervalSeconds);
  }

  async stopHeartbeat(id: string): Promise<void> {
    return stopHeartbeat(this.localHost, id);
  }

  async authorize(
    id: string,
    tagId: string,
    idTokenType?: IdTokenTypeName,
  ): Promise<void> {
    return authorize(this.localHost, id, tagId, idTokenType);
  }

  async sendDataTransfer(
    id: string,
    vendorId: string,
    messageId?: string,
    data?: DataTransferData,
  ): Promise<DataTransferResult> {
    return sendDataTransfer(this.localHost, id, vendorId, messageId, data);
  }

  async sendOcppCall(
    id: string,
    request: OcppCallRequest,
  ): Promise<OcppCallOutcome> {
    return sendOcppCall(this.localHost, id, request);
  }

  async sendRawFrame(
    id: string,
    request: RawFrameRequest,
  ): Promise<RawFrameOutcome> {
    return sendRawFrame(this.localHost, id, request);
  }

  async get15118EVCertificate(
    id: string,
    request: Get15118EVCertificateRequest,
  ): Promise<Get15118EVCertificateResult> {
    return get15118EVCertificate(this.localHost, id, request);
  }

  async getAuthorizationCache(id: string): Promise<AuthorizationCacheView> {
    return getAuthorizationCache(this.localHost, id);
  }

  async seedAuthorizationCache(
    id: string,
    entries: readonly AuthorizationCacheSeedEntry[],
  ): Promise<number> {
    return seedAuthorizationCache(this.localHost, id, entries);
  }

  async clearAuthorizationCache(id: string): Promise<boolean> {
    return clearAuthorizationCache(this.localHost, id);
  }

  async startTransaction(
    id: string,
    connectorId: number,
    tagId: string,
    options: StartTransactionCommandOptions = {},
  ): Promise<void> {
    return startTransaction(this.localHost, id, connectorId, tagId, options);
  }

  async stopTransaction(
    id: string,
    connectorId: number,
    options: StopTransactionCommandOptions = {},
  ): Promise<void> {
    return stopTransaction(this.localHost, id, connectorId, options);
  }

  async sendTransactionUpdate(
    id: string,
    connectorId: number,
    options: TransactionUpdateOptions,
  ): Promise<void> {
    return sendTransactionUpdate(this.localHost, id, connectorId, options);
  }

  async evDisconnected(id: string, connectorId: number): Promise<void> {
    return evDisconnected(this.localHost, id, connectorId);
  }

  async evPlugIn(id: string, connectorId: number): Promise<void> {
    return evPlugIn(this.localHost, id, connectorId);
  }

  async evSetReady(
    id: string,
    connectorId: number,
    ready: boolean,
  ): Promise<void> {
    return evSetReady(this.localHost, id, connectorId, ready);
  }

  async sendStatusNotification(
    id: string,
    connectorId: number,
    status: OCPPStatus,
    opts?: StatusNotificationOptions,
  ): Promise<void> {
    return sendStatusNotification(
      this.localHost,
      id,
      connectorId,
      status,
      opts,
    );
  }

  async sendDiagnosticsStatusNotification(
    id: string,
    status: DiagnosticsStatus,
  ): Promise<void> {
    return sendDiagnosticsStatusNotification(this.localHost, id, status);
  }

  async sendFirmwareStatusNotification(
    id: string,
    status: FirmwareStatus,
    requestId?: number,
  ): Promise<void> {
    return sendFirmwareStatusNotification(
      this.localHost,
      id,
      status,
      requestId,
    );
  }

  async sendLogStatusNotification(
    id: string,
    status: UploadLogStatus,
    requestId?: number,
  ): Promise<void> {
    return sendLogStatusNotification(this.localHost, id, status, requestId);
  }

  async sendSecurityEventNotification(
    id: string,
    type: string,
    techInfo?: string,
  ): Promise<void> {
    return sendSecurityEventNotification(this.localHost, id, type, techInfo);
  }

  async sendSignCertificate(id: string, csr?: string): Promise<void> {
    return sendSignCertificate(this.localHost, id, csr);
  }

  async setMeterValue(
    id: string,
    connectorId: number,
    value: number,
  ): Promise<void> {
    return setMeterValue(this.localHost, id, connectorId, value);
  }

  async sendMeterValue(
    id: string,
    connectorId: number,
    context?: MeterReadingContext,
  ): Promise<void> {
    return sendMeterValue(this.localHost, id, connectorId, context);
  }

  async removeConnector(id: string, connectorId: number): Promise<void> {
    return removeConnector(this.localHost, id, connectorId);
  }

  async setEVSettings(
    id: string,
    connectorId: number,
    settings: EVSettingsPatch,
  ): Promise<void> {
    return setEVSettings(this.localHost, id, connectorId, settings);
  }

  async getEVSettings(
    id: string,
    connectorId: number,
  ): Promise<EVSettings | null> {
    return getEVSettings(this.localHost, id, connectorId);
  }

  async applyDefaultEVSettings(settings: EVSettingsPatch): Promise<void> {
    return applyDefaultEVSettings(this.localHost, settings);
  }

  async setAutoMeterValueConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    return setAutoMeterValueConfig(this.localHost, id, connectorId, config);
  }

  async getAutoMeterValueConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    return getAutoMeterValueConfig(this.localHost, id, connectorId);
  }

  async getAutoMeterConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    return getAutoMeterConfig(this.localHost, id, connectorId);
  }

  async saveAutoMeterConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    return saveAutoMeterConfig(this.localHost, id, connectorId, config);
  }

  /** Only the daemon runs AutoTrafficRunner (#300): refuse rather than
   *  report a success that would generate no traffic (#374). */
  async setAutoTrafficConfig(
    _id: string,
    _connectorId: number,
    _config: AutoTrafficConfig,
  ): Promise<void> {
    throw new UnsupportedFeatureError(
      "browser_auto_traffic_unsupported",
      BROWSER_AUTO_TRAFFIC_UNSUPPORTED_MESSAGE,
    );
  }

  /** Labels (#446) belong to daemon charge points (#471): refuse rather
   *  than report a relabel that stored nothing. */
  async setChargePointLabels(_cpId: string, _labels: Labels): Promise<void> {
    throw new UnsupportedFeatureError(
      "browser_labels_unsupported",
      BROWSER_LABELS_UNSUPPORTED_MESSAGE,
    );
  }

  /** Fleet templates (#445) are stored by the daemon: refuse rather than
   *  show an empty list that could never be filled. */
  private fleetTemplatesUnsupported(): never {
    throw new UnsupportedFeatureError(
      "browser_fleet_templates_unsupported",
      BROWSER_FLEET_TEMPLATES_UNSUPPORTED_MESSAGE,
    );
  }

  async listFleetTemplates(): Promise<FleetTemplate[]> {
    return this.fleetTemplatesUnsupported();
  }

  async getFleetTemplate(_id: string): Promise<FleetTemplate> {
    return this.fleetTemplatesUnsupported();
  }

  async saveFleetTemplate(_template: FleetTemplate): Promise<string> {
    return this.fleetTemplatesUnsupported();
  }

  async deleteFleetTemplate(_id: string): Promise<void> {
    return this.fleetTemplatesUnsupported();
  }

  async createFleet(_params: FleetCreateParams): Promise<FleetCreateResult> {
    return this.fleetTemplatesUnsupported();
  }

  async getAutoTrafficConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoTrafficConfig | null> {
    return this.connectorSettingsRepository.loadAutoTrafficConfig(
      id,
      connectorId,
    );
  }

  async saveAutoTrafficConfig(
    id: string,
    connectorId: number,
    config: AutoTrafficConfig,
  ): Promise<void> {
    return this.setAutoTrafficConfig(id, connectorId, config);
  }

  async setAutoResetToAvailable(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    return setAutoResetToAvailable(this.localHost, id, connectorId, enabled);
  }

  async setConnectorMode(
    id: string,
    connectorId: number,
    mode: ScenarioMode,
  ): Promise<void> {
    return setConnectorMode(this.localHost, id, connectorId, mode);
  }

  async setConnectorSoc(
    id: string,
    connectorId: number,
    soc: number | null,
  ): Promise<void> {
    return setConnectorSoc(this.localHost, id, connectorId, soc);
  }

  async setConnectorSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    return setConnectorSocMeterSync(this.localHost, id, connectorId, enabled);
  }

  async getSocMeterSync(_id: string, _connectorId: number): Promise<boolean> {
    return getSocMeterSync(this.localHost, _id, _connectorId);
  }

  async saveSocMeterSync(
    _id: string,
    _connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    return saveSocMeterSync(this.localHost, _id, _connectorId, enabled);
  }

  async getChargingProfiles(
    id: string,
    connectorId: number,
  ): Promise<ReadonlyArray<ActiveChargingProfile>> {
    return getChargingProfiles(this.localHost, id, connectorId);
  }

  async getStateHistory(
    id: string,
    options?: HistoryOptions,
  ): Promise<StateHistoryEntry[]> {
    return getStateHistory(this.localHost, id, options);
  }

  async getOperationalTimeline(
    id: string,
    query?: TimelineQuery,
  ): Promise<TimelinePage> {
    return getOperationalTimeline(this.localHost, id, query);
  }

  async listChargingSessions(
    id: string,
    query: Omit<ChargingSessionQuery, "cpId"> = {},
  ): Promise<ChargingSessionPage> {
    return listChargingSessions(this.localHost, id, query);
  }

  async getConfigurationKeys(
    id: string,
    keys: readonly string[] = [],
  ): Promise<ConfigurationKeyList> {
    return getConfigurationKeys(this.localHost, id, keys);
  }

  async setConfigurationKey(
    id: string,
    key: string,
    value: string,
  ): Promise<ConfigurationSetStatus> {
    return setConfigurationKey(this.localHost, id, key, value);
  }

  async getScenarioTemplates(): Promise<ScenarioTemplateInfo[]> {
    return getScenarioTemplates(this.localHost);
  }

  async listScenarioDefinitions(
    id: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition[]> {
    return listScenarioDefinitions(this.localHost, id, connectorId);
  }

  async saveScenarioDefinition(
    id: string,
    connectorId: number | null,
    definition: ScenarioDefinition,
  ): Promise<ScenarioDefinition> {
    return saveScenarioDefinition(this.localHost, id, connectorId, definition);
  }

  async replaceConnectorScenarioDefinitions(
    id: string,
    connectorId: number | null,
    definitions: readonly ScenarioDefinition[],
  ): Promise<ScenarioDefinition[]> {
    return replaceConnectorScenarioDefinitions(
      this.localHost,
      id,
      connectorId,
      definitions,
    );
  }

  async deleteScenarioDefinition(
    id: string,
    connectorId: number | null,
    definitionId: string,
  ): Promise<void> {
    return deleteScenarioDefinition(
      this.localHost,
      id,
      connectorId,
      definitionId,
    );
  }

  subscribeScenarioDefinitions(
    id: string,
    connectorId: number | null,
    handler: (definitions: ScenarioDefinition[]) => void,
  ): () => void {
    return subscribeScenarioDefinitions(
      this.localHost,
      id,
      connectorId,
      handler,
    );
  }

  async loadScenarioTemplate(
    id: string,
    templateId: string,
    connectorId: number,
    evSettings?: Partial<EVSettings>,
  ): Promise<{ scenarioId: string }> {
    return loadScenarioTemplate(
      this.localHost,
      id,
      templateId,
      connectorId,
      evSettings,
    );
  }

  async loadScenario(
    id: string,
    connectorId: number,
    definition: ScenarioDefinition,
  ): Promise<{ scenarioId: string }> {
    return loadScenario(this.localHost, id, connectorId, definition);
  }

  async listScenarios(
    id: string,
    connectorId: number,
  ): Promise<ScenarioListItem[]> {
    return listScenarios(this.localHost, id, connectorId);
  }

  async runScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    return runScenario(this.localHost, id, connectorId, scenarioId);
  }

  async runScenarioFile(
    _id: string,
    _path: string,
    _opts?: ScenarioRunOptions,
  ): Promise<{ scenarioId: string }> {
    return runScenarioFile(this.localHost, _id, _path, _opts);
  }

  async runScenarioTemplate(
    id: string,
    templateId: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    return runScenarioTemplate(this.localHost, id, templateId, opts);
  }

  async stopScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    return stopScenario(this.localHost, id, connectorId, scenarioId);
  }

  async resetScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    return resetScenario(this.localHost, id, connectorId, scenarioId);
  }

  async stepScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
    force = false,
  ): Promise<void> {
    return stepScenario(this.localHost, id, connectorId, scenarioId, force);
  }

  async extendScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
    seconds: number,
  ): Promise<void> {
    return extendScenarioWait(
      this.localHost,
      id,
      connectorId,
      scenarioId,
      seconds,
    );
  }

  async retryScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    return retryScenarioWait(this.localHost, id, connectorId, scenarioId);
  }

  async continueScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    return continueScenarioWait(this.localHost, id, connectorId, scenarioId);
  }

  /** The browser scenario runtime of charge point `id`, while registered. */
  getScenarioRuntime(id: string): LocalScenarioRuntime | undefined {
    return this.scenarioRuntimes.get(id);
  }

  async stopAllScenarios(id: string, connectorId: number): Promise<void> {
    return stopAllScenarios(this.localHost, id, connectorId);
  }

  async removeScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    return removeScenario(this.localHost, id, connectorId, scenarioId);
  }

  async getScenarioStatus(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioExecutionContext | null> {
    return getScenarioStatus(this.localHost, id, connectorId, scenarioId);
  }

  async getScenarioReport(
    id: string,
    _connectorId: number,
    scenarioId: string,
    runId?: string,
  ): Promise<ScenarioRunResult | null> {
    return getScenarioReport(
      this.localHost,
      id,
      _connectorId,
      scenarioId,
      runId,
    );
  }

  /** #394: the run history, paged like the daemon's `scenario.runs.list`. */
  async listScenarioRuns(query: ScenarioRunQuery): Promise<ScenarioRunPage> {
    return listScenarioRuns(this.localHost, query);
  }

  async getScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioDefinition | null> {
    return getScenario(this.localHost, id, connectorId, scenarioId);
  }

  subscribe(
    id: string,
    handler: (event: ChargePointEvent) => void,
  ): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(handler);
    this.listeners.set(id, listeners);

    const cp = this.chargePoints.get(id);
    if (cp) {
      handler({ type: "status", status: cp.status });
      if (cp.error) {
        handler({ type: "error", error: cp.error });
      }
    }

    return () => {
      const current = this.listeners.get(id);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.listeners.delete(id);
      }
    };
  }

  private readNetworkSimStore(): NetworkSimStore {
    return readNetworkSimStore(this.simHost);
  }

  private getResolvedFor(cpId: string): ResolvedNetworkSimConfig {
    return getResolvedFor(this.simHost, cpId);
  }

  private reapplyToAllLiveCps(): void {
    reapplyToAllLiveCps(this.simHost);
  }

  async getNetworkSimGlobal(): Promise<NetworkSimLayerConfig | null> {
    return getNetworkSimGlobal(this.simHost);
  }

  async saveNetworkSimGlobal(
    config: NetworkSimLayerConfig | null,
  ): Promise<void> {
    return saveNetworkSimGlobal(this.simHost, config);
  }

  async getNetworkSimCp(cpId: string): Promise<{
    config: NetworkSimLayerConfig | null;
    resolved: ResolvedNetworkSimConfig;
  }> {
    return getNetworkSimCp(this.simHost, cpId);
  }

  async saveNetworkSimCp(
    cpId: string,
    config: NetworkSimLayerConfig | null,
  ): Promise<void> {
    return saveNetworkSimCp(this.simHost, cpId, config);
  }

  async triggerNetworkSimDisconnect(
    cpId: string,
    ruleId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return triggerNetworkSimDisconnect(this.simHost, cpId, ruleId);
  }

  async getModem(cpId: string) {
    const cp = this.chargePoints.get(cpId);
    if (!cp) return { ok: false as const, error: "cp_not_found" };
    if (!cp.modem) return { ok: false as const, error: "no_modem_model" };
    return { ok: true as const, modem: cp.modemState()! };
  }

  async modemCommand(cpId: string, command: ModemCommandInput) {
    const cp = this.chargePoints.get(cpId);
    if (!cp) return { ok: false as const, error: "cp_not_found" };
    return runModemCommand(cp.modem, command, () => cp.modemState()!);
  }

  async powerLoss(
    cpId: string,
    options?: PowerLossOptions,
  ): Promise<
    { ok: true; transactions: number } | { ok: false; error: string }
  > {
    return powerLoss(this.simHost, cpId, options);
  }

  async powerRestore(cpId: string, options?: PowerRestoreOptions) {
    return powerRestore(this.simHost, cpId, options);
  }

  private getExistingChargePointOrThrow(id: string): ChargePoint {
    return getExistingChargePointOrThrow(this.chargePoints, id);
  }

  /**
   * Make the registered charge points match `definitions`. A charge point that
   * drops out is released (its connections close). Its stored run history
   * survives unless `options.forget` is set: that is for a removal from the
   * saved configuration, not for entering Remote mode or an empty config
   * that has not loaded (#394).
   */
  async syncLocalChargePoints(
    definitions: LocalChargePointDefinition[],
    options: { forget?: boolean } = {},
  ): Promise<ChargePoint[]> {
    const seen = new Set<string>();

    for (const definition of definitions) {
      assertBrowserLocalTlsSupported(definition);
      let cp = this.chargePoints.get(definition.id);
      seen.add(definition.id);

      if (!cp) {
        cp = buildChargePoint(this.database, definition);
        this.registerChargePoint(cp);
      } else {
        cp.autoMeterValueSetting = definition.autoMeterValueSetting;
        // #550: the console toggles this on a running charge point.
        cp.txUpdatedMeterValues = definition.txUpdatedMeterValues !== false;
        // TODO: handle connector count changes if necessary
      }

      // Attach network-sim config BEFORE restoreConnections connects
      cp.setNetworkSimConfig(this.getResolvedFor(cp.id));
    }

    // Remove charge points that are no longer defined
    Array.from(this.chargePoints.keys()).forEach((id) => {
      if (!seen.has(id)) {
        this.unregisterChargePoint(id);
        // #394: a charge point removed from the configuration takes its run
        // history with it, as on the daemon. A mere release keeps it.
        if (options.forget) this.scenarioRuns.deleteForChargePoint(id);
      }
    });

    return definitions
      .map((definition) => this.chargePoints.get(definition.id))
      .filter((value): value is ChargePoint => Boolean(value));
  }

  private attachEventForwarders(chargePoint: ChargePoint): void {
    this.eventSubscriptions.set(
      chargePoint.id,
      attachLocalEventForwarders(this.forwardersHost, chargePoint),
    );
  }

  private emit(id: string, event: ChargePointEvent): void {
    const listeners = this.listeners.get(id);
    if (!listeners) return;

    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error(
          `[LocalChargePointService] Listener error for charge point ${id}`,
          error,
        );
      }
    });
  }
}
