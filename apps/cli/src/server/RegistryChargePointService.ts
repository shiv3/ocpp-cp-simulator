import type { ResponseOverrideRequest } from "@ocpp-cp-simulator/core/cp/domain/charge-point/responseOverrideRequest";
import type { CellularPolicySet } from "@ocpp-cp-simulator/core/cp/domain/modem/cellularLink";
import type { ModemCommand as ModemCommandInput } from "@ocpp-cp-simulator/contracts/modem";
import type { StartTransactionOutcome } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type {
  ConfigurationKeyList,
  ConfigurationSetStatus,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/configurationAccess";
import type {
  AuthorizationCacheSeedEntry,
  AuthorizationCacheView,
} from "@ocpp-cp-simulator/core/cp/domain/auth/AuthorizationCacheSeed";
import type {
  DataTransferData,
  DataTransferResult,
} from "@ocpp-cp-simulator/core/cp/domain/types/DataTransfer";
import type {
  OcppCallOutcome,
  OcppCallRequest,
  RawFrameOutcome,
  RawFrameRequest,
  CallResultErrorOutcome,
  CallResultErrorRequest,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppCall";
import type {
  Get15118EVCertificateRequest,
  Get15118EVCertificateResult,
} from "@ocpp-cp-simulator/core/cp/domain/security/get15118EVCertificate";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/FirmwareLogStatus";

import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type {
  EVSettings,
  EVSettingsPatch,
} from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { AutoTrafficConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import {
  type ScenarioDefinition,
  type ScenarioExecutionContext,
  type ScenarioMode,
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
  TimelinePage,
  TimelineQuery,
} from "@ocpp-cp-simulator/core/cp/application/services/OperationalTimeline";
import type {
  ChargingSessionPage,
  ChargingSessionQuery,
} from "@ocpp-cp-simulator/core/cp/domain/persistence/ChargingSessionRepository";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import type { ScenarioRepository } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioRepository";
import {
  type PowerLossOptions,
  type PowerRestoreOptions,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import { clearStartupProvenance } from "./startupScenarioRows";
import { resetSimulatorState } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/resetState";
import type {
  OCPPStatus,
  StatusNotificationOptions,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type {
  MeterReadingContext,
  StartTransactionCommandOptions,
  IdTokenTypeName,
  StopTransactionCommandOptions,
  TransactionUpdateOptions,
} from "@ocpp-cp-simulator/core/cp/domain/connector/Transaction";
import type {
  ChargePointEvent,
  ChargePointService,
  ChargePointSnapshot,
  CreateChargePointParams,
  LocalChargePointHandle,
  ScenarioListItem,
  ScenarioRunOptions,
  ScenarioTemplateInfo,
  StoredLogEntry,
} from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import type {
  NetworkSimLayerConfig,
  ResolvedNetworkSimConfig,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import type { ConnectorSettingsRepository } from "@ocpp-cp-simulator/client/interfaces/ConnectorSettingsRepository";
import { mergeWriteOnlyConfigSecrets } from "@ocpp-cp-simulator/client/configPort";
import type {
  SimulatorConfigInput,
  WireSimulatorConfig,
} from "@ocpp-cp-simulator/contracts/index";
import {
  scenarioTemplates,
  summarizeTemplate,
} from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import type { CLIChargePointService } from "../service";
import type { ChargePointStatus } from "../types";
import type { Labels } from "@ocpp-cp-simulator/contracts/labels";
import type { CPRegistry, RegistryMembershipChange } from "./CPRegistry";
import type { StopReason } from "@ocpp-cp-simulator/contracts/transactionVocabulary";
import { RpcFailure } from "@ocpp-cp-simulator/contracts/errors";
import { RegistryNetworkOps } from "./registryNetworkOps";
import { RegistryScenarioDefinitions } from "./registryScenarioDefinitions";
import { RegistryScenarioRuns } from "./registryScenarioRuns";
import { listStoredLogs } from "./registryStoredLogs";
import { refuseProfileOnSoap, toInitOptions } from "./registryInit";
import { stopChargePointTransactionsAndWait } from "./gracefulShutdown";
import {
  toChargePointEvent,
  toChargePointSnapshot,
  toMembershipSnapshot,
} from "./registryWireMapping";

/** `--shutdown-wait-ms`'s default. */
const DEFAULT_STOP_WAIT_MS = 5000;

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
  /** The wait of an opt-in `stopTransactions` on `cp.delete` / `disconnect`
   *  (ms): the daemon's `--shutdown-wait-ms`. Default 5000. */
  readonly stopTransactionsWaitMs?: number;
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
  private readonly network: RegistryNetworkOps;
  private readonly definitions: RegistryScenarioDefinitions;
  private readonly runs: RegistryScenarioRuns;

  constructor(
    private readonly registry: CPRegistry,
    private readonly deps: RegistryChargePointServiceDeps,
  ) {
    this.network = new RegistryNetworkOps(registry);
    this.definitions = new RegistryScenarioDefinitions(registry, deps);
    this.runs = new RegistryScenarioRuns((id) => this.requireService(id));
  }

  /** `selector` is daemon-only (#470): only the charge points it matches get
   *  a status snapshot built. Absent or empty, every charge point is listed. */
  async listChargePoints(selector?: Labels): Promise<ChargePointSnapshot[]> {
    return this.listChargePointSnapshots(selector);
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
    refuseProfileOnSoap(params);
    this.registry.create(toInitOptions(params));
  }

  async updateChargePoint(params: CreateChargePointParams): Promise<void> {
    const existing = this.registry.get(params.cpId);
    if (!existing) throw new Error(`cpId not found: ${params.cpId}`);
    refuseProfileOnSoap(params, existing.getInit().ocppVersion);
    this.registry.update(toInitOptions(params, existing.getInit()));
  }

  /**
   * Daemon-only: stop the running transactions of one charge point and wait,
   * up to `--shutdown-wait-ms`, for the CSMS to answer the stops, then close
   * it: what an opt-in `cp.delete` (`close: "remove"`) or `disconnect`
   * (`close: "disconnect"`) with `stopTransactions` does. Rejects when no
   * such charge point is registered.
   *
   * The wait and the close target the instance registered when the request
   * started. A `cp.update` of the same cpId during the wait replaces that
   * instance; the stop then leaves the replacement alone and the close is
   * refused (rejects with `unavailable`), so it never removes or disconnects
   * the replacement or deletes its persisted row.
   */
  async stopTransactionsThenClose(
    id: string,
    close: "remove" | "disconnect",
    reason?: StopReason,
  ): Promise<void> {
    const service = this.requireService(id);
    const stillRegistered = () => this.registry.get(id) === service;
    await stopChargePointTransactionsAndWait(
      {
        list: () => [id],
        get: (cpId) => (cpId === id && stillRegistered() ? service : undefined),
      },
      id,
      this.deps.stopTransactionsWaitMs ?? DEFAULT_STOP_WAIT_MS,
      {
        reason,
        log: (line) => service.logTransactionNote(line),
      },
    );
    if (!stillRegistered()) {
      throw new RpcFailure(
        "unavailable",
        `cpId ${id} was replaced while its transactions were being stopped; the replacement was left as is`,
      );
    }
    if (close === "remove") this.registry.remove(id);
    else service.disconnect();
  }

  async removeChargePoint(id: string): Promise<void> {
    if (!this.registry.remove(id)) throw new Error(`cpId not found: ${id}`);
  }

  /** Daemon-only (#446): relabel without the rebuild `updateChargePoint`
   *  does. Rejects like it when no such charge point is registered. */
  async setChargePointLabels(id: string, labels: Labels): Promise<void> {
    if (!this.registry.setLabels(id, labels)) {
      throw new Error(`cpId not found: ${id}`);
    }
  }

  /** Daemon-only (#470): the ids a label selector matches, without building
   *  any status snapshot. An absent or empty selector matches every one. */
  selectChargePointIds(selector: Labels | undefined): string[] {
    return this.registry.selectByLabels(selector);
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
    } else {
      this.registry.clearScenarioDefinitions();
    }
    this.deps.onReset?.();
  }

  async clearStoredLogs(cpId: string): Promise<void> {
    if (!this.deps.database) return;
    this.deps.database.run("DELETE FROM logs WHERE cp_id = ?", [cpId]);
    await this.deps.database.flush?.();
  }

  async listStoredLogs(cpId: string): Promise<StoredLogEntry[]> {
    return listStoredLogs(this.registry, this.deps.database, cpId);
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
    this.requireService(id).reset();
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

  async authorize(
    id: string,
    tagId: string,
    idTokenType?: IdTokenTypeName,
  ): Promise<void> {
    this.requireService(id).authorize(tagId, idTokenType);
  }

  /** Daemon-only: the tag a control-plane call without one presents, drawn
   *  from the charge point's idTag pool (#299). */
  resolveIdTag(id: string, tagId?: string, connectorId?: number): string {
    return this.requireService(id).resolveIdTag(tagId, connectorId);
  }

  async sendDataTransfer(
    id: string,
    vendorId: string,
    messageId?: string,
    data?: DataTransferData,
  ): Promise<DataTransferResult> {
    return this.requireService(id).sendDataTransfer(vendorId, messageId, data);
  }

  async sendOcppCall(
    id: string,
    request: OcppCallRequest,
  ): Promise<OcppCallOutcome> {
    return this.requireService(id).sendOcppCall(request);
  }

  async sendRawFrame(
    id: string,
    request: RawFrameRequest,
  ): Promise<RawFrameOutcome> {
    return this.requireService(id).sendRawFrame(request);
  }

  async setResponseOverride(
    id: string,
    request: ResponseOverrideRequest,
  ): Promise<{ action: string; mode: string }> {
    return this.requireService(id).setResponseOverride(request);
  }

  async clearResponseOverrides(id: string, action?: string): Promise<number> {
    return this.requireService(id).clearResponseOverrides(action);
  }

  async sendCallResultError(
    id: string,
    request: CallResultErrorRequest,
  ): Promise<CallResultErrorOutcome> {
    return this.requireService(id).sendCallResultError(request);
  }

  async get15118EVCertificate(
    id: string,
    request: Get15118EVCertificateRequest,
  ): Promise<Get15118EVCertificateResult> {
    return this.requireService(id).get15118EVCertificate(request);
  }

  async getAuthorizationCache(id: string): Promise<AuthorizationCacheView> {
    return this.requireService(id).getAuthorizationCache();
  }

  async seedAuthorizationCache(
    id: string,
    entries: readonly AuthorizationCacheSeedEntry[],
  ): Promise<number> {
    return this.requireService(id).seedAuthorizationCache(entries);
  }

  async clearAuthorizationCache(id: string): Promise<boolean> {
    return this.requireService(id).clearAuthorizationCache();
  }

  async startTransaction(
    id: string,
    connectorId: number,
    tagId: string,
    options?: StartTransactionCommandOptions,
  ): Promise<StartTransactionOutcome> {
    return this.requireService(id).startTransaction(
      connectorId,
      tagId,
      options,
    );
  }

  async stopTransaction(
    id: string,
    connectorId: number,
    options?: StopTransactionCommandOptions,
  ): Promise<void> {
    this.requireService(id).stopTransaction(connectorId, options);
  }

  async sendTransactionUpdate(
    id: string,
    connectorId: number,
    options: TransactionUpdateOptions,
  ): Promise<void> {
    this.requireService(id).sendTransactionUpdate(connectorId, options);
  }

  async evDisconnected(id: string, connectorId: number): Promise<void> {
    this.requireService(id).evDisconnected(connectorId);
  }

  async evPlugIn(id: string, connectorId: number): Promise<void> {
    this.requireService(id).evPlugIn(connectorId);
  }

  async evSetReady(
    id: string,
    connectorId: number,
    ready: boolean,
  ): Promise<void> {
    this.requireService(id).evSetReady(connectorId, ready);
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
    status: DiagnosticsStatus,
  ): Promise<void> {
    this.requireService(id).sendDiagnosticsStatusNotification(status);
  }

  async sendFirmwareStatusNotification(
    id: string,
    status: FirmwareStatus,
    requestId?: number,
  ): Promise<void> {
    // Two-argument form only when a requestId was given, so the 1.6-era
    // call shape (and what its tests expect) is unchanged.
    if (requestId === undefined) {
      this.requireService(id).sendFirmwareStatusNotification(status);
    } else {
      this.requireService(id).sendFirmwareStatusNotification(status, requestId);
    }
  }

  async sendLogStatusNotification(
    id: string,
    status: UploadLogStatus,
    requestId?: number,
  ): Promise<void> {
    this.requireService(id).sendLogStatusNotification(status, requestId);
  }

  async sendSecurityEventNotification(
    id: string,
    type: string,
    techInfo?: string,
  ): Promise<void> {
    await this.requireService(id).sendSecurityEventNotification(type, techInfo);
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

  async sendMeterValue(
    id: string,
    connectorId: number,
    context?: MeterReadingContext,
  ): Promise<void> {
    this.requireService(id).sendMeterValue(connectorId, context);
  }

  async removeConnector(id: string, connectorId: number): Promise<void> {
    this.requireService(id).removeConnector(connectorId);
  }

  async setEVSettings(
    id: string,
    connectorId: number,
    settings: EVSettingsPatch,
  ): Promise<void> {
    this.requireService(id).setEVSettings(connectorId, settings);
  }

  async getEVSettings(
    id: string,
    connectorId: number,
  ): Promise<EVSettings | null> {
    return this.requireService(id).getEVSettings(connectorId);
  }

  async applyDefaultEVSettings(settings: EVSettingsPatch): Promise<void> {
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

  async getAutoTrafficConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoTrafficConfig | null> {
    return this.deps.connectorSettingsRepository.loadAutoTrafficConfig(
      id,
      connectorId,
    );
  }

  async saveAutoTrafficConfig(
    id: string,
    connectorId: number,
    config: AutoTrafficConfig,
  ): Promise<void> {
    await this.deps.connectorSettingsRepository.saveAutoTrafficConfig(
      id,
      connectorId,
      config,
    );
    await this.deps.database?.flush?.();
    // Applied to the running charge point as well as stored: a save that only
    // wrote a row would report success and generate nothing until a restart.
    this.requireService(id).setAutoTrafficConfig(connectorId, config);
  }

  /**
   * Apply a traffic config to the running charge point without storing it.
   *
   * The CP-command path (`set_auto_traffic_config`) is "make this station do
   * that now"; `saveAutoTrafficConfig` is the settings path and does both.
   */
  async setAutoTrafficConfig(
    id: string,
    connectorId: number,
    config: AutoTrafficConfig,
  ): Promise<void> {
    this.requireService(id).setAutoTrafficConfig(connectorId, config);
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

  async getOperationalTimeline(
    id: string,
    query?: TimelineQuery,
  ): Promise<TimelinePage> {
    return this.requireService(id).getOperationalTimeline(query);
  }

  async listChargingSessions(
    id: string,
    query?: Omit<ChargingSessionQuery, "cpId" | "cpIds">,
  ): Promise<ChargingSessionPage> {
    return this.requireService(id).listChargingSessions(query);
  }

  async getConfigurationKeys(
    id: string,
    keys?: readonly string[],
  ): Promise<ConfigurationKeyList> {
    return this.requireService(id).getConfigurationKeys(keys);
  }

  async setConfigurationKey(
    id: string,
    key: string,
    value: string,
  ): Promise<ConfigurationSetStatus> {
    return this.requireService(id).setConfigurationKey(key, value);
  }

  /**
   * #489: the sessions of every charge point, or of the ones `labels` selects
   * (`undefined` and `{}` both mean all, as in `cp.list`). Read straight from
   * the registry's shared store, so charge points are paged together in one
   * order: start time, then record order.
   */
  async listFleetChargingSessions(
    query: Omit<ChargingSessionQuery, "cpId" | "cpIds"> & {
      labels?: Labels;
    } = {},
  ): Promise<ChargingSessionPage> {
    const { labels, ...rest } = query;
    // Narrowed by label only when a selector was given: listing the whole
    // store also reaches the sessions of a charge point that is gone.
    const hasSelector = labels !== undefined && Object.keys(labels).length > 0;
    return this.registry.chargingSessions.list({
      ...rest,
      ...(hasSelector ? { cpIds: this.registry.selectByLabels(labels) } : {}),
    });
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
    return this.definitions.saveScenarioDefinition(id, connectorId, definition);
  }

  async replaceConnectorScenarioDefinitions(
    id: string,
    connectorId: number | null,
    definitions: readonly ScenarioDefinition[],
  ): Promise<ScenarioDefinition[]> {
    return this.definitions.replaceConnectorScenarioDefinitions(
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
    return this.definitions.deleteScenarioDefinition(
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
    return this.definitions.subscribeScenarioDefinitions(
      id,
      connectorId,
      handler,
    );
  }

  async getScenarioTemplates(): Promise<ScenarioTemplateInfo[]> {
    return scenarioTemplates.map(summarizeTemplate);
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
    clearStartupProvenance(this.deps.database, id, connectorId, [scenarioId]);
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
    clearStartupProvenance(this.deps.database, id, connectorId, [scenarioId]);
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
    options?: { strict?: boolean; awaitArmed?: boolean },
  ): Promise<void> {
    const service = this.requireService(id);
    service.runScenario(connectorId, scenarioId, options);
    // Opt-in (see run_scenario's `awaitArmed` param / methods.ts): don't
    // answer the RPC until the run has armed or ended. See
    // CLIChargePointService.waitForScenarioArmed for why this closes the
    // run_scenario / CSMS-command race.
    if (options?.awaitArmed) {
      await service.waitForScenarioArmed(scenarioId);
    }
  }

  async runScenarioFile(
    id: string,
    path: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    return this.runs.runScenarioFile(id, path, opts);
  }

  async runScenarioTemplate(
    id: string,
    templateId: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    return this.runs.runScenarioTemplate(id, templateId, opts);
  }

  async stopScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    this.requireService(id).stopScenario(connectorId, scenarioId);
  }

  async resetScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    this.requireService(id).resetScenario(connectorId, scenarioId);
  }

  async stepScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
    force?: boolean,
  ): Promise<void> {
    this.requireService(id).stepScenario(connectorId, scenarioId, force);
  }

  async extendScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
    seconds: number,
  ): Promise<void> {
    this.requireService(id).extendScenarioWait(
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
    this.requireService(id).retryScenarioWait(connectorId, scenarioId);
  }

  async continueScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    this.requireService(id).continueScenarioWait(connectorId, scenarioId);
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

  async listScenarioRuns(query: ScenarioRunQuery): Promise<ScenarioRunPage> {
    return this.registry.scenarioRuns.list(query);
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

  async getNetworkSimGlobal(): Promise<NetworkSimLayerConfig | null> {
    return this.network.getNetworkSimGlobal();
  }

  async saveNetworkSimGlobal(
    config: NetworkSimLayerConfig | null,
  ): Promise<void> {
    return this.network.saveNetworkSimGlobal(config);
  }

  async getNetworkSimCp(cpId: string): Promise<{
    config: NetworkSimLayerConfig | null;
    resolved: ResolvedNetworkSimConfig;
  }> {
    return this.network.getNetworkSimCp(cpId);
  }

  async saveNetworkSimCp(
    cpId: string,
    config: NetworkSimLayerConfig | null,
  ): Promise<void> {
    return this.network.saveNetworkSimCp(cpId, config);
  }

  async triggerNetworkSimDisconnect(
    cpId: string,
    ruleId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.network.triggerNetworkSimDisconnect(cpId, ruleId);
  }

  /** #930: daemon-only SIM-scoped policies, persisted by the manager. */
  getCellularPolicies(): CellularPolicySet {
    return this.network.getCellularPolicies();
  }

  async saveCellularPolicies(policies: CellularPolicySet | null) {
    return this.network.saveCellularPolicies(policies);
  }

  getCellularStatus() {
    return this.network.getCellularStatus();
  }

  async getModem(cpId: string) {
    return this.network.getModem(cpId);
  }

  async modemCommand(cpId: string, command: ModemCommandInput) {
    return this.network.modemCommand(cpId, command);
  }

  async powerLoss(
    cpId: string,
    options?: PowerLossOptions,
  ): Promise<
    { ok: true; transactions: number } | { ok: false; error: string }
  > {
    return this.network.powerLoss(cpId, options);
  }

  async powerRestore(cpId: string, options?: PowerRestoreOptions) {
    return this.network.powerRestore(cpId, options);
  }

  private listChargePointSnapshots(selector?: Labels): ChargePointSnapshot[] {
    return this.registry
      .selectByLabels(selector)
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
