import type {
  ChargePointEvent,
  ChargePointService,
  ChargePointSnapshot,
  ConnectorSnapshot,
  CreateChargePointParams,
  ScenarioListItem,
  ScenarioTemplateInfo,
} from "../interfaces/ChargePointService";
import type {
  OCPPAvailability,
  OCPPStatus,
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
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "../../cp/application/services/types/StateSnapshot";

interface ServerCpListItem {
  cpId: string;
  status?: string;
  connectors?: number;
}

interface ServerConnectorStatus {
  id: number;
  status: string;
  availability: string;
  meterValue: number;
  transactionId: number | null;
  soc?: number | null;
  mode?: string;
  autoResetToAvailable?: boolean;
  autoMeterValueConfig?: Record<string, unknown> | null;
  evSettings?: Record<string, unknown> | null;
  chargingProfile?: Record<string, unknown> | null;
  chargingProfiles?: Array<Record<string, unknown>>;
  transactionStartTime?: string | null;
  transactionTagId?: string | null;
  transactionBatteryCapacityKwh?: number | null;
}

interface ServerCpStatus {
  id: string;
  status: string;
  error: string;
  connectors: ServerConnectorStatus[];
}

interface ServerEventEnvelope {
  cpId?: string; // present on /v1/events, absent on /v1/cp/:cpId/events
  event: string;
  data: unknown;
  timestamp?: string;
}

interface ServerCommandResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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

function toChargePointSnapshot(s: ServerCpStatus): ChargePointSnapshot {
  return {
    id: s.id,
    status: s.status as OCPPStatus,
    error: s.error ?? "",
    connectors: (s.connectors ?? []).map(toConnectorSnapshot),
  };
}

function deriveWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
}

