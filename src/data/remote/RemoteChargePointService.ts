import { io, type Socket } from "socket.io-client";

import type {
  ChargePointEvent,
  ChargePointService,
  ChargePointSnapshot,
  ConnectorSnapshot,
  CreateChargePointParams,
  ScenarioRunOptions,
  ScenarioListItem,
  ScenarioTemplateInfo,
  StoredLogEntry,
} from "../interfaces/ChargePointService";
import type {
  OCPPAvailability,
  OCPPStatus,
  StatusNotificationOptions,
} from "../../cp/domain/types/OcppTypes";
import { LogLevel, LogType } from "../../cp/shared/Logger";
import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "../../cp/domain/connector/Connector";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioMode,
} from "../../cp/application/scenario/ScenarioTypes";
import type { ScenarioRunResult } from "../../cp/application/verification/ScenarioAssertions";
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "../../cp/application/services/types/StateSnapshot";
import {
  RPC_TIMEOUT_MS,
  RpcFailure,
  type CpListItem,
  type EventEnvelope,
  type Params,
  type Result,
  type RpcAck,
  type RpcErrorCode,
  type RpcMethod,
  type RpcRequest,
  type SimulatorConfigInput,
  type StatusWire,
  type SubscribeResult,
  type WireSimulatorConfig,
} from "../../protocol";

type CpEventEnvelope = Extract<EventEnvelope, { kind: "cp" }>;
type RegistryEventEnvelope = Extract<EventEnvelope, { kind: "registry" }>;
type ConfigEventEnvelope = Extract<EventEnvelope, { kind: "config" }>;
type ScenarioDefinitionsEventEnvelope = Extract<
  EventEnvelope,
  { kind: "scenario-definitions" }
>;
type ServerCpEvent = CpEventEnvelope["evt"];
type ServerConnectorStatus = StatusWire["connectors"][number];
type WireConfig = NonNullable<StatusWire["config"]>;

const CONFIG_EVENTS_SCOPE = "config";
const SCENARIO_DEFINITIONS_EVENTS_SCOPE = "scenario-definitions";

export type RemoteConnectionState = "connecting" | "connected" | "disconnected";

type RemoteBasicAuth = {
  readonly username: string;
  readonly password: string;
};

export interface RemoteChargePointServiceOptions {
  /** Socket.IO handshake auth. Undefined preserves URL credential behavior. */
  readonly basicAuth?: RemoteBasicAuth | null;
}

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

interface ActiveSubscription {
  handlers: Set<(event: ChargePointEvent) => void>;
  ready: boolean;
  queued: CpEventEnvelope[];
}

interface ActiveRegistrySubscription {
  handlers: Set<(event: RemoteRegistrySubscriptionEvent) => void>;
  ready: boolean;
  queued: RegistryEventEnvelope[];
}

interface ActiveConfigSubscription {
  handlers: Set<(config: WireSimulatorConfig | null) => void>;
  ready: boolean;
  queued: ConfigEventEnvelope[];
  current: WireSimulatorConfig | null;
}

interface ActiveScenarioDefinitionsSubscription {
  cpId: string;
  connectorId: number | null;
  handlers: Set<(definitions: ScenarioDefinition[]) => void>;
  ready: boolean;
  queued: ScenarioDefinitionsEventEnvelope[];
  current: ScenarioDefinition[];
}

