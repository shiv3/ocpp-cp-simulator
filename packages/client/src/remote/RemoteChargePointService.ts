import type { ModemWire } from "@ocpp-cp-simulator/contracts/events";
import type { ModemCommand as ModemCommandInput } from "@ocpp-cp-simulator/contracts/modem";
import type {
  AuthorizationCacheSeedEntry,
  AuthorizationCacheView,
} from "@ocpp-cp-simulator/core/cp/domain/auth/AuthorizationCacheSeed";
import type {
  ConfigurationKeyList,
  ConfigurationSetStatus,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/configurationAccess";
import type { VehicleCatalog } from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleCatalog";
import type {
  PowerLossOptions,
  PowerRestoreOptions,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type {
  FleetCreateParams,
  FleetCreateResult,
  FleetTemplate,
} from "@ocpp-cp-simulator/contracts/methods";
import type { VehicleProfile } from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleProfile";
import { io, type Socket } from "socket.io-client";
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

import type {
  ChargePointEvent,
  ChargePointService,
  ChargePointSnapshot,
  CreateChargePointParams,
  ScenarioRunOptions,
  ScenarioListItem,
  ScenarioTemplateInfo,
  StoredLogEntry,
} from "../interfaces/ChargePointService";
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
  EVSettings,
  EVSettingsPatch,
} from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { AutoTrafficConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/FirmwareLogStatus";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
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
  TimelinePage,
  TimelineQuery,
} from "@ocpp-cp-simulator/core/cp/application/services/OperationalTimeline";
import type {
  ChargingSessionPage,
  ChargingSessionQuery,
} from "@ocpp-cp-simulator/core/cp/domain/persistence/ChargingSessionRepository";
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import type {
  NetworkSimLayerConfig,
  ResolvedNetworkSimConfig,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import {
  RPC_TIMEOUT_MS,
  RpcFailure,
  type EventEnvelope,
  type Labels,
  type Params,
  type Result,
  type RpcAck,
  type RpcErrorCode,
  type RpcMethod,
  type RpcRequest,
  type ServerInfo,
  type SimulatorConfigInput,
  type WireSimulatorConfig,
} from "@ocpp-cp-simulator/contracts/index";
import { mapServerEventToChargePointEvent } from "./mapServerEvent";
import {
  RemoteSubscriptions,
  type ScenarioStatusRequest,
} from "./RemoteSubscriptions";
import { RemoteConnectorRpc } from "./RemoteConnectorRpc";
import { RemoteScenarioRpc } from "./RemoteScenarioRpc";
import { publicFailure, toVehicleCatalogError } from "./rpcErrors";
import { cpListItemToSnapshot, toChargePointSnapshot } from "./snapshotMapping";

export { mapServerEventToChargePointEvent };

export type RemoteConnectionState = "connecting" | "connected" | "disconnected";

type RemoteBasicAuth = {
  readonly username: string;
  readonly password: string;
};

export interface RemoteChargePointServiceOptions {
  /** Socket.IO handshake auth. Undefined preserves URL credential behavior. */
  readonly basicAuth?: RemoteBasicAuth | null;
}

type RegistryEventEnvelope = Extract<EventEnvelope, { kind: "registry" }>;

export type RemoteRegistrySubscriptionEvent =
  | { type: "snapshot"; cps: ChargePointSnapshot[] }
  | {
      type: "change";
      change: RegistryEventEnvelope["change"];
      cp?: ChargePointSnapshot;
    };

interface PendingRpc {
  reject: (failure: RpcFailure) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isRpcAck<R>(ack: unknown): ack is RpcAck<R> {
  return (
    isRecord(ack) &&
    typeof ack.ok === "boolean" &&
    (ack.ok === true ||
      (isRecord(ack.error) &&
        typeof ack.error.code === "string" &&
        typeof ack.error.message === "string"))
  );
}

function authFromUrl(
  serverUrl: string,
): { username: string; password: string } | undefined {
  try {
    const url = new URL(serverUrl);
    if (url.username || url.password) {
      return {
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
    }
  } catch {
    // Ignore malformed credentials here; socket.io will surface connection
    // errors through the normal connect_error path.
  }
  return undefined;
}

export class RemoteChargePointService implements ChargePointService {
  private readonly socket: Socket;
  private readonly pendingRpc = new Map<number, PendingRpc>();
  private readonly connectionHandlers = new Set<
    (state: RemoteConnectionState) => void
  >();
  // These two track the "last interesting query" per key so a reconnect can
  // refetch it (see refetchActiveNonSnapshotViews). Unlike the subscription
  // maps above, callers never signal "I'm done watching this" — a view
  // just stops calling getStateHistory/getScenarioStatus for a key. Cap
  // insertion order (evicting the oldest) so an open-ended session that
  // touches many CPs/scenarios can't grow these without bound.
  private static readonly MAX_TRACKED_QUERIES = 200;
  private readonly activeStateHistory = new Map<
    string,
    HistoryOptions | undefined
  >();
  private readonly activeScenarioStatus = new Map<
    string,
    ScenarioStatusRequest
  >();

  private setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key); // re-insert at the end so it counts as most-recently-used
    map.set(key, value);
    if (map.size > RemoteChargePointService.MAX_TRACKED_QUERIES) {
      const oldest = map.keys().next().value as K;
      map.delete(oldest);
    }
  }
  private readonly subscriptions = new RemoteSubscriptions({
    rpc: (method, params, cpId) => this.rpc(method, params, cpId),
    loadConfig: () => this.loadConfig(),
    listScenarioDefinitions: (cpId, connectorId) =>
      this.listScenarioDefinitions(cpId, connectorId),
    activeStateHistory: this.activeStateHistory,
    activeScenarioStatus: this.activeScenarioStatus,
  });
  private readonly connectorRpc = new RemoteConnectorRpc({
    rpc: (method, params, cpId) => this.rpc(method, params, cpId),
    runCpRpc: (id, method, params) => this.runCpRpc(id, method, params),
    getChargePoint: (id) => this.getChargePoint(id),
    setBounded: (map, key, value) => this.setBounded(map, key, value),
    activeStateHistory: this.activeStateHistory,
  });
  private readonly scenarioRpc = new RemoteScenarioRpc({
    rpc: (method, params, cpId) => this.rpc(method, params, cpId),
    runCpRpc: (id, method, params) => this.runCpRpc(id, method, params),
    setBounded: (map, key, value) => this.setBounded(map, key, value),
    activeScenarioStatus: this.activeScenarioStatus,
  });
  private nextRpcId = 1;
  private connectionState: RemoteConnectionState = "connecting";
  private hasConnected = false;

  constructor(
    serverUrl: string,
    options: RemoteChargePointServiceOptions = {},
  ) {
    const baseUrl = serverUrl.replace(/\/+$/, "");
    const auth =
      options.basicAuth === undefined
        ? authFromUrl(baseUrl)
        : (options.basicAuth ?? undefined);
    this.socket = io(baseUrl, {
      path: "/socket.io/",
      auth,
      // Pin the polling transport instead of upgrading to WebSocket. When the
      // daemon is exposed behind an L7 proxy (e.g. the staging GCE Ingress),
      // the WebSocket upgrade often can't complete — the upgrade request fails
      // ("closed before the connection is established"), which then invalidates
      // the engine.io session and the console churns through reconnects /
      // "disconnected". HTTP long-polling traverses the proxy reliably (each
      // poll is a normal request well under the LB's response timeout), so the
      // session stays up. The cost is slightly higher update latency, which is
      // immaterial for a status console.
      transports: ["polling"],
    });
    this.connectionState = this.socket.connected ? "connected" : "connecting";

    this.socket.on("event", this.subscriptions.handleEnvelope);
    this.socket.on("connect", () => {
      const wasReconnect = this.hasConnected;
      this.hasConnected = true;
      this.setConnectionState("connected");
      if (wasReconnect) this.subscriptions.scheduleReconnectResync();
    });
    this.socket.on("connect_error", () => {
      if (!this.socket.connected) this.setConnectionState("disconnected");
    });
    this.socket.on("disconnect", () => {
      this.setConnectionState("disconnected");
      this.rejectPending("disconnected");
      this.subscriptions.markSubscriptionsNotReady();
    });
    this.socket.io.on("reconnect_attempt", () => {
      this.setConnectionState("connecting");
    });
    this.socket.io.on("reconnect", () => {
      this.setConnectionState("connected");
      this.subscriptions.scheduleReconnectResync();
    });
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  getConnectionState(): RemoteConnectionState {
    return this.connectionState;
  }

  onConnectionChange(
    handler: (state: RemoteConnectionState) => void,
  ): () => void {
    this.connectionHandlers.add(handler);
    handler(this.connectionState);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  async listChargePoints(): Promise<ChargePointSnapshot[]> {
    const list = await this.rpc("cp.list", {});
    const snapshots = list.map(cpListItemToSnapshot);
    this.subscriptions.replaceRegistryCache(snapshots);
    return snapshots;
  }

  async getChargePoint(id: string): Promise<ChargePointSnapshot | null> {
    try {
      const status = await this.rpc("status", {}, id);
      const snapshot = toChargePointSnapshot(status);
      this.subscriptions.snapshotCache.set(id, snapshot);
      return snapshot;
    } catch (err) {
      if (err instanceof RpcFailure && err.code === "not_found") return null;
      throw err;
    }
  }

  async connect(id: string): Promise<void> {
    await this.runCpRpc(id, "connect");
  }

  async disconnect(id: string): Promise<void> {
    await this.runCpRpc(id, "disconnect");
  }

  async reset(id: string): Promise<void> {
    // Route through the cause-aware reset method, which preserves the
    // reconnect reservation (Task 20). Single RPC call, not disconnect+connect.
    await this.runCpRpc(id, "reset");
  }

  async sendHeartbeat(id: string): Promise<void> {
    await this.runCpRpc(id, "heartbeat");
  }

  async startHeartbeat(id: string, intervalSeconds: number): Promise<void> {
    await this.runCpRpc(id, "start_heartbeat", { interval: intervalSeconds });
  }

  async stopHeartbeat(id: string): Promise<void> {
    await this.runCpRpc(id, "stop_heartbeat");
  }

  async authorize(
    id: string,
    tagId: string,
    idTokenType?: IdTokenTypeName,
  ): Promise<void> {
    await this.runCpRpc(id, "authorize", {
      tagId,
      ...(idTokenType ? { idTokenType } : {}),
    });
  }

  async sendDataTransfer(
    id: string,
    vendorId: string,
    messageId?: string,
    data?: DataTransferData,
  ): Promise<DataTransferResult> {
    const result = await this.runCpRpc(id, "data_transfer", {
      vendorId,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(data !== undefined ? { data } : {}),
    });
    return result as DataTransferResult;
  }

  async sendOcppCall(
    id: string,
    request: OcppCallRequest,
  ): Promise<OcppCallOutcome> {
    return (await this.runCpRpc(
      id,
      "send_ocpp_call",
      request,
    )) as OcppCallOutcome;
  }

  async sendRawFrame(
    id: string,
    request: RawFrameRequest,
  ): Promise<RawFrameOutcome> {
    return (await this.runCpRpc(
      id,
      "send_raw_frame",
      request,
    )) as RawFrameOutcome;
  }

  async get15118EVCertificate(
    id: string,
    request: Get15118EVCertificateRequest,
  ): Promise<Get15118EVCertificateResult> {
    return (await this.runCpRpc(
      id,
      "get_15118_ev_certificate",
      request,
    )) as Get15118EVCertificateResult;
  }

  async getAuthorizationCache(id: string): Promise<AuthorizationCacheView> {
    return await this.runCpRpc(id, "get_auth_cache");
  }

  async seedAuthorizationCache(
    id: string,
    entries: readonly AuthorizationCacheSeedEntry[],
  ): Promise<number> {
    const { seeded } = await this.runCpRpc(id, "seed_auth_cache", {
      entries: [...entries],
    });
    return seeded;
  }

  async clearAuthorizationCache(id: string): Promise<boolean> {
    const { cleared } = await this.runCpRpc(id, "clear_auth_cache");
    return cleared;
  }

  async startTransaction(
    id: string,
    connectorId: number,
    tagId: string,
    options?: StartTransactionCommandOptions,
  ): Promise<void> {
    await this.runCpRpc(id, "start_transaction", {
      connector: connectorId,
      tagId,
      ...(options?.triggerReason
        ? { triggerReason: options.triggerReason }
        : {}),
      ...(options?.chargingState
        ? { chargingState: options.chargingState }
        : {}),
      ...(options?.idTokenType ? { idTokenType: options.idTokenType } : {}),
    });
  }

  async stopTransaction(
    id: string,
    connectorId: number,
    options?: StopTransactionCommandOptions,
  ): Promise<void> {
    await this.runCpRpc(id, "stop_transaction", {
      connector: connectorId,
      ...(options?.reason ? { reason: options.reason } : {}),
      ...(options?.triggerReason
        ? { triggerReason: options.triggerReason }
        : {}),
    });
  }

  async sendTransactionUpdate(
    id: string,
    connectorId: number,
    options: TransactionUpdateOptions,
  ): Promise<void> {
    await this.runCpRpc(id, "transaction_event", {
      connector: connectorId,
      triggerReason: options.triggerReason,
      ...(options.chargingState
        ? { chargingState: options.chargingState }
        : {}),
      ...(options.meterValues !== undefined
        ? { meterValues: options.meterValues }
        : {}),
      ...(options.context ? { context: options.context } : {}),
    });
  }

  async evDisconnected(id: string, connectorId: number): Promise<void> {
    await this.runCpRpc(id, "ev_disconnected", { connector: connectorId });
  }

  async evPlugIn(id: string, connectorId: number): Promise<void> {
    await this.runCpRpc(id, "ev_plug_in", { connector: connectorId });
  }

  async evSetReady(
    id: string,
    connectorId: number,
    ready: boolean,
  ): Promise<void> {
    await this.runCpRpc(id, "ev_ready", { connector: connectorId, ready });
  }

  async sendStatusNotification(
    id: string,
    connectorId: number,
    status: OCPPStatus,
    opts?: StatusNotificationOptions,
  ): Promise<void> {
    await this.runCpRpc(id, "update_connector_status", {
      connector: connectorId,
      status,
      ...(opts?.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
      ...(opts?.info !== undefined ? { info: opts.info } : {}),
      ...(opts?.vendorErrorCode !== undefined
        ? { vendorErrorCode: opts.vendorErrorCode }
        : {}),
      ...(opts?.vendorId !== undefined ? { vendorId: opts.vendorId } : {}),
      ...(opts?.timestamp !== undefined
        ? { timestamp: opts.timestamp.toISOString() }
        : {}),
      ...(opts?.allowInvalidTransition ? { allowInvalidTransition: true } : {}),
      ...(opts?.suppressChargingStateTransactionEvent !== undefined
        ? {
            suppressChargingStateTransactionEvent:
              opts.suppressChargingStateTransactionEvent,
          }
        : {}),
    });
  }

  async sendDiagnosticsStatusNotification(
    id: string,
    status: DiagnosticsStatus,
  ): Promise<void> {
    await this.runCpRpc(id, "diagnostics_status_notification", { status });
  }

  async sendFirmwareStatusNotification(
    id: string,
    status: FirmwareStatus,
    requestId?: number,
  ): Promise<void> {
    await this.runCpRpc(id, "firmware_status_notification", {
      status,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  async sendLogStatusNotification(
    id: string,
    status: UploadLogStatus,
    requestId?: number,
  ): Promise<void> {
    await this.runCpRpc(id, "log_status_notification", {
      status,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  async sendSecurityEventNotification(
    id: string,
    type: string,
    techInfo?: string,
  ): Promise<void> {
    await this.runCpRpc(id, "security_event_notification", {
      type,
      ...(techInfo !== undefined ? { techInfo } : {}),
    });
  }

  async sendSignCertificate(id: string, csr?: string): Promise<void> {
    await this.runCpRpc(id, "sign_certificate", {
      ...(csr !== undefined ? { csr } : {}),
    });
  }

  async setMeterValue(
    id: string,
    connectorId: number,
    value: number,
  ): Promise<void> {
    await this.runCpRpc(id, "set_meter_value", {
      connector: connectorId,
      value,
    });
  }

  async sendMeterValue(
    id: string,
    connectorId: number,
    context?: MeterReadingContext,
  ): Promise<void> {
    await this.runCpRpc(id, "send_meter_value", {
      connector: connectorId,
      ...(context ? { context } : {}),
    });
  }

  async removeConnector(id: string, connectorId: number): Promise<void> {
    return this.connectorRpc.removeConnector(id, connectorId);
  }

  async setEVSettings(
    id: string,
    connectorId: number,
    settings: EVSettingsPatch,
  ): Promise<void> {
    return this.connectorRpc.setEVSettings(id, connectorId, settings);
  }

  async getEVSettings(
    id: string,
    connectorId: number,
  ): Promise<EVSettings | null> {
    return this.connectorRpc.getEVSettings(id, connectorId);
  }

  async applyDefaultEVSettings(settings: EVSettings): Promise<void> {
    return this.connectorRpc.applyDefaultEVSettings(settings);
  }

  async setAutoMeterValueConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    return this.connectorRpc.setAutoMeterValueConfig(id, connectorId, config);
  }

  async getAutoMeterValueConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    return this.connectorRpc.getAutoMeterValueConfig(id, connectorId);
  }

  async setAutoTrafficConfig(
    id: string,
    connectorId: number,
    config: AutoTrafficConfig,
  ): Promise<void> {
    return this.connectorRpc.setAutoTrafficConfig(id, connectorId, config);
  }

  async getAutoTrafficConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoTrafficConfig | null> {
    return this.connectorRpc.getAutoTrafficConfig(id, connectorId);
  }

  async saveAutoTrafficConfig(
    id: string,
    connectorId: number,
    config: AutoTrafficConfig,
  ): Promise<void> {
    return this.connectorRpc.saveAutoTrafficConfig(id, connectorId, config);
  }

  async getAutoMeterConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    return this.connectorRpc.getAutoMeterConfig(id, connectorId);
  }

  async saveAutoMeterConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    return this.connectorRpc.saveAutoMeterConfig(id, connectorId, config);
  }

  async setAutoResetToAvailable(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    return this.connectorRpc.setAutoResetToAvailable(id, connectorId, enabled);
  }

  async setConnectorMode(
    id: string,
    connectorId: number,
    mode: ScenarioMode,
  ): Promise<void> {
    return this.connectorRpc.setConnectorMode(id, connectorId, mode);
  }

  async setConnectorSoc(
    id: string,
    connectorId: number,
    soc: number | null,
  ): Promise<void> {
    return this.connectorRpc.setConnectorSoc(id, connectorId, soc);
  }

  async setConnectorSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    return this.connectorRpc.setConnectorSocMeterSync(id, connectorId, enabled);
  }

  async getSocMeterSync(id: string, connectorId: number): Promise<boolean> {
    return this.connectorRpc.getSocMeterSync(id, connectorId);
  }

  async saveSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    return this.connectorRpc.saveSocMeterSync(id, connectorId, enabled);
  }

  async getChargingProfiles(
    id: string,
    connectorId: number,
  ): Promise<ReadonlyArray<ActiveChargingProfile>> {
    return this.connectorRpc.getChargingProfiles(id, connectorId);
  }

  async getStateHistory(
    id: string,
    options?: HistoryOptions,
  ): Promise<StateHistoryEntry[]> {
    return this.connectorRpc.getStateHistory(id, options);
  }

  async getScenarioTemplates(): Promise<ScenarioTemplateInfo[]> {
    return this.scenarioRpc.getScenarioTemplates();
  }

  async listScenarioDefinitions(
    id: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition[]> {
    return this.scenarioRpc.listScenarioDefinitions(id, connectorId);
  }

  async saveScenarioDefinition(
    id: string,
    connectorId: number | null,
    definition: ScenarioDefinition,
  ): Promise<ScenarioDefinition> {
    return this.scenarioRpc.saveScenarioDefinition(id, connectorId, definition);
  }

  async replaceConnectorScenarioDefinitions(
    id: string,
    connectorId: number | null,
    definitions: readonly ScenarioDefinition[],
  ): Promise<ScenarioDefinition[]> {
    return this.scenarioRpc.replaceConnectorScenarioDefinitions(
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
    return this.scenarioRpc.deleteScenarioDefinition(
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
    return this.subscriptions.subscribeScenarioDefinitions(
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
    return this.scenarioRpc.loadScenarioTemplate(
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
    return this.scenarioRpc.loadScenario(id, connectorId, definition);
  }

  async listScenarios(
    id: string,
    connectorId: number,
  ): Promise<ScenarioListItem[]> {
    return this.scenarioRpc.listScenarios(id, connectorId);
  }

  async runScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    return this.scenarioRpc.runScenario(id, connectorId, scenarioId);
  }

  async runScenarioFile(
    id: string,
    path: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    return this.scenarioRpc.runScenarioFile(id, path, opts);
  }

  async runScenarioTemplate(
    id: string,
    templateId: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    return this.scenarioRpc.runScenarioTemplate(id, templateId, opts);
  }

  async stopScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    return this.scenarioRpc.stopScenario(id, connectorId, scenarioId);
  }

  async resetScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    return this.scenarioRpc.resetScenario(id, connectorId, scenarioId);
  }

  async stepScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
    force = false,
  ): Promise<void> {
    return this.scenarioRpc.stepScenario(id, connectorId, scenarioId, force);
  }

  async extendScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
    seconds: number,
  ): Promise<void> {
    return this.scenarioRpc.extendScenarioWait(
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
    return this.scenarioRpc.retryScenarioWait(id, connectorId, scenarioId);
  }

  async continueScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    return this.scenarioRpc.continueScenarioWait(id, connectorId, scenarioId);
  }

  async stopAllScenarios(id: string, connectorId: number): Promise<void> {
    return this.scenarioRpc.stopAllScenarios(id, connectorId);
  }

  async removeScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    return this.scenarioRpc.removeScenario(id, connectorId, scenarioId);
  }

  async getScenarioStatus(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioExecutionContext | null> {
    return this.scenarioRpc.getScenarioStatus(id, connectorId, scenarioId);
  }

  async getScenarioReport(
    id: string,
    connectorId: number,
    scenarioId: string,
    runId?: string,
  ): Promise<ScenarioRunResult | null> {
    return this.scenarioRpc.getScenarioReport(
      id,
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
    return this.scenarioRpc.getScenario(id, connectorId, scenarioId);
  }

  subscribe(
    id: string,
    handler: (event: ChargePointEvent) => void,
  ): () => void {
    return this.subscriptions.subscribe(id, handler);
  }

  subscribeRegistry(
    handler: (event: RemoteRegistrySubscriptionEvent) => void,
  ): () => void {
    return this.subscriptions.subscribeRegistry(handler);
  }

  async createChargePoint(params: CreateChargePointParams): Promise<void> {
    await this.rpc("cp.create", toWireCreateParams(params));
  }

  async updateChargePoint(params: CreateChargePointParams): Promise<void> {
    await this.rpc("cp.update", toWireCreateParams(params));
  }

  async setChargePointLabels(cpId: string, labels: Labels): Promise<void> {
    await this.rpc("cp.labels.set", { cpId, labels });
  }

  async listFleetTemplates(): Promise<FleetTemplate[]> {
    return this.rpc("fleet.template.list", {});
  }

  async getFleetTemplate(id: string): Promise<FleetTemplate> {
    return this.rpc("fleet.template.get", { id });
  }

  async saveFleetTemplate(template: FleetTemplate): Promise<string> {
    const saved = await this.rpc("fleet.template.save", { template });
    return saved.id;
  }

  async deleteFleetTemplate(id: string): Promise<void> {
    await this.rpc("fleet.template.delete", { id });
  }

  async createFleet(params: FleetCreateParams): Promise<FleetCreateResult> {
    return this.rpc("fleet.create", params);
  }

  async removeChargePoint(id: string): Promise<void> {
    await this.rpc("cp.delete", { cpId: id });
  }

  async ping(): Promise<{ ok: boolean; cps: number }> {
    const cps = await this.rpc("cp.list", {});
    return { ok: true, cps: cps.length };
  }

  async getServerInfo(): Promise<ServerInfo | null> {
    return this.rpc("server.info", {});
  }

  async listVehicleProfiles(): Promise<VehicleProfile[]> {
    return this.rpc("vehicle_profiles.list", {});
  }

  async saveVehicleProfile(profile: VehicleProfile): Promise<VehicleProfile> {
    return this.rpc("vehicle_profiles.save", { profile });
  }

  async deleteVehicleProfile(id: string): Promise<void> {
    await this.rpc("vehicle_profiles.delete", { id });
  }

  getVehicleCatalog(): VehicleCatalog {
    const call = async <M extends RpcMethod>(
      method: M,
      params: Params<M>,
    ): Promise<Result<M>> => {
      try {
        return await this.rpc(method, params);
      } catch (error) {
        throw toVehicleCatalogError(error);
      }
    };
    return {
      listMakes: () => call("vehicle_catalog.list_makes", {}),
      searchModels: (query) => call("vehicle_catalog.search_models", query),
      listVariants: (modelId, page) =>
        call("vehicle_catalog.list_variants", {
          modelId,
          ...(page === undefined ? {} : { page }),
        }),
      getVariant: (variantId) =>
        call("vehicle_catalog.get_variant", { variantId }),
    };
  }

  async resetAllState(): Promise<void> {
    await this.rpc("state.reset", {});
  }

  async clearStoredLogs(cpId: string): Promise<void> {
    await this.rpc("logs.clear", { cpId });
  }

  async listStoredLogs(cpId: string): Promise<StoredLogEntry[]> {
    const rows = await this.rpc("logs.get", { cpId });
    return Array.isArray(rows) ? (rows as StoredLogEntry[]) : [];
  }

  async listScenarioRuns(query: ScenarioRunQuery): Promise<ScenarioRunPage> {
    return (await this.rpc("scenario.runs.list", query)) as ScenarioRunPage;
  }

  async getOperationalTimeline(
    cpId: string,
    query: TimelineQuery = {},
  ): Promise<TimelinePage> {
    return this.rpc("timeline.get", { cpId, ...query });
  }

  async listChargingSessions(
    cpId: string,
    query: Omit<ChargingSessionQuery, "cpId"> = {},
  ): Promise<ChargingSessionPage> {
    return this.rpc("sessions.list", { cpId, ...query });
  }

  async getConfigurationKeys(
    cpId: string,
    keys: readonly string[] = [],
  ): Promise<ConfigurationKeyList> {
    return this.rpc("cp.config_keys.get", { cpId, keys: [...keys] });
  }

  async setConfigurationKey(
    cpId: string,
    key: string,
    value: string,
  ): Promise<ConfigurationSetStatus> {
    return (await this.rpc("cp.config_keys.set", { cpId, key, value })).status;
  }

  async loadConfig(): Promise<WireSimulatorConfig | null> {
    return this.rpc("config.get", {});
  }

  async saveConfig(config: SimulatorConfigInput | null): Promise<void> {
    await this.rpc("config.save", { config });
  }

  subscribeConfig(
    handler: (config: WireSimulatorConfig | null) => void,
  ): () => void {
    return this.subscriptions.subscribeConfig(handler);
  }

  async getNetworkSimGlobal(): Promise<NetworkSimLayerConfig | null> {
    const result = (await this.rpc(
      "network_sim.global.get",
      {},
    )) as unknown as { config: NetworkSimLayerConfig | null };
    return result?.config ?? null;
  }

  async saveNetworkSimGlobal(
    config: NetworkSimLayerConfig | null,
  ): Promise<void> {
    await this.rpc("network_sim.global.save", {
      config: config as unknown as Record<string, unknown>,
    });
  }

  async getNetworkSimCp(cpId: string): Promise<{
    config: NetworkSimLayerConfig | null;
    resolved: ResolvedNetworkSimConfig;
  }> {
    return (await this.rpc("network_sim.cp.get", { cpId })) as unknown as {
      config: NetworkSimLayerConfig | null;
      resolved: ResolvedNetworkSimConfig;
    };
  }

  async saveNetworkSimCp(
    cpId: string,
    config: NetworkSimLayerConfig | null,
  ): Promise<void> {
    await this.rpc("network_sim.cp.save", {
      cpId,
      config: config as unknown as Record<string, unknown>,
    });
  }

  async triggerNetworkSimDisconnect(
    cpId: string,
    ruleId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.rpc("network_sim.disconnect.trigger", {
      cpId,
      ruleId,
    })) as unknown as { ok: true } | { ok: false; error: string };
  }

  async getModem(
    cpId: string,
  ): Promise<{ ok: true; modem: ModemWire } | { ok: false; error: string }> {
    return (await this.rpc("modem.get", { cpId })) as unknown as
      { ok: true; modem: ModemWire } | { ok: false; error: string };
  }

  async modemCommand(
    cpId: string,
    command: ModemCommandInput,
  ): Promise<{ ok: true; modem: ModemWire } | { ok: false; error: string }> {
    return (await this.rpc("modem.command", {
      ...command,
      cpId,
    })) as unknown as
      { ok: true; modem: ModemWire } | { ok: false; error: string };
  }

  async powerLoss(
    cpId: string,
    options?: PowerLossOptions,
  ): Promise<
    { ok: true; transactions: number } | { ok: false; error: string }
  > {
    return (await this.rpc("power.loss", {
      cpId,
      ...options,
    })) as unknown as
      { ok: true; transactions: number } | { ok: false; error: string };
  }

  async powerRestore(cpId: string, options?: PowerRestoreOptions) {
    return (await this.rpc("power.restore", {
      cpId,
      ...options,
    })) as unknown as
      | {
          ok: true;
          outageMs: number;
          recovery: "resume" | "end" | "none";
          transactions: number;
        }
      | { ok: false; error: string };
  }

  /**
   * Raw control-plane passthrough for the bundled CLI client. Port consumers
   * should use the typed methods above; this preserves `--send`'s JSON command
   * contract, where the daemon receives the verbatim method/params pair.
   */
  async runRawRpc(
    method: string,
    params: unknown = {},
    cpId?: string,
  ): Promise<RpcAck> {
    return this.emitRpcAck({
      ...(cpId ? { cpId } : {}),
      method,
      params,
    });
  }

  async subscribeRawEvents(
    scope: string,
    handler: (event: EventEnvelope) => void,
  ): Promise<void> {
    this.socket.on("event", handler);
    const ack = await this.runRawRpc("events.subscribe", { scope });
    if (!ack.ok) {
      this.socket.off("event", handler);
      throw new RpcFailure(ack.error.code, ack.error.message);
    }
  }

  dispose(): void {
    this.rejectPending("disconnected");
    this.subscriptions.dispose();
    this.connectionHandlers.clear();
    this.socket.disconnect();
  }

  private async runCpRpc<M extends RpcMethod>(
    id: string,
    method: M,
    params?: Params<M>,
  ): Promise<Result<M>> {
    return this.rpc(method, (params ?? {}) as Params<M>, id);
  }

  private rpc<M extends RpcMethod>(
    method: M,
    params: Params<M>,
    cpId?: string,
  ): Promise<Result<M>> {
    const request: RpcRequest = {
      ...(cpId ? { cpId } : {}),
      method,
      params,
    };

    return this.emitRpcRequest(request, (ack) => {
      if (!ack.ok) {
        throw new RpcFailure(ack.error.code, ack.error.message, {
          retryAfterSeconds: ack.error.retryAfterSeconds,
        });
      }
      return ack.result as Result<M>;
    });
  }

  private emitRpcAck(request: RpcRequest): Promise<RpcAck> {
    return this.emitRpcRequest(request, (ack) => ack);
  }

  private emitRpcRequest<T>(
    request: RpcRequest,
    mapAck: (ack: RpcAck) => T,
  ): Promise<T> {
    const id = this.nextRpcId++;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.pendingRpc.delete(id);
        fn();
      };

      this.pendingRpc.set(id, {
        reject: (failure) => settle(() => reject(failure)),
      });

      if (!this.socket.connected) this.socket.connect();

      void this.socket
        .timeout(RPC_TIMEOUT_MS)
        .emitWithAck("rpc", request)
        .then(
          (ack: unknown) => {
            if (!isRpcAck(ack)) {
              settle(() =>
                reject(new RpcFailure("internal", "invalid rpc ack")),
              );
              return;
            }
            settle(() => {
              try {
                resolve(mapAck(ack));
              } catch (err) {
                reject(err);
              }
            });
          },
          () => {
            this.rejectPending("timeout");
          },
        );
    });
  }

  private rejectPending(code: RpcErrorCode): void {
    if (this.pendingRpc.size === 0) return;
    const failure = publicFailure(code);
    const pending = [...this.pendingRpc.values()];
    this.pendingRpc.clear();
    pending.forEach((entry) => entry.reject(failure));
  }

  private setConnectionState(state: RemoteConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const handler of this.connectionHandlers) {
      try {
        handler(state);
      } catch (err) {
        console.error(
          "[RemoteChargePointService] connection handler error",
          err,
        );
      }
    }
  }
}

/**
 * Fold `supervisionUrls` into the wire shape.
 *
 * The control plane expresses several supervision URLs as an array `wsUrl`
 * (#296); `CreateChargePointParams` keeps them in a field of their own because
 * that is what the charge point consumes. Forwarding the typed shape verbatim
 * meant the schema stripped the unknown key and the call succeeded while
 * quietly creating a single-URL charge point — the failure mode this whole
 * translation exists to avoid.
 */
export function toWireCreateParams(
  params: CreateChargePointParams,
): Params<"cp.create"> {
  const { supervisionUrls, ...rest } = params;
  if (!supervisionUrls || supervisionUrls.length <= 1) {
    return rest as Params<"cp.create">;
  }
  return { ...rest, wsUrl: [...supervisionUrls] } as Params<"cp.create">;
}
