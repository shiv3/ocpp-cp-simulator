import type { ActiveChargingProfile } from "../../cp/domain/connector/Connector";
import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioMode,
} from "../../cp/application/scenario/ScenarioTypes";
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "../../cp/application/services/types/StateSnapshot";
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
import type { SimulatorConfigInput, WireSimulatorConfig } from "../../protocol";
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

/**
 * CLI/daemon ChargePointService facade with three lanes:
 * A1.3a implements the CPRegistry-backed registry lane here; A1.3b fills
 * per-CP CLIChargePointService delegation; A1.3c fills facade-owned globals.
 */
export class RegistryChargePointService implements ChargePointService {
  constructor(private readonly registry: CPRegistry) {}

  async listChargePoints(): Promise<ChargePointSnapshot[]> {
    return this.listChargePointSnapshots();
  }

  async getChargePoint(id: string): Promise<ChargePointSnapshot | null> {
    const service = this.registry.get(id);
    return service ? toChargePointSnapshot(service.getStatus()) : null;
  }

  getLocalChargePoint(_id: string): LocalChargePointHandle | null {
    return todoA13b("getLocalChargePoint");
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
    return todoA13c("resetAllState");
  }

  async clearStoredLogs(_cpId: string): Promise<void> {
    return todoA13c("clearStoredLogs");
  }

  async listStoredLogs(_cpId: string): Promise<StoredLogEntry[]> {
    return todoA13c("listStoredLogs");
  }

  async loadConfig(): Promise<WireSimulatorConfig | null> {
    return todoA13c("loadConfig");
  }

  async saveConfig(_config: SimulatorConfigInput | null): Promise<void> {
    return todoA13c("saveConfig");
  }

  subscribeConfig(
    _handler: (config: WireSimulatorConfig | null) => void,
  ): () => void {
    return todoA13c("subscribeConfig");
  }

  async connect(_id: string): Promise<void> {
    return todoA13b("connect");
  }

  async disconnect(_id: string): Promise<void> {
    return todoA13b("disconnect");
  }

  async reset(_id: string): Promise<void> {
    return todoA13b("reset");
  }

  async sendHeartbeat(_id: string): Promise<void> {
    return todoA13b("sendHeartbeat");
  }

  async startHeartbeat(_id: string, _intervalSeconds: number): Promise<void> {
    return todoA13b("startHeartbeat");
  }

  async stopHeartbeat(_id: string): Promise<void> {
    return todoA13b("stopHeartbeat");
  }

  async authorize(_id: string, _tagId: string): Promise<void> {
    return todoA13b("authorize");
  }

  async startTransaction(
    _id: string,
    _connectorId: number,
    _tagId: string,
  ): Promise<void> {
    return todoA13b("startTransaction");
  }

  async stopTransaction(_id: string, _connectorId: number): Promise<void> {
    return todoA13b("stopTransaction");
  }

  async sendStatusNotification(
    _id: string,
    _connectorId: number,
    _status: OCPPStatus,
    _opts?: StatusNotificationOptions,
  ): Promise<void> {
    return todoA13b("sendStatusNotification");
  }

  async sendDiagnosticsStatusNotification(
    _id: string,
    _status: string,
  ): Promise<void> {
    return todoA13b("sendDiagnosticsStatusNotification");
  }

  async sendFirmwareStatusNotification(
    _id: string,
    _status: string,
  ): Promise<void> {
    return todoA13b("sendFirmwareStatusNotification");
  }

  async sendSecurityEventNotification(
    _id: string,
    _type: string,
    _techInfo?: string,
  ): Promise<void> {
    return todoA13b("sendSecurityEventNotification");
  }

  async sendSignCertificate(_id: string, _csr?: string): Promise<void> {
    return todoA13b("sendSignCertificate");
  }

  async setMeterValue(
    _id: string,
    _connectorId: number,
    _value: number,
  ): Promise<void> {
    return todoA13b("setMeterValue");
  }

  async sendMeterValue(_id: string, _connectorId: number): Promise<void> {
    return todoA13b("sendMeterValue");
  }

  async removeConnector(_id: string, _connectorId: number): Promise<void> {
    return todoA13b("removeConnector");
  }

  async setEVSettings(
    _id: string,
    _connectorId: number,
    _settings: EVSettings,
  ): Promise<void> {
    return todoA13b("setEVSettings");
  }

  async getEVSettings(
    _id: string,
    _connectorId: number,
  ): Promise<EVSettings | null> {
    return todoA13b("getEVSettings");
  }

  async applyDefaultEVSettings(_settings: EVSettings): Promise<void> {
    return todoA13b("applyDefaultEVSettings");
  }

  async setAutoMeterValueConfig(
    _id: string,
    _connectorId: number,
    _config: AutoMeterValueConfig,
  ): Promise<void> {
    return todoA13b("setAutoMeterValueConfig");
  }

  async getAutoMeterValueConfig(
    _id: string,
    _connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    return todoA13b("getAutoMeterValueConfig");
  }

  async getAutoMeterConfig(
    _id: string,
    _connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    return todoA13c("getAutoMeterConfig");
  }

  async saveAutoMeterConfig(
    _id: string,
    _connectorId: number,
    _config: AutoMeterValueConfig,
  ): Promise<void> {
    return todoA13c("saveAutoMeterConfig");
  }

  async setAutoResetToAvailable(
    _id: string,
    _connectorId: number,
    _enabled: boolean,
  ): Promise<void> {
    return todoA13b("setAutoResetToAvailable");
  }

