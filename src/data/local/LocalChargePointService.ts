import { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { AutoMeterValueSetting } from "../../cp/domain/charge-point/ChargePoint";
import type { Database } from "../../cp/domain/persistence/Database";
import { resetSimulatorState } from "../../cp/domain/persistence/resetState";
import { SqliteScenarioRepository } from "../../cp/domain/persistence/SqliteScenarioRepository";
import {
  BootNotification,
  hasStatusNotificationOptions,
  OCPPStatus,
  type StatusNotificationOptions,
} from "../../cp/domain/types/OcppTypes";
import { isSoapVersion } from "../../cp/domain/types/OcppVersion";
import type {
  ChargePointEvent,
  ChargePointService,
  ChargePointSnapshot,
  ConnectorSnapshot,
  ScenarioRunOptions,
  ScenarioListItem,
  ScenarioTemplateInfo,
  StoredLogEntry,
} from "../interfaces/ChargePointService";
import type { ConfigRepository } from "../interfaces/ConfigRepository";
import type { ConnectorSettingsRepository } from "../interfaces/ConnectorSettingsRepository";
import {
  BROWSER_SOAP_UNSUPPORTED_MESSAGE,
  BROWSER_SCENARIO_EXECUTOR_UNAVAILABLE_MESSAGE,
  BROWSER_SCENARIO_FILE_UNSUPPORTED_MESSAGE,
  BROWSER_TLS_UNSUPPORTED_MESSAGE,
  UnsupportedFeatureError,
} from "../interfaces/UnsupportedFeatureError";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "../../cp/infrastructure/transport/wsUrlWithBasic";
import type { LogEntry } from "../../cp/shared/Logger";
import { LogLevel, LogType } from "../../cp/shared/Logger";
import {
  getDefaultEVSettings,
  type EVSettings,
} from "../../cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "../../cp/domain/connector/Connector";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioMode,
} from "../../cp/application/scenario/ScenarioTypes";
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "../../cp/application/services/types/StateSnapshot";
import {
  scenarioTemplates,
  getTemplateById,
} from "../../utils/scenarioTemplates";
import { SqliteConfigRepository } from "../sqlite/SqliteConfigRepository";
import { SqliteConnectorSettingsRepository } from "../sqlite/SqliteConnectorSettingsRepository";
import type { SimulatorConfigInput, WireSimulatorConfig } from "../../protocol";
import { mergeWriteOnlyConfigSecrets } from "../configPort";

function toConnectorSnapshot(
  connector: ReturnType<ChargePoint["getConnector"]>,
): ConnectorSnapshot | null {
  if (!connector) return null;
  const tx = connector.transaction;
  return {
    id: connector.id,
    status: connector.status as OCPPStatus,
    availability: connector.availability,
    meterValue: connector.meterValue,
    transactionId: tx?.id ?? null,
    soc: connector.soc,
    mode: connector.mode,
    autoResetToAvailable: connector.autoResetToAvailable,
    autoMeterValueConfig: connector.autoMeterValueConfig,
    evSettings: connector.evSettings,
    chargingProfile: connector.chargingProfile,
    chargingProfiles: [...connector.chargingProfiles],
    transactionStartTime: tx?.startTime ?? null,
    transactionTagId: tx?.tagId ?? null,
    transactionBatteryCapacityKwh: tx?.batteryCapacityKwh ?? null,
  };
}

function toChargePointSnapshot(cp: ChargePoint): ChargePointSnapshot {
  const connectors: ConnectorSnapshot[] = [];
  cp.connectors.forEach((connector) => {
    const snapshot = toConnectorSnapshot(connector);
    if (snapshot) connectors.push(snapshot);
  });

  return {
    id: cp.id,
    status: cp.status,
    error: cp.error,
    connectors,
    heartbeat: {
      intervalSeconds: cp.heartbeat.intervalSeconds,
      lastSentAt: cp.heartbeat.lastSentAt
        ? cp.heartbeat.lastSentAt.toISOString()
        : null,
    },
  };
}

