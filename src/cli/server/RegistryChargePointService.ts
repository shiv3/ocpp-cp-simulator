import * as fs from "fs";

import type { ActiveChargingProfile } from "../../cp/domain/connector/Connector";
import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import {
  isScenarioDefinitionShape,
  type ScenarioDefinition,
  type ScenarioExecutionContext,
  type ScenarioMode,
} from "../../cp/application/scenario/ScenarioTypes";
import type { ScenarioRunResult } from "../../cp/application/verification/ScenarioAssertions";
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "../../cp/application/services/types/StateSnapshot";
import type { Database } from "../../cp/domain/persistence/Database";
import type { ScenarioRepository } from "../../cp/domain/persistence/ScenarioRepository";
import { resetSimulatorState } from "../../cp/domain/persistence/resetState";
import type {
  OCPPAvailability,
  OCPPStatus,
  StatusNotificationOptions,
} from "../../cp/domain/types/OcppTypes";
import type {
  ChargePointEvent,
  ChargePointService,
  ChargePointSnapshot,
  ConnectorSnapshot,
  CreateChargePointParams,
  LocalChargePointHandle,
  ScenarioListItem,
  ScenarioRunOptions,
  ScenarioTemplateInfo,
  StoredLogEntry,
} from "../../data/interfaces/ChargePointService";
import type { ConnectorSettingsRepository } from "../../data/interfaces/ConnectorSettingsRepository";
import { mergeWriteOnlyConfigSecrets } from "../../data/configPort";
import type { SimulatorConfigInput, WireSimulatorConfig } from "../../protocol";
import { LogLevel, LogType } from "../../cp/shared/Logger";
import { redactSensitiveText } from "../../cp/shared/redaction";
import { scenarioTemplates } from "../../utils/scenarioTemplates";
import type { CLIChargePointService, CLIEvent } from "../service";
import type { ChargePointInitOptions, ChargePointStatus } from "../types";
import type {
  CPRegistry,
  RegistryMembershipChange,
  RegistryMembershipEvent,
} from "./CPRegistry";

export type RegistryChargePointSubscriptionEvent =
  | { type: "snapshot"; cps: ChargePointSnapshot[] }
  | {
      type: "change";
      change: RegistryMembershipChange;
      cp: ChargePointSnapshot;
    };

export interface RegistryChargePointServiceDeps {
  readonly database: Database | null;
  readonly configRepository: RegistryConfigRepository;
  readonly scenarioRepository: ScenarioRepository;
  readonly connectorSettingsRepository: ConnectorSettingsRepository;
  readonly onReset?: () => void;
}

export interface RegistryConfigRepository {
  load(): Promise<SimulatorConfigInput | null>;
  save(config: SimulatorConfigInput | null): Promise<void>;
  subscribe(handler: (config: SimulatorConfigInput | null) => void): () => void;
}

/**
 * CLI/daemon ChargePointService facade with three lanes:
 * CPRegistry-backed registry lane; per-CP CLIChargePointService delegation;
 * facade-owned global persistence/stateless operations.
 */
export class RegistryChargePointService implements ChargePointService {
  constructor(
    private readonly registry: CPRegistry,
    private readonly deps: RegistryChargePointServiceDeps,
  ) {}

  async listChargePoints(): Promise<ChargePointSnapshot[]> {
    return this.listChargePointSnapshots();
  }

  async getChargePoint(id: string): Promise<ChargePointSnapshot | null> {
    const service = this.registry.get(id);
    return service ? toChargePointSnapshot(service.getStatus()) : null;
  }

  getLocalChargePoint(id: string): LocalChargePointHandle | null {
    this.requireService(id);
    return null;
  }

  async createChargePoint(params: CreateChargePointParams): Promise<void> {
    this.registry.create(toInitOptions(params));
  }

  async updateChargePoint(params: CreateChargePointParams): Promise<void> {
    const existing = this.registry.get(params.cpId);
    if (!existing) throw new Error(`cpId not found: ${params.cpId}`);
    this.registry.update(toInitOptions(params, existing.getInit()));
  }

  async removeChargePoint(id: string): Promise<void> {
    if (!this.registry.remove(id)) throw new Error(`cpId not found: ${id}`);
  }

