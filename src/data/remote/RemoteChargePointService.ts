import type {
  ChargePointEvent,
  ChargePointService,
  ChargePointSnapshot,
  ConnectorSnapshot,
} from "../interfaces/ChargePointService";
import type {
  OCPPAvailability,
  OCPPStatus,
} from "../../cp/domain/types/OcppTypes";
import { LogLevel, LogType } from "../../cp/shared/Logger";

interface ServerCpListItem {
  cpId: string;
  status?: string;
  connectors?: number;
}

interface ServerCpStatus {
  id: string;
  status: string;
  error: string;
  connectors: Array<{
    id: number;
    status: string;
    availability: string;
    meterValue: number;
    transactionId: number | null;
  }>;
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

function toConnectorSnapshot(
  c: ServerCpStatus["connectors"][number],
): ConnectorSnapshot {
  return {
    id: c.id,
    status: c.status as OCPPStatus,
    availability: c.availability as OCPPAvailability,
    meterValue: c.meterValue,
    transactionId: c.transactionId,
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
    default:
      // scenario_* and other server-only events are not part of the browser event union
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

  /**
   * Server-side helpers — not part of ChargePointService, but useful when wiring up
   * the browser UI. Lets callers create or destroy CPs on the connected server.
   */
  async createChargePoint(init: {
    cpId: string;
    wsUrl: string;
    connectors?: number;
    vendor?: string;
    model?: string;
    basicAuth?: { username: string; password: string } | null;
    autoConnect?: boolean;
  }): Promise<void> {
    const result = await this.fetchJson<ServerCommandResult>(
      "POST",
      "/v1/cp",
      init,
    );
    if (!result.ok) {
      throw new Error(result.error ?? "Failed to create charge point");
    }
  }

  async deleteChargePoint(id: string): Promise<void> {
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