function mapServerEventToChargePointEvent(
  evt: ServerEventEnvelope,
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

interface ActiveSubscription {
  socket: WebSocket;
  handlers: Set<(event: ChargePointEvent) => void>;
  url: string;
}

export class RemoteChargePointService implements ChargePointService {
  private readonly subs = new Map<string, ActiveSubscription>();

  constructor(private readonly serverUrl: string) {}

  async listChargePoints(): Promise<ChargePointSnapshot[]> {
    const list = await this.fetchJson<ServerCpListItem[]>("GET", "/v1/cp");
    // Fetch detailed status for each cpId in parallel so the UI can reflect connectors.
    const detail = await Promise.all(
      list.map((entry) => this.getChargePoint(entry.cpId).catch(() => null)),
    );
    return detail.filter((v): v is ChargePointSnapshot => v !== null);
  }

  async getChargePoint(id: string): Promise<ChargePointSnapshot | null> {
    try {
      const status = await this.fetchJson<ServerCpStatus>(
        "GET",
        `/v1/cp/${encodeURIComponent(id)}`,
      );
      return toChargePointSnapshot(status);
    } catch (err) {
      // 404 -> null, other errors rethrow
      if (err instanceof RemoteHttpError && err.status === 404) return null;
      throw err;
    }
  }

  async connect(id: string): Promise<void> {
    await this.runCommand(id, "connect");
  }

  async disconnect(id: string): Promise<void> {
    await this.runCommand(id, "disconnect");
  }

  async reset(id: string): Promise<void> {
    // Server CLI doesn't expose `reset` directly; closest equivalent is disconnect
    // followed by connect. Keep this simple: just reconnect.
    await this.runCommand(id, "disconnect");
    await this.runCommand(id, "connect");
  }

  async sendHeartbeat(id: string): Promise<void> {
    await this.runCommand(id, "heartbeat");
  }

  async startHeartbeat(id: string, intervalSeconds: number): Promise<void> {
    await this.runCommand(id, "start_heartbeat", { interval: intervalSeconds });
  }

  async stopHeartbeat(id: string): Promise<void> {
    await this.runCommand(id, "stop_heartbeat");
  }

  async authorize(id: string, tagId: string): Promise<void> {
    await this.runCommand(id, "authorize", { tagId });
  }

  async startTransaction(
    id: string,
    connectorId: number,
    tagId: string,
  ): Promise<void> {
    await this.runCommand(id, "start_transaction", {
      connector: connectorId,
      tagId,
    });
  }

  async stopTransaction(id: string, connectorId: number): Promise<void> {
    await this.runCommand(id, "stop_transaction", { connector: connectorId });
  }

  async sendStatusNotification(
    id: string,
    connectorId: number,
    status: OCPPStatus,
  ): Promise<void> {
    await this.runCommand(id, "update_connector_status", {
      connector: connectorId,
      status,
    });
  }

  async setMeterValue(
    id: string,
    connectorId: number,
    value: number,
  ): Promise<void> {
    await this.runCommand(id, "set_meter_value", {
      connector: connectorId,
      value,
    });
  }

  async sendMeterValue(id: string, connectorId: number): Promise<void> {
    await this.runCommand(id, "send_meter_value", { connector: connectorId });
  }

  async removeConnector(id: string, connectorId: number): Promise<void> {
    await this.runCommand(id, "remove_connector", { connector: connectorId });
  }

  async setEVSettings(
    id: string,
    connectorId: number,
    settings: EVSettings,
  ): Promise<void> {
    await this.runCommand(id, "set_ev_settings", {
      connector: connectorId,
      settings,
    });
  }

  async setAutoMeterValueConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    await this.runCommand(id, "set_auto_meter_config", {
      connector: connectorId,
      config,
    });
  }

  async setAutoResetToAvailable(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.runCommand(id, "set_auto_reset_to_available", {
      connector: connectorId,
      enabled,
    });
  }

  async setConnectorMode(
    id: string,
    connectorId: number,
    mode: ScenarioMode,
  ): Promise<void> {
    await this.runCommand(id, "set_mode", { connector: connectorId, mode });
  }

  async setConnectorSoc(
    id: string,
    connectorId: number,
    soc: number | null,
  ): Promise<void> {
    await this.runCommand(id, "set_soc", { connector: connectorId, soc });
  }

  async getChargingProfiles(
    id: string,
    connectorId: number,
  ): Promise<ReadonlyArray<ActiveChargingProfile>> {
    const data = await this.runCommand(id, "get_charging_profiles", {
      connector: connectorId,
    });
    return (data as ActiveChargingProfile[]) ?? [];
  }

  async getStateHistory(
    id: string,
    options?: HistoryOptions,
  ): Promise<StateHistoryEntry[]> {
    const data = await this.runCommand(
      id,
      "get_state_history",
      options ? { options } : undefined,
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
    // The /v1/cp/:id/command endpoint requires a cpId; the templates list is
    // CP-agnostic. We synthesize a request against the first CP in the
    // registry, falling back to an empty list when no CP is registered.
    const list = await this.listChargePoints().catch(() => []);
    if (list.length === 0) return [];
    const data = await this.runCommand(list[0].id, "list_scenario_templates");
    return (data as ScenarioTemplateInfo[]) ?? [];
  }

  async loadScenarioTemplate(
    id: string,
    templateId: string,
    connectorId: number,
  ): Promise<{ scenarioId: string }> {
    const data = await this.runCommand(id, "load_scenario_template", {
      templateId,
      connector: connectorId,
    });
    return (data as { scenarioId: string }) ?? { scenarioId: "" };
  }

  async loadScenario(
    id: string,
    connectorId: number,
    definition: ScenarioDefinition,
  ): Promise<{ scenarioId: string }> {
    const data = await this.runCommand(id, "load_scenario", {
      connector: connectorId,
      scenario: definition,
    });
    return (data as { scenarioId: string }) ?? { scenarioId: "" };
  }

  async listScenarios(
    id: string,
    connectorId: number,
  ): Promise<ScenarioListItem[]> {
    const data = await this.runCommand(id, "list_scenarios", {
      connector: connectorId,
    });
    return (data as ScenarioListItem[]) ?? [];
  }

  async runScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    await this.runCommand(id, "run_scenario", {
      connector: connectorId,
      scenarioId,
    });
  }

  async stopScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    await this.runCommand(id, "stop_scenario", {
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
    await this.runCommand(id, "step_scenario", {
      connector: connectorId,
      scenarioId,
      force,
    });
  }

  async stopAllScenarios(id: string, connectorId: number): Promise<void> {
    await this.runCommand(id, "stop_all_scenarios", {
      connector: connectorId,
    });
  }

  async getScenarioStatus(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioExecutionContext | null> {
    const data = await this.runCommand(id, "scenario_status", {
      connector: connectorId,
      scenarioId,
    });
    return (data as ScenarioExecutionContext | null) ?? null;
  }

  async getScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioDefinition | null> {
    const data = await this.runCommand(id, "get_scenario", {
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
      const wsBase = deriveWsUrl(this.serverUrl);
      const url = `${wsBase}/v1/cp/${encodeURIComponent(id)}/events`;
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        // Invalid URL (e.g. malformed base) — surface as an error event and
        // bail out without registering the handler.
        console.error(
          `[RemoteChargePointService] failed to open WebSocket ${url}`,
          err,
        );
        queueMicrotask(() =>
          handler({
            type: "error",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return () => {
          // no-op; nothing was subscribed
        };
      }
      sub = { socket, handlers: new Set(), url };
      this.subs.set(id, sub);

      socket.onmessage = (e: MessageEvent) => {
        const data = typeof e.data === "string" ? e.data : "";
        if (!data) return;
        try {
          const parsed = JSON.parse(data) as ServerEventEnvelope;
          const mapped = mapServerEventToChargePointEvent(parsed);
          if (!mapped) return;
          const current = this.subs.get(id);
          current?.handlers.forEach((h) => {
            try {
              h(mapped);
            } catch (err) {
              console.error("[RemoteChargePointService] handler error", err);
            }
          });
        } catch (err) {
          console.error(
            "[RemoteChargePointService] failed to parse event payload",
            err,
          );
        }
      };

      socket.onerror = () => {
        console.warn(`[RemoteChargePointService] WS error for ${id} (${url})`);
      };

      socket.onclose = () => {
        // Drop the subscription record so the next subscribe re-opens.
        if (this.subs.get(id) === sub) this.subs.delete(id);
      };
    }

    sub.handlers.add(handler);

    // Best-effort: kick off an initial status snapshot for the handler.
    this.getChargePoint(id)
      .then((snapshot) => {
        if (!snapshot) return;
        try {
          handler({ type: "status", status: snapshot.status });
          if (snapshot.error) {
            handler({ type: "error", error: snapshot.error });
          }
        } catch {
          // best effort
        }
      })
      .catch(() => {});

    return () => {
      const current = this.subs.get(id);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        try {
          current.socket.close();
        } catch {
          // best effort
        }
        this.subs.delete(id);
      }
    };
  }

  async createChargePoint(params: CreateChargePointParams): Promise<void> {
    const result = await this.fetchJson<ServerCommandResult>(
      "POST",
      "/v1/cp",
      params,
    );
    if (!result.ok) {
      throw new Error(result.error ?? "Failed to create charge point");
    }
  }

  async removeChargePoint(id: string): Promise<void> {
    await this.fetchJson<unknown>("DELETE", `/v1/cp/${encodeURIComponent(id)}`);
  }

  async ping(): Promise<{ ok: boolean; cps: number }> {
    return this.fetchJson<{ ok: boolean; cps: number }>("GET", "/healthz");
  }

  /** Close all internal WebSocket subscriptions. */
  dispose(): void {
    for (const sub of this.subs.values()) {
      try {
        sub.socket.close();
      } catch {
        // ignore
      }
    }
    this.subs.clear();
  }

  // ---------- internals ----------

  private async runCommand(
    id: string,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const body: { command: string; params?: Record<string, unknown> } = {
      command,
    };
    if (params) body.params = params;
    const result = await this.fetchJson<ServerCommandResult>(
      "POST",
      `/v1/cp/${encodeURIComponent(id)}/command`,
      body,
    );
    if (!result.ok) {
      throw new Error(result.error ?? `Command "${command}" failed`);
    }
    return result.data;
  }

  private async fetchJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.serverUrl.replace(/\/+$/, "")}${path}`;
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      throw new RemoteHttpError(res.status, text || res.statusText);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}

export class RemoteHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`HTTP ${status}: ${message}`);
    this.name = "RemoteHttpError";
  }
}