  async ping(): Promise<{ ok: boolean; cps: number }> {
    return { ok: true, cps: this.registry.list().length };
  }

  async restoreFromDatabase(): Promise<string[]> {
    return this.registry.restoreFromDatabase();
  }

  subscribeRegistry(
    handler: (event: RegistryChargePointSubscriptionEvent) => void,
  ): () => void {
    handler({ type: "snapshot", cps: this.listChargePointSnapshots() });
    return this.registry.onRegistryMembership((event) => {
      handler({
        type: "change",
        change: event.change,
        cp: toMembershipSnapshot(event),
      });
    });
  }

  async resetAllState(): Promise<void> {
    for (const cpId of [...this.registry.list()]) {
      this.registry.remove(cpId, { notify: false });
    }
    if (this.deps.database) {
      resetSimulatorState(this.deps.database);
      await this.deps.database.flush?.();
    }
    this.deps.onReset?.();
  }

  async clearStoredLogs(cpId: string): Promise<void> {
    if (!this.deps.database) return;
    this.deps.database.run("DELETE FROM logs WHERE cp_id = ?", [cpId]);
    await this.deps.database.flush?.();
  }

  async listStoredLogs(cpId: string): Promise<StoredLogEntry[]> {
    const service = this.registry.get(cpId);
    service?.flushLogs();

    let entries: StoredLogEntry[] = [];
    if (this.deps.database) {
      const rows = this.deps.database.all<{
        timestamp: string;
        level: string;
        log_type: string;
        message: string;
      }>(
        "SELECT timestamp, level, log_type, message FROM logs " +
          "WHERE cp_id = ? ORDER BY id ASC",
        [cpId],
      );
      entries = rows.map((row) => ({
        timestamp: row.timestamp,
        level: row.level,
        type: row.log_type,
        cpId,
        message: redactSensitiveText(row.message),
      }));
    }

    if (entries.length > 0) return entries;
    return (service?.getInMemoryLogs() ?? []).map((entry) => ({
      timestamp: entry.timestamp.toISOString(),
      level: LogLevel[entry.level] ?? "INFO",
      type: entry.type,
      cpId,
      message: redactSensitiveText(entry.message),
    }));
  }

  async loadConfig(): Promise<WireSimulatorConfig | null> {
    return this.deps.configRepository.load();
  }

  async saveConfig(config: SimulatorConfigInput | null): Promise<void> {
    const existing = await this.deps.configRepository.load();
    await this.deps.configRepository.save(
      mergeWriteOnlyConfigSecrets(config, existing),
    );
    await this.deps.database?.flush?.();
  }

  subscribeConfig(
    handler: (config: WireSimulatorConfig | null) => void,
  ): () => void {
    return this.deps.configRepository.subscribe(handler);
  }

  async connect(id: string): Promise<void> {
    await this.requireService(id).connect();
  }

  async disconnect(id: string): Promise<void> {
    this.requireService(id).disconnect();
  }

  async reset(id: string): Promise<void> {
    const service = this.requireService(id);
    service.disconnect();
    await service.connect();
  }

  async sendHeartbeat(id: string): Promise<void> {
    this.requireService(id).sendHeartbeat();
  }

  async startHeartbeat(id: string, intervalSeconds: number): Promise<void> {
    this.requireService(id).startHeartbeat(intervalSeconds);
  }

  async stopHeartbeat(id: string): Promise<void> {
    this.requireService(id).stopHeartbeat();
  }

  async authorize(id: string, tagId: string): Promise<void> {
    this.requireService(id).authorize(tagId);
  }

  async startTransaction(
    id: string,
    connectorId: number,
    tagId: string,
  ): Promise<void> {
    this.requireService(id).startTransaction(connectorId, tagId);
  }

  async stopTransaction(id: string, connectorId: number): Promise<void> {
    this.requireService(id).stopTransaction(connectorId);
  }

  async sendStatusNotification(
    id: string,
    connectorId: number,
    status: OCPPStatus,
    opts?: StatusNotificationOptions,
  ): Promise<void> {
    this.requireService(id).updateConnectorStatus(connectorId, status, opts);
  }

  async sendDiagnosticsStatusNotification(
    id: string,
    status: string,
  ): Promise<void> {
    this.requireService(id).sendDiagnosticsStatusNotification(status);
  }