export interface LocalChargePointDefinition {
  id: string;
  connectorNumber: number;
  bootNotification: BootNotification;
  wsUrl: string;
  centralSystemUrl?: string;
  soapCallbackUrl?: string;
  soapPath?: string;
  basicAuth: { username: string; password: string } | null;
  autoMeterValueSetting: AutoMeterValueSetting | null;
  ocppVersion?: string;
  securityProfile?: OcppSecurityProfile;
  authorizationKey?: string;
  cpoName?: string;
  tls?: OcppTlsOptions;
}

function assertBrowserLocalTlsSupported(
  definition: LocalChargePointDefinition,
): void {
  const profile = definition.securityProfile ?? 0;
  const hasTlsMaterial = Boolean(
    definition.tls?.ca || definition.tls?.cert || definition.tls?.key,
  );
  if (profile === 2 || profile === 3 || hasTlsMaterial) {
    throw new UnsupportedFeatureError(
      "browser_tls_unsupported",
      BROWSER_TLS_UNSUPPORTED_MESSAGE,
    );
  }
}

export class LocalChargePointService implements ChargePointService {
  private readonly chargePoints = new Map<string, ChargePoint>();
  private readonly listeners = new Map<
    string,
    Set<(event: ChargePointEvent) => void>
  >();
  private readonly eventSubscriptions = new Map<string, Array<() => void>>();

  /** SQLite-backed persistence for ConfigurationStore, PendingMessageQueue,
   *  and per-connector availability. Passed through to every ChargePoint we
   *  build. `null` keeps everything in-memory (test / boot-before-DB). */
  private readonly configRepository: ConfigRepository;
  private readonly connectorSettingsRepository: ConnectorSettingsRepository;
  private readonly scenarioRepository: SqliteScenarioRepository;

  constructor(private readonly database: Database | null = null) {
    this.configRepository = new SqliteConfigRepository(database);
    this.connectorSettingsRepository = new SqliteConnectorSettingsRepository(
      database,
    );
    this.scenarioRepository = new SqliteScenarioRepository(database);
  }

  registerChargePoint(chargePoint: ChargePoint): void {
    if (this.chargePoints.has(chargePoint.id)) {
      this.unregisterChargePoint(chargePoint.id);
    }

    this.chargePoints.set(chargePoint.id, chargePoint);
    this.attachEventForwarders(chargePoint);
  }

  unregisterChargePoint(id: string): void {
    const cp = this.chargePoints.get(id);
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
    if (this.database) {
      resetSimulatorState(this.database);
      await this.database.flush?.();
    }
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
    this.getExistingChargePointOrThrow(id).reset();
  }