interface ScenarioStatusRequest {
  cpId: string;
  connector: number;
  scenarioId: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function emptyConnectorSnapshot(id: number): ConnectorSnapshot {
  return {
    id,
    status: "Unavailable" as OCPPStatus,
    availability: "Operative",
    meterValue: 0,
    transactionId: null,
    soc: null,
    mode: "manual",
    autoResetToAvailable: true,
    autoMeterValueConfig: null,
    evSettings: null,
    chargingProfile: null,
    chargingProfiles: [],
    transactionStartTime: null,
    transactionTagId: null,
    transactionBatteryCapacityKwh: null,
  };
}

function toConnectorSnapshot(c: ServerConnectorStatus): ConnectorSnapshot {
  return {
    id: c.id,
    status: c.status as OCPPStatus,
    availability: c.availability as OCPPAvailability,
    meterValue: c.meterValue,
    transactionId: c.transactionId,
    soc: c.soc ?? null,
    mode: (c.mode as ScenarioMode) ?? "manual",
    autoResetToAvailable: c.autoResetToAvailable ?? true,
    autoMeterValueConfig:
      (c.autoMeterValueConfig as unknown as AutoMeterValueConfig | null) ??
      null,
    evSettings: (c.evSettings as unknown as EVSettings | null) ?? null,
    chargingProfile:
      (c.chargingProfile as unknown as ActiveChargingProfile | null) ?? null,
    chargingProfiles:
      (c.chargingProfiles as unknown as ActiveChargingProfile[]) ?? [],
    transactionStartTime: c.transactionStartTime
      ? new Date(c.transactionStartTime)
      : null,
    transactionTagId: c.transactionTagId ?? null,
    transactionBatteryCapacityKwh: c.transactionBatteryCapacityKwh ?? null,
  };
}

function toChargePointSnapshot(s: StatusWire): ChargePointSnapshot {
  return {
    id: s.id,
    status: s.status as OCPPStatus,
    error: s.error ?? "",
    connectors: (s.connectors ?? []).map(toConnectorSnapshot),
    heartbeat: s.heartbeat
      ? {
          intervalSeconds: s.heartbeat.intervalSeconds,
          lastSentAt: s.heartbeat.lastSentAt,
        }
      : undefined,
    config: s.config ? toSnapshotConfig(s.config) : undefined,
  };
}

function toSnapshotConfig(config: WireConfig): ChargePointSnapshot["config"] {
  return {
    wsUrl: config.wsUrl,
    centralSystemUrl: config.centralSystemUrl,
    soapCallbackUrl: config.soapCallbackUrl,
    soapPath: config.soapPath,
    ocppVersion: config.ocppVersion,
    connectors: config.connectors,
    vendor: config.vendor,
    model: config.model,
    // The socket protocol intentionally redacts passwords. The legacy browser
    // interface still requires a password field, so remote snapshots expose an
    // empty placeholder instead of a secret the daemon will not send.
    basicAuth: config.basicAuth
      ? { username: config.basicAuth.username, password: "" }
      : null,
    securityProfile: config.securityProfile,
    cpoName: config.cpoName,
    tlsCaPath: config.tlsCaPath,
    tlsCertPath: config.tlsCertPath,
    tlsKeyPath: config.tlsKeyPath,
    bootNotification: config.bootNotification ?? null,
  };
}

function cpListItemToSnapshot(item: CpListItem): ChargePointSnapshot {
  const connectorCount = Math.max(0, item.connectors);
  return {
    id: item.cpId,
    status: item.status as OCPPStatus,
    error: "",
    connectors: Array.from({ length: connectorCount }, (_, i) =>
      emptyConnectorSnapshot(i + 1),
    ),
    config: toSnapshotConfig(item),
  };
}

function snapshotToEvents(snapshot: ChargePointSnapshot): ChargePointEvent[] {
  const events: ChargePointEvent[] = [
    { type: "status", status: snapshot.status },
  ];
  if (snapshot.error) events.push({ type: "error", error: snapshot.error });
  if (snapshot.heartbeat) {
    events.push({
      type: "heartbeat",
      intervalSeconds: snapshot.heartbeat.intervalSeconds,
      lastSentAt: snapshot.heartbeat.lastSentAt,
    });
  }

  for (const connector of snapshot.connectors) {
    events.push({
      type: "connector-status",
      connectorId: connector.id,
      status: connector.status,
      previousStatus: connector.status,
    });
    events.push({
      type: "connector-availability",
      connectorId: connector.id,
      availability: connector.availability,
    });
    events.push({
      type: "connector-meter",
      connectorId: connector.id,
      meterValue: connector.meterValue,
    });
    events.push({
      type: "connector-transaction",
      connectorId: connector.id,
      transactionId: connector.transactionId,
    });
    events.push({
      type: "connector-soc",
      connectorId: connector.id,
      soc: connector.soc,
    });
    events.push({
      type: "connector-mode",
      connectorId: connector.id,
      mode: connector.mode,
    });
    events.push({
      type: "connector-auto-reset-to-available",
      connectorId: connector.id,
      enabled: connector.autoResetToAvailable,
    });
    if (connector.autoMeterValueConfig) {
      events.push({
        type: "connector-auto-meter",
        connectorId: connector.id,
        config: connector.autoMeterValueConfig,
      });
    }
    if (connector.evSettings) {
      events.push({
        type: "connector-ev-settings",
        connectorId: connector.id,
        settings: connector.evSettings,
      });
    }
    events.push({
      type: "connector-charging-profile",
      connectorId: connector.id,
      profile: connector.chargingProfile,
    });
    events.push({
      type: "connector-charging-profiles",
      connectorId: connector.id,
      profiles: [...connector.chargingProfiles],
    });
  }

  return events;
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

function publicFailure(code: RpcErrorCode): RpcFailure {
  switch (code) {
    case "timeout":
      return new RpcFailure(code, "rpc timed out");
    case "disconnected":
      return new RpcFailure(code, "disconnected");
    default:
      return new RpcFailure(code, code.replace(/_/g, " "));
  }
}

export function mapServerEventToChargePointEvent(
  evt: ServerCpEvent,
): ChargePointEvent | null {
  const data = isRecord(evt.data) ? evt.data : {};

  switch (evt.event) {
    case "connected":
      return { type: "connected" };
    case "disconnected":
      return {
        type: "disconnected",
        code: typeof data.code === "number" ? data.code : 0,
        reason: typeof data.reason === "string" ? data.reason : "",
      };
    case "status_change":
      return typeof data.status === "string"
        ? { type: "status", status: data.status as OCPPStatus }
        : null;
    case "error":
      return typeof data.error === "string"
        ? { type: "error", error: data.error }
        : null;
    case "connector_status":
      if (
        typeof data.connectorId === "number" &&
        typeof data.status === "string" &&
        typeof data.previousStatus === "string"
      ) {
        return {
          type: "connector-status",
          connectorId: data.connectorId,
          status: data.status as OCPPStatus,
          previousStatus: data.previousStatus as OCPPStatus,
        };
      }
      return null;
    case "transaction_started":
      if (
        typeof data.connectorId === "number" &&
        typeof data.transactionId === "number"
      ) {
        return {
          type: "connector-transaction",
          connectorId: data.connectorId,
          transactionId: data.transactionId,
        };
      }
      return null;
    case "transaction_stopped":
      if (typeof data.connectorId === "number") {
        return {
          type: "connector-transaction",
          connectorId: data.connectorId,
          transactionId: null,
        };
      }
      return null;
    case "meter_value":
      if (
        typeof data.connectorId === "number" &&
        typeof data.meterValue === "number"
      ) {
        return {
          type: "connector-meter",
          connectorId: data.connectorId,
          meterValue: data.meterValue,
        };
      }
      return null;
    case "log": {
      const level =
        typeof data.level === "number"
          ? (data.level as LogLevel)
          : LogLevel.INFO;
      const typeStr =
        typeof data.type === "string"
          ? (data.type as LogType)
          : LogType.GENERAL;
      const message = typeof data.message === "string" ? data.message : "";
      const ts = evt.timestamp ? new Date(evt.timestamp) : new Date();
      return {
        type: "log",
        entry: { timestamp: ts, level, type: typeStr, message },
      };
    }
    case "connector_availability":
      if (
        typeof data.connectorId === "number" &&
        typeof data.availability === "string"
      ) {
        return {
          type: "connector-availability",
          connectorId: data.connectorId,
          availability: data.availability as OCPPAvailability,
        };
      }
      return null;
    case "connector_soc":
      if (typeof data.connectorId === "number") {
        return {
          type: "connector-soc",
          connectorId: data.connectorId,
          soc: typeof data.soc === "number" ? data.soc : null,
        };
      }
      return null;
    case "connector_mode":
      if (
        typeof data.connectorId === "number" &&
        typeof data.mode === "string"
      ) {
        return {
          type: "connector-mode",
          connectorId: data.connectorId,
          mode: data.mode as ScenarioMode,
        };
      }
      return null;
    case "connector_auto_reset":
      if (
        typeof data.connectorId === "number" &&
        typeof data.enabled === "boolean"
      ) {
        return {
          type: "connector-auto-reset-to-available",
          connectorId: data.connectorId,
          enabled: data.enabled,
        };
      }
      return null;
    case "connector_auto_meter":
      if (typeof data.connectorId === "number" && isRecord(data.config)) {
        return {
          type: "connector-auto-meter",
          connectorId: data.connectorId,
          config: data.config as unknown as AutoMeterValueConfig,
        };
      }
      return null;
    case "connector_ev_settings":
      if (typeof data.connectorId === "number" && isRecord(data.settings)) {
        return {
          type: "connector-ev-settings",
          connectorId: data.connectorId,
          settings: data.settings as unknown as EVSettings,
        };
      }
      return null;
    case "connector_charging_profile":
      if (typeof data.connectorId === "number") {
        return {
          type: "connector-charging-profile",
          connectorId: data.connectorId,
          profile: isRecord(data.profile)
            ? (data.profile as unknown as ActiveChargingProfile)
            : null,
        };
      }
      return null;
    case "connector_charging_profiles":
      if (
        typeof data.connectorId === "number" &&
        Array.isArray(data.profiles)
      ) {
        return {
          type: "connector-charging-profiles",
          connectorId: data.connectorId,
          profiles: data.profiles as unknown as ActiveChargingProfile[],
        };
      }
      return null;
    case "scenario_started":
      if (
        typeof data.connectorId === "number" &&
        typeof data.scenarioId === "string"
      ) {
        return {
          type: "scenario-started",
          connectorId: data.connectorId,
          scenarioId: data.scenarioId,
        };
      }
      return null;
    case "scenario_completed":
      if (
        typeof data.connectorId === "number" &&
        typeof data.scenarioId === "string"
      ) {
        return {
          type: "scenario-completed",
          connectorId: data.connectorId,
          scenarioId: data.scenarioId,
        };
      }
      return null;
    case "scenario_error":
      if (
        typeof data.connectorId === "number" &&
        typeof data.scenarioId === "string" &&
        typeof data.error === "string"
      ) {
        return {
          type: "scenario-error",
          connectorId: data.connectorId,
          scenarioId: data.scenarioId,
          error: data.error,
        };
      }
      return null;
    case "scenario_node_execute":
      if (
        typeof data.connectorId === "number" &&
        typeof data.scenarioId === "string" &&
        typeof data.nodeId === "string"
      ) {
        return {
          type: "scenario-node-execute",
          connectorId: data.connectorId,
          scenarioId: data.scenarioId,
          nodeId: data.nodeId,
        };
      }
      return null;
    case "connector_removed":
      if (typeof data.connectorId === "number") {
        return {
          type: "connector-removed",
          connectorId: data.connectorId,
        };
      }
      return null;
    case "heartbeat":
      if (typeof data.intervalSeconds === "number") {
        return {
          type: "heartbeat",
          intervalSeconds: data.intervalSeconds,
          lastSentAt:
            typeof data.lastSentAt === "string" ? data.lastSentAt : null,
        };
      }
      return null;
    case "state_history_entry":
      if (isRecord(data.entry)) {
        const raw = data.entry as Record<string, unknown>;
        const timestamp =
          typeof raw.timestamp === "string"
            ? new Date(raw.timestamp)
            : new Date();
        return {
          type: "state-history-entry",
          entry: { ...raw, timestamp } as unknown as StateHistoryEntry,
        };
      }
      return null;
    default:
      return null;
  }
}

export class RemoteChargePointService implements ChargePointService {
  private readonly socket: Socket;
  private readonly subs = new Map<string, ActiveSubscription>();
  private readonly pendingRpc = new Map<number, PendingRpc>();
  private readonly connectionHandlers = new Set<
    (state: RemoteConnectionState) => void
  >();
  private readonly snapshotCache = new Map<string, ChargePointSnapshot>();
  private readonly registryCache = new Map<string, ChargePointSnapshot>();
  private readonly scenarioDefinitionSubs = new Map<
    string,
    ActiveScenarioDefinitionsSubscription
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
  private registrySub: ActiveRegistrySubscription | null = null;
  private configSub: ActiveConfigSubscription | null = null;
  private configScopeSubscribe: Promise<void> | null = null;
  private scenarioDefinitionsScopeSubscribe: Promise<void> | null = null;
  private nextRpcId = 1;
  private connectionState: RemoteConnectionState = "connecting";
  private hasConnected = false;
  private reconnectSerial = 0;

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

    this.socket.on("event", this.handleEnvelope);
    this.socket.on("connect", () => {
      const wasReconnect = this.hasConnected;
      this.hasConnected = true;
      this.setConnectionState("connected");
      if (wasReconnect) this.scheduleReconnectResync();
    });
    this.socket.on("connect_error", () => {
      if (!this.socket.connected) this.setConnectionState("disconnected");
    });
    this.socket.on("disconnect", () => {
      this.setConnectionState("disconnected");
      this.rejectPending("disconnected");
      this.markSubscriptionsNotReady();
    });
    this.socket.io.on("reconnect_attempt", () => {
      this.setConnectionState("connecting");
    });
    this.socket.io.on("reconnect", () => {
      this.setConnectionState("connected");
      this.scheduleReconnectResync();
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
    this.replaceRegistryCache(snapshots);
    return snapshots;
  }

  async getChargePoint(id: string): Promise<ChargePointSnapshot | null> {
    try {
      const status = await this.rpc("status", {}, id);
      const snapshot = toChargePointSnapshot(status);
      this.snapshotCache.set(id, snapshot);
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
    // OCPP-level reset = disconnect then reconnect the CP to the CSMS. The
    // browser's socket.io subscription to the daemon (the events room) is
    // independent of the CP↔CSMS connection, so it persists across a reset —
    // no room re-subscribe is needed.
    await this.runCpRpc(id, "disconnect");
    await this.runCpRpc(id, "connect");
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

  async authorize(id: string, tagId: string): Promise<void> {
    await this.runCpRpc(id, "authorize", { tagId });
  }

  async startTransaction(
    id: string,
    connectorId: number,
    tagId: string,
  ): Promise<void> {
    await this.runCpRpc(id, "start_transaction", {
      connector: connectorId,
      tagId,
    });
  }

  async stopTransaction(id: string, connectorId: number): Promise<void> {
    await this.runCpRpc(id, "stop_transaction", { connector: connectorId });
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
    status: string,
  ): Promise<void> {
    await this.runCpRpc(id, "diagnostics_status_notification", { status });
  }

  async sendFirmwareStatusNotification(
    id: string,
    status: string,
  ): Promise<void> {
    await this.runCpRpc(id, "firmware_status_notification", { status });
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

  async sendMeterValue(id: string, connectorId: number): Promise<void> {
    await this.runCpRpc(id, "send_meter_value", { connector: connectorId });
  }

  async removeConnector(id: string, connectorId: number): Promise<void> {
    await this.runCpRpc(id, "remove_connector", { connector: connectorId });
  }

  async setEVSettings(
    id: string,
    connectorId: number,
    settings: EVSettings,
  ): Promise<void> {
    await this.runCpRpc(id, "set_ev_settings", {
      connector: connectorId,
      settings: settings as unknown as Record<string, unknown>,
    });
  }

  async getEVSettings(
    id: string,
    connectorId: number,
  ): Promise<EVSettings | null> {
    const snapshot = await this.getChargePoint(id);
    const connector = snapshot?.connectors.find((c) => c.id === connectorId);
    return connector?.evSettings ?? null;
  }

  async applyDefaultEVSettings(settings: EVSettings): Promise<void> {
    // The daemon's connectors never see the browser-only Default EV Settings,
    // so push it onto every connector of every known charge point (#107) via
    // a single daemon-level RPC. This must NOT go through setEVSettings
    // (per-connector, marks an explicit override, #105) — the daemon-side
    // RegistryChargePointService.applyDefaultEVSettings routes it through
    // each connector's default-propagation path instead, so an active
    // scenario/explicit override isn't clobbered.
    await this.rpc("ev_settings.apply_default", {
      settings: settings as unknown as Record<string, unknown>,
    });
  }

  async setAutoMeterValueConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    await this.runCpRpc(id, "set_auto_meter_config", {
      connector: connectorId,
      config: config as unknown as Record<string, unknown>,
    });
  }

  async getAutoMeterValueConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    const snapshot = await this.getChargePoint(id);
    const connector = snapshot?.connectors.find((c) => c.id === connectorId);
    return connector?.autoMeterValueConfig ?? null;
  }

  async getAutoMeterConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    const data = await this.rpc("connector_settings.auto_meter.get", {
      cpId: id,
      connectorId,
    });
    return (data as unknown as AutoMeterValueConfig | null) ?? null;
  }

  async saveAutoMeterConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    await this.rpc("connector_settings.auto_meter.save", {
      cpId: id,
      connectorId,
      config: config as unknown as Record<string, unknown>,
    });
  }

  async setAutoResetToAvailable(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.runCpRpc(id, "set_auto_reset_to_available", {
      connector: connectorId,
      enabled,
    });
  }

  async setConnectorMode(
    id: string,
    connectorId: number,
    mode: ScenarioMode,
  ): Promise<void> {
    await this.runCpRpc(id, "set_mode", { connector: connectorId, mode });
  }

  async setConnectorSoc(
    id: string,
    connectorId: number,
    soc: number | null,
  ): Promise<void> {
    await this.runCpRpc(id, "set_soc", { connector: connectorId, soc });
  }

  async setConnectorSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.runCpRpc(id, "set_soc_meter_sync", {
      connector: connectorId,
      enabled,
    });
  }

  async getSocMeterSync(id: string, connectorId: number): Promise<boolean> {
    return this.rpc("connector_settings.soc_meter_sync.get", {
      cpId: id,
      connectorId,
    });
  }

  async saveSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.rpc("connector_settings.soc_meter_sync.save", {
      cpId: id,
      connectorId,
      enabled,
    });
  }