  async sendFirmwareStatusNotification(
    id: string,
    status: string,
  ): Promise<void> {
    this.requireService(id).sendFirmwareStatusNotification(status);
  }

  async sendSecurityEventNotification(
    id: string,
    type: string,
    techInfo?: string,
  ): Promise<void> {
    this.requireService(id).sendSecurityEventNotification(type, techInfo);
  }

  async sendSignCertificate(id: string, csr?: string): Promise<void> {
    await this.requireService(id).sendSignCertificate(csr);
  }

  async setMeterValue(
    id: string,
    connectorId: number,
    value: number,
  ): Promise<void> {
    this.requireService(id).setMeterValue(connectorId, value);
  }

  async sendMeterValue(id: string, connectorId: number): Promise<void> {
    this.requireService(id).sendMeterValue(connectorId);
  }

  async removeConnector(id: string, connectorId: number): Promise<void> {
    this.requireService(id).removeConnector(connectorId);
  }

  async setEVSettings(
    id: string,
    connectorId: number,
    settings: EVSettings,
  ): Promise<void> {
    this.requireService(id).setEVSettings(connectorId, settings);
  }

  async getEVSettings(
    id: string,
    connectorId: number,
  ): Promise<EVSettings | null> {
    return this.requireService(id).getEVSettings(connectorId);
  }

  async applyDefaultEVSettings(settings: EVSettings): Promise<void> {
    // Routes through the connector-level default path (#105) rather than
    // setEVSettings — setEVSettings marks an explicit override, which would
    // make this default propagation stick forever and defeat the very
    // override it's supposed to respect.
    for (const cpId of this.registry.list()) {
      this.requireService(cpId).applyDefaultEVSettings(settings);
    }
  }