  async setConnectorMode(
    _id: string,
    _connectorId: number,
    _mode: ScenarioMode,
  ): Promise<void> {
    return todoA13b("setConnectorMode");
  }

  async setConnectorSoc(
    _id: string,
    _connectorId: number,
    _soc: number | null,
  ): Promise<void> {
    return todoA13b("setConnectorSoc");
  }

  async setConnectorSocMeterSync(
    _id: string,
    _connectorId: number,
    _enabled: boolean,
  ): Promise<void> {
    return todoA13b("setConnectorSocMeterSync");
  }

  async getSocMeterSync(_id: string, _connectorId: number): Promise<boolean> {
    return todoA13c("getSocMeterSync");
  }

  async saveSocMeterSync(
    _id: string,
    _connectorId: number,
    _enabled: boolean,
  ): Promise<void> {
    return todoA13c("saveSocMeterSync");
  }

  async getChargingProfiles(
    _id: string,
    _connectorId: number,
  ): Promise<ReadonlyArray<ActiveChargingProfile>> {
    return todoA13b("getChargingProfiles");
  }

  async getStateHistory(
    _id: string,
    _options?: HistoryOptions,
  ): Promise<StateHistoryEntry[]> {
    return todoA13b("getStateHistory");
  }

  async listScenarioDefinitions(
    _id: string,
    _connectorId: number | null,
  ): Promise<ScenarioDefinition[]> {
    return todoA13c("listScenarioDefinitions");
  }

  async saveScenarioDefinition(
    _id: string,
    _connectorId: number | null,
    _definition: ScenarioDefinition,
  ): Promise<ScenarioDefinition> {
    return todoA13c("saveScenarioDefinition");
  }

  async replaceConnectorScenarioDefinitions(
    _id: string,
    _connectorId: number | null,
    _definitions: readonly ScenarioDefinition[],
  ): Promise<ScenarioDefinition[]> {
    return todoA13c("replaceConnectorScenarioDefinitions");
  }

  async deleteScenarioDefinition(
    _id: string,
    _connectorId: number | null,
    _definitionId: string,
  ): Promise<void> {
    return todoA13c("deleteScenarioDefinition");
  }

  subscribeScenarioDefinitions(
    _id: string,
    _connectorId: number | null,
    _handler: (definitions: ScenarioDefinition[]) => void,
  ): () => void {
    return todoA13c("subscribeScenarioDefinitions");
  }

  async getScenarioTemplates(): Promise<ScenarioTemplateInfo[]> {
    return todoA13c("getScenarioTemplates");
  }

  async loadScenarioTemplate(
    _id: string,
    _templateId: string,
    _connectorId: number,
  ): Promise<{ scenarioId: string }> {
    return todoA13b("loadScenarioTemplate");
  }

  async loadScenario(
    _id: string,
    _connectorId: number,
    _definition: ScenarioDefinition,
  ): Promise<{ scenarioId: string }> {
    return todoA13b("loadScenario");
  }

  async listScenarios(
    _id: string,
    _connectorId: number,
  ): Promise<ScenarioListItem[]> {
    return todoA13b("listScenarios");
  }

  async runScenario(
    _id: string,
    _connectorId: number,
    _scenarioId: string,
  ): Promise<void> {
    return todoA13b("runScenario");
  }

  async runScenarioFile(
    _id: string,
    _path: string,
    _opts?: ScenarioRunOptions,
  ): Promise<{ scenarioId: string }> {
    return todoA13b("runScenarioFile");
  }

  async runScenarioTemplate(
    _id: string,
    _templateId: string,
    _opts?: ScenarioRunOptions,
  ): Promise<{ scenarioId: string }> {
    return todoA13b("runScenarioTemplate");
  }

  async stopScenario(
    _id: string,
    _connectorId: number,
    _scenarioId: string,
  ): Promise<void> {
    return todoA13b("stopScenario");
  }

  async stepScenario(
    _id: string,
    _connectorId: number,
    _scenarioId: string,
    _force?: boolean,
  ): Promise<void> {
    return todoA13b("stepScenario");
  }

  async stopAllScenarios(_id: string, _connectorId: number): Promise<void> {
    return todoA13b("stopAllScenarios");
  }

  async removeScenario(
    _id: string,
    _connectorId: number,
    _scenarioId: string,
  ): Promise<void> {
    return todoA13b("removeScenario");
  }

  async getScenarioStatus(
    _id: string,
    _connectorId: number,
    _scenarioId: string,
  ): Promise<ScenarioExecutionContext | null> {
    return todoA13b("getScenarioStatus");
  }

  async getScenario(
    _id: string,
    _connectorId: number,
    _scenarioId: string,
  ): Promise<ScenarioDefinition | null> {
    return todoA13b("getScenario");
  }

  subscribe(
    _id: string,
    _handler: (event: ChargePointEvent) => void,
  ): () => void {
    return todoA13b("subscribe");
  }

  private listChargePointSnapshots(): ChargePointSnapshot[] {
    return this.registry
      .list()
      .map((cpId) => this.registry.get(cpId)?.getStatus())
      .filter((status): status is ChargePointStatus => Boolean(status))
      .map(toChargePointSnapshot);
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

function todoA13b(methodName: string): never {
  throw new Error(`TODO lane A1.3b: ${methodName}`);
}

function todoA13c(methodName: string): never {
  throw new Error(`TODO lane A1.3c: ${methodName}`);
}