  async getChargingProfiles(
    id: string,
    connectorId: number,
  ): Promise<ReadonlyArray<ActiveChargingProfile>> {
    const data = await this.runCpRpc(id, "get_charging_profiles", {
      connector: connectorId,
    });
    return (data as ActiveChargingProfile[]) ?? [];
  }

  async getStateHistory(
    id: string,
    options?: HistoryOptions,
  ): Promise<StateHistoryEntry[]> {
    this.setBounded(this.activeStateHistory, id, options);
    const data = await this.runCpRpc(
      id,
      "get_state_history",
      (options ? { options } : {}) as Params<"get_state_history">,
    );
    const list = (data as Array<Record<string, unknown>>) ?? [];
    return list.map((raw) => ({
      ...raw,
      timestamp:
        typeof raw.timestamp === "string"
          ? new Date(raw.timestamp)
          : new Date(),
    })) as unknown as StateHistoryEntry[];
  }

  async getScenarioTemplates(): Promise<ScenarioTemplateInfo[]> {
    const data = await this.rpc("scenario.templates", {});
    return data ?? [];
  }

  async listScenarioDefinitions(
    id: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition[]> {
    const data = await this.rpc("scenario.definitions.list", {
      cpId: id,
      connectorId,
    });
    return (data as unknown as ScenarioDefinition[]) ?? [];
  }

  async saveScenarioDefinition(
    id: string,
    connectorId: number | null,
    definition: ScenarioDefinition,
  ): Promise<ScenarioDefinition> {
    const data = await this.rpc("scenario.definitions.save", {
      cpId: id,
      connectorId,
      definition: definition as unknown as Record<string, unknown>,
    });
    return (data as unknown as ScenarioDefinition) ?? definition;
  }

  async replaceConnectorScenarioDefinitions(
    id: string,
    connectorId: number | null,
    definitions: readonly ScenarioDefinition[],
  ): Promise<ScenarioDefinition[]> {
    const data = await this.rpc("scenario.definitions.replace", {
      cpId: id,
      connectorId,
      definitions: definitions as unknown as Record<string, unknown>[],
    });
    return (data as unknown as ScenarioDefinition[]) ?? [...definitions];
  }

  async deleteScenarioDefinition(
    id: string,
    connectorId: number | null,
    definitionId: string,
  ): Promise<void> {
    await this.rpc("scenario.definitions.delete", {
      cpId: id,
      connectorId,
      definitionId,
    });
  }

  subscribeScenarioDefinitions(
    id: string,
    connectorId: number | null,
    handler: (definitions: ScenarioDefinition[]) => void,
  ): () => void {
    const key = scenarioDefinitionsKey(id, connectorId);
    let sub = this.scenarioDefinitionSubs.get(key);
    if (!sub) {
      sub = {
        cpId: id,
        connectorId,
        handlers: new Set(),
        ready: false,
        queued: [],
        current: [],
      };
      this.scenarioDefinitionSubs.set(key, sub);
      void this.refreshScenarioDefinitionsSubscription(key, sub);
    }

    sub.handlers.add(handler);
    if (sub.ready) {
      const definitions = [...sub.current];
      queueMicrotask(() => {
        if (!this.scenarioDefinitionSubs.get(key)?.handlers.has(handler)) {
          return;
        }
        handler(definitions);
      });
    }

    return () => {
      const current = this.scenarioDefinitionSubs.get(key);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.scenarioDefinitionSubs.delete(key);
        if (this.scenarioDefinitionSubs.size === 0) {
          this.scenarioDefinitionsScopeSubscribe = null;
          void this.rpc("events.unsubscribe", {
            scope: SCENARIO_DEFINITIONS_EVENTS_SCOPE,
          }).catch(() => {});
        }
      }
    };
  }