  async setAutoMeterValueConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    this.requireService(id).setAutoMeterValueConfig(connectorId, config);
  }

  async getAutoMeterValueConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    return this.requireService(id).getAutoMeterValueConfig(connectorId);
  }

  async getAutoMeterConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    return this.deps.connectorSettingsRepository.loadAutoMeterValueConfig(
      id,
      connectorId,
    );
  }

  async saveAutoMeterConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    await this.deps.connectorSettingsRepository.saveAutoMeterValueConfig(
      id,
      connectorId,
      config,
    );
    await this.deps.database?.flush?.();
  }

  async setAutoResetToAvailable(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    this.requireService(id).setAutoResetToAvailable(connectorId, enabled);
  }

  async setConnectorMode(
    id: string,
    connectorId: number,
    mode: ScenarioMode,
  ): Promise<void> {
    this.requireService(id).setConnectorMode(connectorId, mode);
  }

  async setConnectorSoc(
    id: string,
    connectorId: number,
    soc: number | null,
  ): Promise<void> {
    this.requireService(id).setConnectorSoc(connectorId, soc);
  }

  async setConnectorSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    this.requireService(id).setConnectorSocMeterSync(connectorId, enabled);
  }

  async getSocMeterSync(_id: string, _connectorId: number): Promise<boolean> {
    return this.deps.connectorSettingsRepository.loadSocMeterSync();
  }

  async saveSocMeterSync(
    _id: string,
    _connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.deps.connectorSettingsRepository.saveSocMeterSync(enabled);
    await this.deps.database?.flush?.();
  }

  async getChargingProfiles(
    id: string,
    connectorId: number,
  ): Promise<ReadonlyArray<ActiveChargingProfile>> {
    return this.requireService(id).getChargingProfiles(connectorId);
  }

  async getStateHistory(
    id: string,
    options?: HistoryOptions,
  ): Promise<StateHistoryEntry[]> {
    return [...this.requireService(id).getStateHistory(options)];
  }

  async listScenarioDefinitions(
    id: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition[]> {
    return this.deps.scenarioRepository.listByConnector(id, connectorId);
  }

  async saveScenarioDefinition(
    id: string,
    connectorId: number | null,
    definition: ScenarioDefinition,
  ): Promise<ScenarioDefinition> {
    await this.deps.scenarioRepository.save(id, connectorId, definition);
    await this.deps.database?.flush?.();
    return definition;
  }

  async replaceConnectorScenarioDefinitions(
    id: string,
    connectorId: number | null,
    definitions: readonly ScenarioDefinition[],
  ): Promise<ScenarioDefinition[]> {
    await this.deps.scenarioRepository.replaceConnector(
      id,
      connectorId,
      definitions,
    );
    await this.deps.database?.flush?.();
    return [...definitions];
  }

  async deleteScenarioDefinition(
    id: string,
    connectorId: number | null,
    definitionId: string,
  ): Promise<void> {
    this.deps.scenarioRepository.deleteOne(id, connectorId, definitionId);
    await this.deps.database?.flush?.();
  }

  subscribeScenarioDefinitions(
    id: string,
    connectorId: number | null,
    handler: (definitions: ScenarioDefinition[]) => void,
  ): () => void {
    return this.deps.scenarioRepository.subscribe(id, connectorId, () => {
      handler(this.deps.scenarioRepository.listByConnector(id, connectorId));
    });
  }

  async getScenarioTemplates(): Promise<ScenarioTemplateInfo[]> {
    return scenarioTemplates.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
    }));
  }

  async loadScenarioTemplate(
    id: string,
    templateId: string,
    connectorId: number,
    evSettings?: Partial<EVSettings>,
  ): Promise<{ scenarioId: string }> {
    const scenarioId = this.requireService(id).loadScenarioTemplate(
      templateId,
      connectorId,
      evSettings,
    );
    return { scenarioId };
  }

  async loadScenario(
    id: string,
    connectorId: number,
    definition: ScenarioDefinition,
  ): Promise<{ scenarioId: string }> {
    const scenarioId = this.requireService(id).loadScenario(
      connectorId,
      definition,
    );
    return { scenarioId };
  }

  async listScenarios(
    id: string,
    connectorId: number,
  ): Promise<ScenarioListItem[]> {
    return [...this.requireService(id).listScenarios(connectorId)];
  }

  async runScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    this.requireService(id).runScenario(connectorId, scenarioId);
  }

  async runScenarioFile(
    id: string,
    path: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    const service = this.requireService(id);
    const connectorId = opts.connectorId ?? 1;
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf-8"));
    if (!isScenarioDefinitionShape(parsed)) {
      throw new Error(`file does not contain a scenario definition: ${path}`);
    }
    const scenarioId = service.loadScenario(connectorId, parsed);
    service.runScenario(connectorId, scenarioId);
    return { scenarioId };
  }

  async runScenarioTemplate(
    id: string,
    templateId: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    const service = this.requireService(id);
    const connectorId = opts.connectorId ?? 1;
    const scenarioId = service.loadScenarioTemplate(
      templateId,
      connectorId,
      opts.evSettings,
    );
    service.runScenario(connectorId, scenarioId);
    return { scenarioId };
  }

  async stopScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    this.requireService(id).stopScenario(connectorId, scenarioId);
  }

  async stepScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
    force?: boolean,
  ): Promise<void> {
    this.requireService(id).stepScenario(connectorId, scenarioId, force);
  }

  async stopAllScenarios(id: string, connectorId: number): Promise<void> {
    this.requireService(id).stopAllScenarios(connectorId);
  }

  async removeScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    this.requireService(id).removeScenario(connectorId, scenarioId);
  }

  async getScenarioStatus(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioExecutionContext | null> {
    return this.requireService(id).getScenarioStatus(connectorId, scenarioId);
  }

  async getScenarioReport(
    id: string,
    connectorId: number,
    scenarioId: string,
    runId?: string,
  ): Promise<ScenarioRunResult | null> {
    return this.requireService(id).getScenarioReport(
      connectorId,
      scenarioId,
      runId,
    );
  }

  async getScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioDefinition | null> {
    return this.requireService(id).getScenario(connectorId, scenarioId);
  }

  subscribe(
    id: string,
    handler: (event: ChargePointEvent) => void,
  ): () => void {
    return this.requireService(id).onEvent((evt) => {
      const mapped = toChargePointEvent(evt);
      if (mapped) handler(mapped);
    });
  }

  private listChargePointSnapshots(): ChargePointSnapshot[] {
    return this.registry
      .list()
      .map((cpId) => this.registry.get(cpId)?.getStatus())
      .filter((status): status is ChargePointStatus => Boolean(status))
      .map(toChargePointSnapshot);
  }

  private requireService(id: string): CLIChargePointService {
    const service = this.registry.get(id);
    if (!service) throw new Error(`cpId not found: ${id}`);
    return service;
  }
}