  async sendHeartbeat(id: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).sendHeartbeat();
  }

  async startHeartbeat(id: string, intervalSeconds: number): Promise<void> {
    this.getExistingChargePointOrThrow(id).startHeartbeat(intervalSeconds);
  }

  async stopHeartbeat(id: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).stopHeartbeat();
  }

  async authorize(id: string, tagId: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).authorize(tagId);
  }

  async startTransaction(
    id: string,
    connectorId: number,
    tagId: string,
  ): Promise<void> {
    this.getExistingChargePointOrThrow(id).startTransaction(tagId, connectorId);
  }

  async stopTransaction(id: string, connectorId: number): Promise<void> {
    this.getExistingChargePointOrThrow(id).stopTransaction(connectorId);
  }

  async sendStatusNotification(
    id: string,
    connectorId: number,
    status: OCPPStatus,
    opts?: StatusNotificationOptions,
  ): Promise<void> {
    const cp = this.getExistingChargePointOrThrow(id);
    if (hasStatusNotificationOptions(opts)) {
      // Use the raw sender so errorCode/info ride along with the
      // StatusNotification.req without mutating the connector's runtime
      // status field.
      cp.sendStatusNotificationRaw(connectorId, status, opts);
      return;
    }
    cp.updateConnectorStatus(connectorId, status);
  }

  async sendDiagnosticsStatusNotification(
    id: string,
    status: string,
  ): Promise<void> {
    this.getExistingChargePointOrThrow(id).sendDiagnosticsStatusNotification(
      status as "Idle" | "Uploaded" | "UploadFailed" | "Uploading",
    );
  }

  async sendFirmwareStatusNotification(
    id: string,
    status: string,
  ): Promise<void> {
    this.getExistingChargePointOrThrow(id).sendFirmwareStatusNotification(
      status as
        | "Downloaded"
        | "DownloadFailed"
        | "Downloading"
        | "Idle"
        | "InstallationFailed"
        | "Installing"
        | "Installed",
    );
  }

  async sendSecurityEventNotification(
    id: string,
    type: string,
    techInfo?: string,
  ): Promise<void> {
    this.getExistingChargePointOrThrow(id).sendSecurityEventNotification(
      type,
      techInfo,
    );
  }

  async sendSignCertificate(id: string, csr?: string): Promise<void> {
    await this.getExistingChargePointOrThrow(id).sendSignCertificate(csr);
  }

  async setMeterValue(
    id: string,
    connectorId: number,
    value: number,
  ): Promise<void> {
    this.getExistingChargePointOrThrow(id).setMeterValue(connectorId, value);
  }

  async sendMeterValue(id: string, connectorId: number): Promise<void> {
    this.getExistingChargePointOrThrow(id).sendMeterValue(connectorId);
  }

  async removeConnector(id: string, connectorId: number): Promise<void> {
    this.getExistingChargePointOrThrow(id).removeConnector(connectorId);
  }

  async setEVSettings(
    id: string,
    connectorId: number,
    settings: EVSettings,
  ): Promise<void> {
    // Explicit set (#105): marks the connector overridden so a later
    // Default EV Settings propagation doesn't clobber it.
    const connector = this.requireConnector(id, connectorId);
    connector.applyEvSettingsOverride(settings);
  }

  async getEVSettings(
    id: string,
    connectorId: number,
  ): Promise<EVSettings | null> {
    return this.requireConnector(id, connectorId).evSettings ?? null;
  }

  async applyDefaultEVSettings(settings: EVSettings): Promise<void> {
    // Connectors freeze getDefaultEVSettings() at construction, so a mid-session
    // change to the Default EV Settings wouldn't reach the ones already live.
    // Push it onto every connector (per-connector EV settings aren't a
    // user-editable, persisted concept — they only come from the default or a
    // running scenario) so the editor reflects the new default immediately (#107).
    // Connectors with an active explicit/scenario override skip this (#105) —
    // see Connector.applyDefaultEvSettings.
    this.chargePoints.forEach((chargePoint) => {
      chargePoint.connectors.forEach((connector) => {
        connector.applyDefaultEvSettings(settings);
      });
    });
  }

  async setAutoMeterValueConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    const connector = this.requireConnector(id, connectorId);
    connector.autoMeterValueConfig = config;
  }

  async getAutoMeterValueConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    return this.requireConnector(id, connectorId).autoMeterValueConfig ?? null;
  }

  async getAutoMeterConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    return this.connectorSettingsRepository.loadAutoMeterValueConfig(
      id,
      connectorId,
    );
  }

  async saveAutoMeterConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    await this.connectorSettingsRepository.saveAutoMeterValueConfig(
      id,
      connectorId,
      config,
    );
    await this.database?.flush?.();
  }

  async setAutoResetToAvailable(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    const connector = this.requireConnector(id, connectorId);
    connector.autoResetToAvailable = enabled;
  }

  async setConnectorMode(
    id: string,
    connectorId: number,
    mode: ScenarioMode,
  ): Promise<void> {
    const connector = this.requireConnector(id, connectorId);
    connector.mode = mode;
  }

  async setConnectorSoc(
    id: string,
    connectorId: number,
    soc: number | null,
  ): Promise<void> {
    const connector = this.requireConnector(id, connectorId);
    connector.soc = soc;
  }

  async setConnectorSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    const connector = this.requireConnector(id, connectorId);
    connector.socMeterSyncEnabled = enabled;
  }

  async getSocMeterSync(_id: string, _connectorId: number): Promise<boolean> {
    return this.connectorSettingsRepository.loadSocMeterSync();
  }

  async saveSocMeterSync(
    _id: string,
    _connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.connectorSettingsRepository.saveSocMeterSync(enabled);
    await this.database?.flush?.();
  }

  async getChargingProfiles(
    id: string,
    connectorId: number,
  ): Promise<ReadonlyArray<ActiveChargingProfile>> {
    const connector = this.requireConnector(id, connectorId);
    return [...connector.chargingProfiles];
  }

  async getStateHistory(
    id: string,
    options?: HistoryOptions,
  ): Promise<StateHistoryEntry[]> {
    const cp = this.chargePoints.get(id);
    if (!cp) return [];
    return cp.stateManager.history.getHistory(options);
  }

  async getScenarioTemplates(): Promise<ScenarioTemplateInfo[]> {
    return scenarioTemplates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
    }));
  }

  async listScenarioDefinitions(
    id: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition[]> {
    return this.scenarioRepository.listByConnector(id, connectorId);
  }

  async saveScenarioDefinition(
    id: string,
    connectorId: number | null,
    definition: ScenarioDefinition,
  ): Promise<ScenarioDefinition> {
    await this.scenarioRepository.save(id, connectorId, definition);
    await this.database?.flush?.();
    return definition;
  }

  async replaceConnectorScenarioDefinitions(
    id: string,
    connectorId: number | null,
    definitions: readonly ScenarioDefinition[],
  ): Promise<ScenarioDefinition[]> {
    await this.scenarioRepository.replaceConnector(
      id,
      connectorId,
      definitions,
    );
    await this.database?.flush?.();
    return [...definitions];
  }

  async deleteScenarioDefinition(
    id: string,
    connectorId: number | null,
    definitionId: string,
  ): Promise<void> {
    this.scenarioRepository.deleteOne(id, connectorId, definitionId);
    await this.database?.flush?.();
  }

  subscribeScenarioDefinitions(
    id: string,
    connectorId: number | null,
    handler: (definitions: ScenarioDefinition[]) => void,
  ): () => void {
    return this.scenarioRepository.subscribe(id, connectorId, () => {
      handler(this.scenarioRepository.listByConnector(id, connectorId));
    });
  }

  async loadScenarioTemplate(
    id: string,
    templateId: string,
    connectorId: number,
    evSettings?: Partial<EVSettings>,
  ): Promise<{ scenarioId: string }> {
    const connector = this.requireConnector(id, connectorId);
    const template = getTemplateById(templateId);
    if (!template) throw new Error(`Unknown template: ${templateId}`);
    const definition = template.createScenario(id, connectorId);
    if (evSettings) {
      definition.evSettings = {
        ...(definition.evSettings ?? getDefaultEVSettings()),
        ...evSettings,
      };
    }
    const manager = connector.scenarioManager;
    if (!manager) throw new Error("Scenario manager not available");
    manager.loadScenarios([definition]);
    return { scenarioId: definition.id };
  }

  async loadScenario(
    id: string,
    connectorId: number,
    definition: ScenarioDefinition,
  ): Promise<{ scenarioId: string }> {
    const connector = this.requireConnector(id, connectorId);
    const manager = connector.scenarioManager;
    if (!manager) throw new Error("Scenario manager not available");
    manager.loadScenarios([definition]);
    return { scenarioId: definition.id };
  }

  async listScenarios(
    id: string,
    connectorId: number,
  ): Promise<ScenarioListItem[]> {
    const connector = this.requireConnector(id, connectorId);
    const manager = connector.scenarioManager;
    if (!manager) return [];
    const active = new Set(manager.getActiveScenarioIds());
    return manager.getScenarios().map((s) => ({
      scenarioId: s.id,
      name: s.name,
      active: active.has(s.id),
    }));
  }

  async runScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    const connector = this.requireConnector(id, connectorId);
    const manager = connector.scenarioManager;
    if (!manager) throw new Error("Scenario manager not available");
    await manager.executeScenario(scenarioId);
  }

  async runScenarioFile(
    _id: string,
    _path: string,
    _opts?: ScenarioRunOptions,
  ): Promise<{ scenarioId: string }> {
    throw new UnsupportedFeatureError(
      "browser_scenario_file_unsupported",
      BROWSER_SCENARIO_FILE_UNSUPPORTED_MESSAGE,
    );
  }

  async runScenarioTemplate(
    id: string,
    templateId: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    const connectorId = opts.connectorId ?? 1;
    const connector = this.requireConnector(id, connectorId);
    const manager = connector.scenarioManager;
    if (!manager) {
      throw new UnsupportedFeatureError(
        "browser_scenario_executor_unavailable",
        BROWSER_SCENARIO_EXECUTOR_UNAVAILABLE_MESSAGE,
      );
    }
    const template = getTemplateById(templateId);
    if (!template) throw new Error(`Unknown template: ${templateId}`);
    const definition = template.createScenario(id, connectorId);
    if (opts.evSettings) {
      definition.evSettings = {
        ...(definition.evSettings ?? getDefaultEVSettings()),
        ...opts.evSettings,
      };
    }
    manager.loadScenarios([definition]);
    await manager.executeScenario(definition.id);
    return { scenarioId: definition.id };
  }

  async stopScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    const connector = this.requireConnector(id, connectorId);
    const manager = connector.scenarioManager;
    manager?.stopScenario(scenarioId);
  }

  async stepScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
    force = false,
  ): Promise<void> {
    const connector = this.requireConnector(id, connectorId);
    const manager = connector.scenarioManager;
    if (!manager) throw new Error("Scenario manager not available");
    // ScenarioManager.stepScenario calls executor.step(); for forceStep we
    // dip into the executor directly via the manager's context.
    if (!force) {
      manager.stepScenario(scenarioId);
      return;
    }
    const ctx = manager.getScenarioExecutionContext(scenarioId);
    if (!ctx) throw new Error(`Scenario ${scenarioId} is not running`);
    const executor = (
      manager as unknown as { executors: Map<string, { forceStep(): void }> }
    ).executors.get(scenarioId);
    executor?.forceStep();
  }

  async stopAllScenarios(id: string, connectorId: number): Promise<void> {
    const connector = this.requireConnector(id, connectorId);
    const manager = connector.scenarioManager;
    manager?.stopAllScenarios();
  }

  async removeScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    const connector = this.requireConnector(id, connectorId);
    const manager = connector.scenarioManager;
    manager?.removeScenario(scenarioId);
    // Drop the persisted row too so reloads don't resurrect it.
    if (this.database) {
      this.scenarioRepository.deleteOne(id, connectorId, scenarioId);
      await this.database.flush?.();
    }
  }

  async getScenarioStatus(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioExecutionContext | null> {
    const connector = this.requireConnector(id, connectorId);
    const manager = connector.scenarioManager;
    if (!manager) return null;
    return manager.getScenarioExecutionContext(scenarioId) ?? null;
  }

  async getScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioDefinition | null> {
    const connector = this.requireConnector(id, connectorId);
    const manager = connector.scenarioManager;
    if (!manager) return null;
    return manager.getScenario(scenarioId) ?? null;
  }

  private requireConnector(id: string, connectorId: number) {
    const cp = this.getExistingChargePointOrThrow(id);
    const connector = cp.getConnector(connectorId);
    if (!connector) {
      throw new Error(`Connector ${connectorId} not found on ${id}`);
    }
    return connector;
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

  private getExistingChargePointOrThrow(id: string): ChargePoint {
    const cp = this.chargePoints.get(id);
    if (!cp) {
      throw new Error(
        `ChargePoint ${id} not registered in LocalChargePointService`,
      );
    }
    return cp;
  }

  async syncLocalChargePoints(
    definitions: LocalChargePointDefinition[],
  ): Promise<ChargePoint[]> {
    const seen = new Set<string>();

    for (const definition of definitions) {
      assertBrowserLocalTlsSupported(definition);
      let cp = this.chargePoints.get(definition.id);
      seen.add(definition.id);

      if (!cp) {
        cp = this.buildChargePoint(definition);
        this.registerChargePoint(cp);
        continue;
      }

      cp.autoMeterValueSetting = definition.autoMeterValueSetting;
      // TODO: handle connector count changes if necessary
    }

    // Remove charge points that are no longer defined
    Array.from(this.chargePoints.keys()).forEach((id) => {
      if (!seen.has(id)) {
        this.unregisterChargePoint(id);
      }
    });

    return definitions
      .map((definition) => this.chargePoints.get(definition.id))
      .filter((value): value is ChargePoint => Boolean(value));
  }

  private buildChargePoint(
    definition: LocalChargePointDefinition,
  ): ChargePoint {
    if (isSoapVersion(definition.ocppVersion)) {
      throw new UnsupportedFeatureError(
        "browser_soap_unsupported",
        BROWSER_SOAP_UNSUPPORTED_MESSAGE,
      );
    }
    assertBrowserLocalTlsSupported(definition);
    const chargePoint = new ChargePoint(
      definition.id,
      definition.bootNotification,
      definition.connectorNumber,
      definition.wsUrl,
      definition.basicAuth,
      definition.autoMeterValueSetting,
      this.database,
      {},
      [],
      definition.ocppVersion,
      {
        centralSystemUrl: definition.centralSystemUrl,
        soapCallbackUrl: definition.soapCallbackUrl,
        soapPath: definition.soapPath,
      },
      definition.securityProfile,
      definition.authorizationKey,
      definition.cpoName,
      definition.tls,
    );

    // Restore connector-level settings from the SQLite store. Sync reads
    // are safe because both adapters expose `Database.get/all`
    // synchronously; we're inside the per-CP construction path that runs
    // once per registration.
    if (this.database) {
      for (
        let connectorId = 1;
        connectorId <= definition.connectorNumber;
        connectorId++
      ) {
        const autoMeterRow = this.database.get<{ auto_meter: string | null }>(
          "SELECT auto_meter FROM connector_settings " +
            "WHERE cp_id = ? AND connector_id = ?",
          [definition.id, connectorId],
        );
        if (autoMeterRow?.auto_meter) {
          try {
            const connector = chargePoint.getConnector(connectorId);
            if (connector) {
              connector.autoMeterValueConfig = JSON.parse(
                autoMeterRow.auto_meter,
              ) as AutoMeterValueConfig;
            }
          } catch {
            // Corrupted JSON in the row — fall back to defaults.
          }
        }

        const profileRows = this.database.all<{ profile: string }>(
          "SELECT profile FROM charging_profiles " +
            "WHERE cp_id = ? AND connector_id = ? ORDER BY stack_level DESC",
          [definition.id, connectorId],
        );
        const profiles = profileRows
          .map((r) => {
            try {
              return JSON.parse(r.profile) as ActiveChargingProfile;
            } catch {
              return null;
            }
          })
          .filter((p): p is ActiveChargingProfile => p !== null);
        if (profiles.length > 0) {
          const connector = chargePoint.getConnector(connectorId);
          connector?.setChargingProfiles(profiles);
        }
      }
    }

    return chargePoint;
  }

  private attachEventForwarders(chargePoint: ChargePoint): void {
    const unsubscribes: Array<() => void> = [];

    unsubscribes.push(
      chargePoint.events.on("statusChange", ({ status }) => {
        this.emit(chargePoint.id, { type: "status", status });
      }),
    );

    unsubscribes.push(
      chargePoint.events.on("error", ({ error }) => {
        this.emit(chargePoint.id, { type: "error", error });
      }),
    );

    unsubscribes.push(
      chargePoint.events.on(
        "connectorStatusChange",
        ({ connectorId, status, previousStatus }) => {
          this.emit(chargePoint.id, {
            type: "connector-status",
            connectorId,
            status,
            previousStatus,
          });
        },
      ),
    );

    unsubscribes.push(
      chargePoint.events.on(
        "connectorAvailabilityChange",
        ({ connectorId, availability }) => {
          this.emit(chargePoint.id, {
            type: "connector-availability",
            connectorId,
            availability,
          });
        },
      ),
    );

    unsubscribes.push(
      chargePoint.events.on(
        "connectorTransactionChange",
        ({ connectorId, transactionId }) => {
          this.emit(chargePoint.id, {
            type: "connector-transaction",
            connectorId,
            transactionId,
          });
        },
      ),
    );

    unsubscribes.push(
      chargePoint.events.on(
        "connectorMeterValueChange",
        ({ connectorId, meterValue }) => {
          this.emit(chargePoint.id, {
            type: "connector-meter",
            connectorId,
            meterValue,
          });
        },
      ),
    );

    chargePoint.connectors.forEach((connector) => {
      // The ChargePoint never emits connectorMeterValueChange itself —
      // only Connector.meterValueChange fires when set_meter_value /
      // auto-meter scheduler run, so subscribe per-connector here.
      unsubscribes.push(
        connector.events.on("meterValueChange", ({ meterValue }) => {
          this.emit(chargePoint.id, {
            type: "connector-meter",
            connectorId: connector.id,
            meterValue,
          });
        }),
      );
      unsubscribes.push(
        connector.events.on("autoMeterValueChange", ({ config }) => {
          this.emit(chargePoint.id, {
            type: "connector-auto-meter",
            connectorId: connector.id,
            config,
          });
        }),
      );

      unsubscribes.push(
        connector.events.on("modeChange", ({ mode }) => {
          this.emit(chargePoint.id, {
            type: "connector-mode",
            connectorId: connector.id,
            mode,
          });
        }),
      );

      unsubscribes.push(
        connector.events.on("autoResetToAvailableChange", ({ enabled }) => {
          this.emit(chargePoint.id, {
            type: "connector-auto-reset-to-available",
            connectorId: connector.id,
            enabled,
          });
        }),
      );

      unsubscribes.push(
        connector.events.on("socChange", ({ soc }) => {
          this.emit(chargePoint.id, {
            type: "connector-soc",
            connectorId: connector.id,
            soc,
          });
        }),
      );

      unsubscribes.push(
        connector.events.on("evSettingsChange", ({ settings }) => {
          this.emit(chargePoint.id, {
            type: "connector-ev-settings",
            connectorId: connector.id,
            settings,
          });
        }),
      );

      unsubscribes.push(
        connector.events.on("chargingProfileChange", ({ profile }) => {
          this.emit(chargePoint.id, {
            type: "connector-charging-profile",
            connectorId: connector.id,
            profile,
          });
        }),
      );

      unsubscribes.push(
        connector.events.on("chargingProfilesChange", ({ profiles }) => {
          // Persist via the SQLite repo so the next CP build picks them up.
          if (this.database) {
            this.database.run(
              "DELETE FROM charging_profiles WHERE cp_id = ? AND connector_id = ?",
              [chargePoint.id, connector.id],
            );
            for (const profile of profiles) {
              this.database.run(
                "INSERT INTO charging_profiles " +
                  "(cp_id, connector_id, charging_profile_id, stack_level, purpose, profile) " +
                  "VALUES (?, ?, ?, ?, ?, ?)",
                [
                  chargePoint.id,
                  connector.id,
                  profile.chargingProfileId,
                  profile.stackLevel,
                  profile.chargingProfilePurpose,
                  JSON.stringify(profile),
                ],
              );
            }
          }
          this.emit(chargePoint.id, {
            type: "connector-charging-profiles",
            connectorId: connector.id,
            profiles,
          });
        }),
      );

      connector.setOnMeterValueSend((id) => {
        chargePoint.sendMeterValue(id);
      });
    });

    unsubscribes.push(
      chargePoint.events.on("connectorRemoved", ({ connectorId }) => {
        this.emit(chargePoint.id, { type: "connector-removed", connectorId });
      }),
    );

    unsubscribes.push(
      chargePoint.events.on("connected", () => {
        this.emit(chargePoint.id, { type: "connected" });
      }),
    );

    unsubscribes.push(
      chargePoint.events.on("disconnected", ({ code, reason }) => {
        this.emit(chargePoint.id, { type: "disconnected", code, reason });
      }),
    );

    unsubscribes.push(
      chargePoint.heartbeat.events.on(
        "stateChange",
        ({ intervalSeconds, lastSentAt }) => {
          this.emit(chargePoint.id, {
            type: "heartbeat",
            intervalSeconds,
            lastSentAt: lastSentAt ? lastSentAt.toISOString() : null,
          });
        },
      ),
    );

    unsubscribes.push(
      chargePoint.events.on("log", (entry) => {
        const logEntry: LogEntry = {
          timestamp: entry.timestamp,
          level: entry.level as LogLevel,
          type: entry.type as LogType,
          message: entry.message,
        };
        this.emit(chargePoint.id, { type: "log", entry: logEntry });
      }),
    );

    this.eventSubscriptions.set(chargePoint.id, unsubscribes);
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