  async loadScenarioTemplate(
    id: string,
    templateId: string,
    connectorId: number,
    evSettings?: Partial<EVSettings>,
  ): Promise<{ scenarioId: string }> {
    const data = await this.runCpRpc(id, "load_scenario_template", {
      templateId,
      connector: connectorId,
      ...(evSettings ? { evSettings } : {}),
    });
    return (data as { scenarioId: string }) ?? { scenarioId: "" };
  }

  async loadScenario(
    id: string,
    connectorId: number,
    definition: ScenarioDefinition,
  ): Promise<{ scenarioId: string }> {
    const data = await this.runCpRpc(id, "load_scenario", {
      connector: connectorId,
      scenario: definition as unknown as Record<string, unknown>,
    });
    return (data as { scenarioId: string }) ?? { scenarioId: "" };
  }

  async listScenarios(
    id: string,
    connectorId: number,
  ): Promise<ScenarioListItem[]> {
    const data = await this.runCpRpc(id, "list_scenarios", {
      connector: connectorId,
    });
    return (data as ScenarioListItem[]) ?? [];
  }

  async runScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    await this.runCpRpc(id, "run_scenario", {
      connector: connectorId,
      scenarioId,
    });
  }

  async runScenarioFile(
    id: string,
    path: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    const data = await this.runCpRpc(id, "run_scenario_file", {
      connector: opts.connectorId ?? 1,
      file: path,
    });
    return (data as { scenarioId: string }) ?? { scenarioId: "" };
  }

  async runScenarioTemplate(
    id: string,
    templateId: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    const data = await this.runCpRpc(id, "run_scenario_template", {
      connector: opts.connectorId ?? 1,
      templateId,
      ...(opts.evSettings !== undefined
        ? {
            evSettings: opts.evSettings as unknown as Record<string, unknown>,
          }
        : {}),
    });
    return (data as { scenarioId: string }) ?? { scenarioId: "" };
  }

  async stopScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    await this.runCpRpc(id, "stop_scenario", {
      connector: connectorId,
      scenarioId,
    });
  }

  async stepScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
    force = false,
  ): Promise<void> {
    await this.runCpRpc(id, "step_scenario", {
      connector: connectorId,
      scenarioId,
      force,
    });
  }

  async stopAllScenarios(id: string, connectorId: number): Promise<void> {
    await this.runCpRpc(id, "stop_all_scenarios", {
      connector: connectorId,
    });
  }

  async removeScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    await this.runCpRpc(id, "remove_scenario", {
      connector: connectorId,
      scenarioId,
    });
  }

  async getScenarioStatus(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioExecutionContext | null> {
    const key = `${id}\u0000${connectorId}\u0000${scenarioId}`;
    this.setBounded(this.activeScenarioStatus, key, {
      cpId: id,
      connector: connectorId,
      scenarioId,
    });
    const data = await this.runCpRpc(id, "scenario_status", {
      connector: connectorId,
      scenarioId,
    });
    return (data as ScenarioExecutionContext | null) ?? null;
  }

  async getScenarioReport(
    id: string,
    connectorId: number,
    scenarioId: string,
    runId?: string,
  ): Promise<ScenarioRunResult | null> {
    const data = await this.runCpRpc(id, "scenario_report", {
      connector: connectorId,
      scenarioId,
      ...(runId === undefined ? {} : { runId }),
    });
    return (data as ScenarioRunResult | null) ?? null;
  }

  async getScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioDefinition | null> {
    const data = await this.runCpRpc(id, "get_scenario", {
      connector: connectorId,
      scenarioId,
    });
    return (data as ScenarioDefinition | null) ?? null;
  }

  subscribe(
    id: string,
    handler: (event: ChargePointEvent) => void,
  ): () => void {
    let sub = this.subs.get(id);
    if (!sub) {
      sub = { handlers: new Set(), ready: false, queued: [] };
      this.subs.set(id, sub);
      void this.subscribeScope(id).catch((err) => {
        this.emitSubscriptionError(id, err);
      });
    }

    sub.handlers.add(handler);
    const cached = this.snapshotCache.get(id);
    if (sub.ready && cached) {
      queueMicrotask(() => {
        if (!this.subs.get(id)?.handlers.has(handler)) return;
        this.emitSnapshotToHandler(handler, cached);
      });
    }

    return () => {
      const current = this.subs.get(id);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.subs.delete(id);
        void this.rpc("events.unsubscribe", { scope: id }).catch(() => {});
      }
    };
  }

  subscribeRegistry(
    handler: (event: RemoteRegistrySubscriptionEvent) => void,
  ): () => void {
    if (!this.registrySub) {
      this.registrySub = { handlers: new Set(), ready: false, queued: [] };
      void this.subscribeScope("registry").catch((err) => {
        console.error(
          "[RemoteChargePointService] registry subscribe failed",
          err,
        );
      });
    }

    this.registrySub.handlers.add(handler);
    if (this.registrySub.ready) {
      const cps = [...this.registryCache.values()];
      queueMicrotask(() => {
        if (!this.registrySub?.handlers.has(handler)) return;
        handler({ type: "snapshot", cps });
      });
    }

    return () => {
      const current = this.registrySub;
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.registrySub = null;
        void this.rpc("events.unsubscribe", { scope: "registry" }).catch(
          () => {},
        );
      }
    };
  }

  async createChargePoint(params: CreateChargePointParams): Promise<void> {
    await this.rpc("cp.create", params as Params<"cp.create">);
  }

  async updateChargePoint(params: CreateChargePointParams): Promise<void> {
    await this.rpc("cp.update", params);
  }

  async removeChargePoint(id: string): Promise<void> {
    await this.rpc("cp.delete", { cpId: id });
  }

  async ping(): Promise<{ ok: boolean; cps: number }> {
    const cps = await this.rpc("cp.list", {});
    return { ok: true, cps: cps.length };
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

  async loadConfig(): Promise<WireSimulatorConfig | null> {
    return this.rpc("config.get", {});
  }

  async saveConfig(config: SimulatorConfigInput | null): Promise<void> {
    await this.rpc("config.save", { config });
  }

  subscribeConfig(
    handler: (config: WireSimulatorConfig | null) => void,
  ): () => void {
    let sub = this.configSub;
    if (!sub) {
      sub = {
        handlers: new Set(),
        ready: false,
        queued: [],
        current: null,
      };
      this.configSub = sub;
      void this.refreshConfigSubscription(sub);
    }

    sub.handlers.add(handler);
    if (sub.ready) {
      const config = sub.current;
      queueMicrotask(() => {
        if (!this.configSub?.handlers.has(handler)) return;
        handler(config);
      });
    }

    return () => {
      const current = this.configSub;
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.configSub = null;
        this.configScopeSubscribe = null;
        void this.rpc("events.unsubscribe", {
          scope: CONFIG_EVENTS_SCOPE,
        }).catch(() => {});
      }
    };
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
    this.subs.clear();
    this.registrySub = null;
    this.configSub = null;
    this.configScopeSubscribe = null;
    this.scenarioDefinitionSubs.clear();
    this.scenarioDefinitionsScopeSubscribe = null;
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
        throw new RpcFailure(ack.error.code, ack.error.message);
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

  private markSubscriptionsNotReady(): void {
    for (const sub of this.subs.values()) {
      sub.ready = false;
      sub.queued = [];
    }
    if (this.registrySub) {
      this.registrySub.ready = false;
      this.registrySub.queued = [];
    }
    if (this.configSub) {
      this.configSub.ready = false;
      this.configSub.queued = [];
    }
    for (const sub of this.scenarioDefinitionSubs.values()) {
      sub.ready = false;
      sub.queued = [];
    }
  }

  private scheduleReconnectResync(): void {
    const serial = ++this.reconnectSerial;
    queueMicrotask(() => {
      if (serial !== this.reconnectSerial) return;
      void this.resyncAfterReconnect();
    });
  }

  private async resyncAfterReconnect(): Promise<void> {
    this.markSubscriptionsNotReady();
    const scopes = [
      ...(this.registrySub ? ["registry"] : []),
      ...(this.configSub ? [CONFIG_EVENTS_SCOPE] : []),
      ...(this.scenarioDefinitionSubs.size > 0
        ? [SCENARIO_DEFINITIONS_EVENTS_SCOPE]
        : []),
      ...this.subs.keys(),
    ];
    // Scopes are independent subscriptions; resubscribing to one doesn't
    // depend on another finishing, so run them concurrently instead of
    // paying one polling-transport round trip per scope in series.
    await Promise.all(
      scopes.map((scope) =>
        this.subscribeScope(scope).catch((err) => {
          console.warn(
            `[RemoteChargePointService] reconnect resubscribe failed for ${scope}`,
            err,
          );
        }),
      ),
    );
    await this.refetchActiveNonSnapshotViews();
  }

  private async refetchActiveNonSnapshotViews(): Promise<void> {
    const logFetches = [...this.subs.keys()].map((cpId) =>
      this.rpc("logs.get", { cpId }).catch(() => undefined),
    );
    const historyFetches = [...this.activeStateHistory.entries()].map(
      ([cpId, options]) =>
        this.rpc(
          "get_state_history",
          (options ? { options } : {}) as Params<"get_state_history">,
          cpId,
        ).catch(() => undefined),
    );
    const scenarioFetches = [...this.activeScenarioStatus.values()].map((req) =>
      this.rpc(
        "scenario_status",
        {
          connector: req.connector,
          scenarioId: req.scenarioId,
        },
        req.cpId,
      ).catch(() => undefined),
    );
    const configFetch = this.configSub
      ? this.refreshConfigSubscription(this.configSub)
      : Promise.resolve();
    const scenarioDefinitionFetches = [
      ...this.scenarioDefinitionSubs.entries(),
    ].map(([key, sub]) =>
      this.refreshScenarioDefinitionsSubscription(key, sub),
    );
    await Promise.all([
      ...logFetches,
      ...historyFetches,
      ...scenarioFetches,
      configFetch,
      ...scenarioDefinitionFetches,
    ]);
  }

  private ensureConfigEventsSubscribed(): Promise<void> {
    if (!this.configScopeSubscribe) {
      this.configScopeSubscribe = this.subscribeScope(
        CONFIG_EVENTS_SCOPE,
      ).catch((err) => {
        console.warn(
          "[RemoteChargePointService] config event subscribe failed",
          err,
        );
      });
    }
    return this.configScopeSubscribe;
  }

  private ensureScenarioDefinitionsEventsSubscribed(): Promise<void> {
    if (!this.scenarioDefinitionsScopeSubscribe) {
      this.scenarioDefinitionsScopeSubscribe = this.subscribeScope(
        SCENARIO_DEFINITIONS_EVENTS_SCOPE,
      ).catch((err) => {
        console.warn(
          "[RemoteChargePointService] scenario definitions event subscribe failed",
          err,
        );
      });
    }
    return this.scenarioDefinitionsScopeSubscribe;
  }

  private async refreshConfigSubscription(
    sub: ActiveConfigSubscription,
  ): Promise<void> {
    try {
      await this.ensureConfigEventsSubscribed();
      const config = await this.loadConfig();
      if (this.configSub !== sub) return;
      this.applyConfigValue(sub, config);
      this.flushConfigQueue(sub);
    } catch (err) {
      console.warn("[RemoteChargePointService] config subscribe failed", err);
    }
  }

  private async refreshScenarioDefinitionsSubscription(
    key: string,
    sub: ActiveScenarioDefinitionsSubscription,
  ): Promise<void> {
    try {
      await this.ensureScenarioDefinitionsEventsSubscribed();
      const definitions = await this.listScenarioDefinitions(
        sub.cpId,
        sub.connectorId,
      );
      if (this.scenarioDefinitionSubs.get(key) !== sub) return;
      this.applyScenarioDefinitionsValue(sub, definitions);
      this.flushScenarioDefinitionsQueue(key, sub);
    } catch (err) {
      console.warn(
        "[RemoteChargePointService] scenario definitions subscribe failed",
        err,
      );
    }
  }

  private async subscribeScope(scope: string): Promise<void> {
    const result = await this.rpc("events.subscribe", { scope });
    this.applySubscribeResult(scope, result);
  }

  private applySubscribeResult(scope: string, result: SubscribeResult): void {
    const registrySnapshots = result.snapshot.cps.map(cpListItemToSnapshot);
    this.replaceRegistryCache(registrySnapshots);

    for (const [cpId, status] of Object.entries(result.snapshot.perCp)) {
      this.snapshotCache.set(cpId, toChargePointSnapshot(status));
    }

    if (scope === "registry") {
      const registry = this.registrySub;
      if (!registry) return;
      registry.ready = true;
      registry.handlers.forEach((handler) => {
        this.safeRegistryHandler(handler, {
          type: "snapshot",
          cps: [...this.registryCache.values()],
        });
      });
      this.flushRegistryQueue(registry);
      return;
    }

    if (
      scope === CONFIG_EVENTS_SCOPE ||
      scope === SCENARIO_DEFINITIONS_EVENTS_SCOPE
    ) {
      return;
    }

    const sub = this.subs.get(scope);
    if (!sub) return;
    sub.ready = true;
    const snapshot = this.snapshotCache.get(scope);
    if (snapshot) {
      sub.handlers.forEach((handler) => {
        this.emitSnapshotToHandler(handler, snapshot);
      });
    }
    this.flushCpQueue(scope, sub);
  }

  private replaceRegistryCache(snapshots: ChargePointSnapshot[]): void {
    this.registryCache.clear();
    for (const snapshot of snapshots) {
      this.registryCache.set(snapshot.id, snapshot);
    }
  }

  private handleEnvelope = (envelope: EventEnvelope): void => {
    if (envelope.kind === "cp") {
      const sub = this.subs.get(envelope.cpId);
      if (!sub) return;
      if (!sub.ready) {
        sub.queued.push(envelope);
        return;
      }
      this.deliverCpEnvelope(envelope, sub);
      return;
    }

    if (envelope.kind === "config") {
      const sub = this.configSub;
      if (!sub) return;
      if (!sub.ready) {
        sub.queued.push(envelope);
        return;
      }
      this.deliverConfigEnvelope(envelope, sub);
      return;
    }

    if (envelope.kind === "scenario-definitions") {
      const key = scenarioDefinitionsKey(envelope.cpId, envelope.connectorId);
      const sub = this.scenarioDefinitionSubs.get(key);
      if (!sub) return;
      if (!sub.ready) {
        sub.queued.push(envelope);
        return;
      }
      this.deliverScenarioDefinitionsEnvelope(envelope, sub);
      return;
    }

    const registry = this.registrySub;
    if (!registry) return;
    if (!registry.ready) {
      registry.queued.push(envelope);
      return;
    }
    this.deliverRegistryEnvelope(envelope, registry);
  };

  private flushCpQueue(cpId: string, sub: ActiveSubscription): void {
    const queued = sub.queued;
    sub.queued = [];
    for (const envelope of queued) {
      if (envelope.cpId === cpId) this.deliverCpEnvelope(envelope, sub);
    }
  }

  private flushRegistryQueue(registry: ActiveRegistrySubscription): void {
    const queued = registry.queued;
    registry.queued = [];
    queued.forEach((envelope) => {
      this.deliverRegistryEnvelope(envelope, registry);
    });
  }

  private flushConfigQueue(sub: ActiveConfigSubscription): void {
    const queued = sub.queued;
    sub.queued = [];
    queued.forEach((envelope) => {
      this.deliverConfigEnvelope(envelope, sub);
    });
  }

  private flushScenarioDefinitionsQueue(
    key: string,
    sub: ActiveScenarioDefinitionsSubscription,
  ): void {
    const queued = sub.queued;
    sub.queued = [];
    queued.forEach((envelope) => {
      if (scenarioDefinitionsKey(envelope.cpId, envelope.connectorId) === key) {
        this.deliverScenarioDefinitionsEnvelope(envelope, sub);
      }
    });
  }

  private deliverCpEnvelope(
    envelope: CpEventEnvelope,
    sub: ActiveSubscription,
  ): void {
    const mapped = mapServerEventToChargePointEvent(envelope.evt);
    if (!mapped) return;
    sub.handlers.forEach((handler) => this.safeCpHandler(handler, mapped));
  }

  private deliverConfigEnvelope(
    envelope: ConfigEventEnvelope,
    sub: ActiveConfigSubscription,
  ): void {
    this.applyConfigValue(sub, envelope.config);
  }

  private deliverScenarioDefinitionsEnvelope(
    envelope: ScenarioDefinitionsEventEnvelope,
    sub: ActiveScenarioDefinitionsSubscription,
  ): void {
    this.applyScenarioDefinitionsValue(
      sub,
      envelope.definitions as unknown as ScenarioDefinition[],
    );
  }

  private deliverRegistryEnvelope(
    envelope: RegistryEventEnvelope,
    registry: ActiveRegistrySubscription,
  ): void {
    if (envelope.change === "reset") {
      this.registryCache.clear();
      registry.handlers.forEach((handler) => {
        this.safeRegistryHandler(handler, {
          type: "change",
          change: "reset",
        });
      });
      return;
    }

    const cp = envelope.cp ? cpListItemToSnapshot(envelope.cp) : undefined;
    if (cp) {
      if (envelope.change === "removed") {
        this.registryCache.delete(cp.id);
      } else {
        this.registryCache.set(cp.id, cp);
      }
    }

    registry.handlers.forEach((handler) => {
      this.safeRegistryHandler(handler, {
        type: "change",
        change: envelope.change,
        cp,
      });
    });
  }

  private applyConfigValue(
    sub: ActiveConfigSubscription,
    config: WireSimulatorConfig | null,
  ): void {
    sub.ready = true;
    sub.current = config;
    sub.handlers.forEach((handler) => {
      this.safeConfigHandler(handler, config);
    });
  }

  private applyScenarioDefinitionsValue(
    sub: ActiveScenarioDefinitionsSubscription,
    definitions: ScenarioDefinition[],
  ): void {
    sub.ready = true;
    sub.current = [...definitions];
    sub.handlers.forEach((handler) => {
      this.safeScenarioDefinitionsHandler(handler, [...definitions]);
    });
  }

  private emitSnapshotToHandler(
    handler: (event: ChargePointEvent) => void,
    snapshot: ChargePointSnapshot,
  ): void {
    snapshotToEvents(snapshot).forEach((event) => {
      this.safeCpHandler(handler, event);
    });
  }

  private emitSubscriptionError(id: string, err: unknown): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    const message = err instanceof Error ? err.message : String(err);
    sub.handlers.forEach((handler) => {
      this.safeCpHandler(handler, { type: "error", error: message });
    });
  }

  private safeCpHandler(
    handler: (event: ChargePointEvent) => void,
    event: ChargePointEvent,
  ): void {
    try {
      handler(event);
    } catch (err) {
      console.error("[RemoteChargePointService] handler error", err);
    }
  }

  private safeRegistryHandler(
    handler: (event: RemoteRegistrySubscriptionEvent) => void,
    event: RemoteRegistrySubscriptionEvent,
  ): void {
    try {
      handler(event);
    } catch (err) {
      console.error("[RemoteChargePointService] registry handler error", err);
    }
  }

  private safeConfigHandler(
    handler: (config: WireSimulatorConfig | null) => void,
    config: WireSimulatorConfig | null,
  ): void {
    try {
      handler(config);
    } catch (err) {
      console.error("[RemoteChargePointService] config handler error", err);
    }
  }

  private safeScenarioDefinitionsHandler(
    handler: (definitions: ScenarioDefinition[]) => void,
    definitions: ScenarioDefinition[],
  ): void {
    try {
      handler(definitions);
    } catch (err) {
      console.error(
        "[RemoteChargePointService] scenario definitions handler error",
        err,
      );
    }
  }
}

function scenarioDefinitionsKey(
  cpId: string,
  connectorId: number | null,
): string {
  return `${cpId}\u0000${connectorId ?? "cp"}`;
}