function toInitOptions(
  params: CreateChargePointParams,
  existing?: ChargePointInitOptions,
): ChargePointInitOptions {
  return {
    cpId: params.cpId,
    wsUrl: params.wsUrl,
    centralSystemUrl: params.centralSystemUrl ?? existing?.centralSystemUrl,
    soapCallbackUrl: params.soapCallbackUrl ?? existing?.soapCallbackUrl,
    soapPath: params.soapPath ?? existing?.soapPath,
    ocppVersion: params.ocppVersion ?? existing?.ocppVersion ?? "OCPP-1.6J",
    connectors: params.connectors ?? existing?.connectors ?? 1,
    vendor: params.vendor ?? existing?.vendor ?? "Server-Vendor",
    model: params.model ?? existing?.model ?? "Server-Model",
    basicAuth: toBasicAuth(params.basicAuth, existing?.basicAuth),
    securityProfile: params.securityProfile ?? existing?.securityProfile,
    authorizationKey: params.authorizationKey ?? existing?.authorizationKey,
    cpoName: params.cpoName ?? existing?.cpoName,
    tls: params.tls ?? existing?.tls,
    tlsCaPath: params.tlsCaPath ?? existing?.tlsCaPath,
    tlsCertPath: params.tlsCertPath ?? existing?.tlsCertPath,
    tlsKeyPath: params.tlsKeyPath ?? existing?.tlsKeyPath,
    bootNotification:
      params.bootNotification ?? existing?.bootNotification ?? undefined,
  };
}

function toBasicAuth(
  input: CreateChargePointParams["basicAuth"],
  existing?: ChargePointInitOptions["basicAuth"],
): ChargePointInitOptions["basicAuth"] {
  if (input === null) return null;
  if (input === undefined) return existing ?? null;
  if (input.password === undefined && !existing) return null;
  return {
    username: input.username,
    password:
      input.password === undefined || input.password.length === 0
        ? (existing?.password ?? input.password ?? "")
        : input.password,
  };
}

function toMembershipSnapshot(
  event: RegistryMembershipEvent,
): ChargePointSnapshot {
  return toChargePointSnapshot(event.service.getStatus());
}

function toChargePointSnapshot(status: ChargePointStatus): ChargePointSnapshot {
  return {
    id: status.id,
    status: status.status as OCPPStatus,
    error: status.error,
    connectors: status.connectors.map(toConnectorSnapshot),
    heartbeat: status.heartbeat,
    config: status.config
      ? {
          wsUrl: status.config.wsUrl,
          centralSystemUrl: status.config.centralSystemUrl,
          soapCallbackUrl: status.config.soapCallbackUrl,
          soapPath: status.config.soapPath,
          ocppVersion: status.config.ocppVersion,
          connectors: status.config.connectors,
          vendor: status.config.vendor,
          model: status.config.model,
          basicAuth: status.config.basicAuth
            ? {
                username: status.config.basicAuth.username,
                password: status.config.basicAuth.password ?? "",
              }
            : null,
          securityProfile: status.config.securityProfile,
          cpoName: status.config.cpoName,
          tlsCaPath: status.config.tlsCaPath,
          tlsCertPath: status.config.tlsCertPath,
          tlsKeyPath: status.config.tlsKeyPath,
          bootNotification: status.config.bootNotification,
        }
      : undefined,
  };
}

function toConnectorSnapshot(
  connector: ChargePointStatus["connectors"][number],
): ConnectorSnapshot {
  return {
    id: connector.id,
    status: connector.status as OCPPStatus,
    availability: connector.availability as OCPPAvailability,
    meterValue: connector.meterValue,
    transactionId: connector.transactionId,
    soc: connector.soc,
    mode: connector.mode as ScenarioMode,
    autoResetToAvailable: connector.autoResetToAvailable,
    autoMeterValueConfig:
      connector.autoMeterValueConfig as unknown as AutoMeterValueConfig | null,
    evSettings: connector.evSettings as unknown as EVSettings | null,
    chargingProfile:
      connector.chargingProfile as unknown as ActiveChargingProfile | null,
    chargingProfiles:
      connector.chargingProfiles as unknown as ActiveChargingProfile[],
    transactionStartTime: connector.transactionStartTime
      ? new Date(connector.transactionStartTime)
      : null,
    transactionTagId: connector.transactionTagId,
    transactionBatteryCapacityKwh: connector.transactionBatteryCapacityKwh,
  };
}

function toChargePointEvent(evt: CLIEvent): ChargePointEvent | null {
  switch (evt.event) {
    case "connected":
      return { type: "connected" };
    case "disconnected":
      return {
        type: "disconnected",
        code: evt.data.code,
        reason: evt.data.reason,
      };
    case "status_change":
      return { type: "status", status: evt.data.status as OCPPStatus };
    case "error":
      return { type: "error", error: evt.data.error };
    case "connector_status":
      return {
        type: "connector-status",
        connectorId: evt.data.connectorId,
        status: evt.data.status as OCPPStatus,
        previousStatus: evt.data.previousStatus as OCPPStatus,
      };
    case "transaction_started":
      return {
        type: "connector-transaction",
        connectorId: evt.data.connectorId,
        transactionId: evt.data.transactionId,
      };
    case "transaction_stopped":
      return {
        type: "connector-transaction",
        connectorId: evt.data.connectorId,
        transactionId: null,
      };
    case "meter_value":
      return {
        type: "connector-meter",
        connectorId: evt.data.connectorId,
        meterValue: evt.data.meterValue,
      };
    case "log":
      return {
        type: "log",
        entry: {
          timestamp: new Date(),
          level:
            typeof evt.data.level === "number"
              ? (evt.data.level as LogLevel)
              : LogLevel.INFO,
          type:
            typeof evt.data.type === "string"
              ? (evt.data.type as LogType)
              : LogType.GENERAL,
          message: evt.data.message,
        },
      };
    case "scenario_started":
      return {
        type: "scenario-started",
        connectorId: evt.data.connectorId,
        scenarioId: evt.data.scenarioId,
      };
    case "scenario_completed":
      return {
        type: "scenario-completed",
        connectorId: evt.data.connectorId,
        scenarioId: evt.data.scenarioId,
      };
    case "scenario_error":
      return {
        type: "scenario-error",
        connectorId: evt.data.connectorId,
        scenarioId: evt.data.scenarioId,
        error: evt.data.error,
      };
    case "scenario_node_execute":
      return {
        type: "scenario-node-execute",
        connectorId: evt.data.connectorId,
        scenarioId: evt.data.scenarioId,
        nodeId: evt.data.nodeId,
      };
    case "connector_availability":
      return {
        type: "connector-availability",
        connectorId: evt.data.connectorId,
        availability: evt.data.availability as OCPPAvailability,
      };
    case "connector_soc":
      return {
        type: "connector-soc",
        connectorId: evt.data.connectorId,
        soc: evt.data.soc,
      };
    case "connector_mode":
      return {
        type: "connector-mode",
        connectorId: evt.data.connectorId,
        mode: evt.data.mode as ScenarioMode,
      };
    case "connector_auto_reset":
      return {
        type: "connector-auto-reset-to-available",
        connectorId: evt.data.connectorId,
        enabled: evt.data.enabled,
      };
    case "connector_auto_meter":
      return {
        type: "connector-auto-meter",
        connectorId: evt.data.connectorId,
        config: evt.data.config,
      };
    case "connector_ev_settings":
      return {
        type: "connector-ev-settings",
        connectorId: evt.data.connectorId,
        settings: evt.data.settings,
      };
    case "connector_charging_profile":
      return {
        type: "connector-charging-profile",
        connectorId: evt.data.connectorId,
        profile: evt.data.profile,
      };
    case "connector_charging_profiles":
      return {
        type: "connector-charging-profiles",
        connectorId: evt.data.connectorId,
        profiles: [...evt.data.profiles],
      };
    case "heartbeat":
      return {
        type: "heartbeat",
        intervalSeconds: evt.data.intervalSeconds,
        lastSentAt: evt.data.lastSentAt,
      };
    case "state_history_entry":
      return {
        type: "state-history-entry",
        entry: evt.data.entry,
      };
    case "connector_removed":
      return {
        type: "connector-removed",
        connectorId: evt.data.connectorId,
      };
    default:
      return null;
  }
}
