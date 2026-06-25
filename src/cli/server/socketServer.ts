import type {
  Server as BunServer,
  ServerWebSocket,
  WebSocketHandler,
} from "bun";
import { Server as Engine } from "@socket.io/bun-engine";
import {
  Server as SocketIoServer,
  type Socket as SocketIoSocket,
} from "socket.io";

import { handleJsonCommand } from "../jsonMode";
import type { CLIChargePointService } from "../service";
import {
  EXPLICIT_METHODS,
  INFLIGHT_CAP,
  MAX_HTTP_BUFFER,
  METHODS,
  ROOM_CAP,
  RPC_RATE_PER_SEC,
  RPC_TIMEOUT_MS,
  RpcFailure,
  isRpcMethod,
  registryCpToWire,
  rpcRequestSchema,
  statusToWire,
  subscribeResultSchema,
  type CpListItem,
  type RpcAck,
  type RpcErrorCode,
  type StatusWire,
  type SubscribeResult,
} from "../../protocol";
import type { Database } from "../../cp/domain/persistence/Database";
import { resetSimulatorState } from "../../cp/domain/persistence/resetState";
import { LogLevel } from "../../cp/shared/Logger";
import type { CPRegistry } from "./CPRegistry";
import type { EventBus } from "./eventBus";
import { parseCreateBody, type HttpHandlers } from "./httpServer";
import {
  createRegistryEventBridge,
  type RegistryEventBridge,
} from "./registryEvents";

export const SOCKET_IO_PATH = "/socket.io/";
export const SOCKET_IO_PING_INTERVAL_MS = 25_000;
export const SOCKET_IO_PING_TIMEOUT_MS = 20_000;

type SocketIoWebSocketData = { transport?: unknown };
type AnyWebSocket = ServerWebSocket<Record<string, unknown>>;
type AnyWebSocketHandler = WebSocketHandler<Record<string, unknown>>;

export interface SocketIoAttachment {
  readonly io: SocketIoServer;
  readonly engine: Engine;
  readonly websocket: AnyWebSocketHandler;
  readonly idleTimeout: number;
  handleRequest(
    req: Request,
    server: BunServer<Record<string, unknown>>,
  ): Promise<Response>;
  close(): Promise<void>;
}

export interface SocketIoDeps {
  readonly registry: CPRegistry;
  readonly bus: EventBus;
  readonly database?: Database | null;
  readonly requestShutdown?: () => void;
  readonly webConsoleBasicAuth?: {
    readonly username: string;
    readonly password: string;
  } | null;
  readonly registryEvents?: RegistryEventBridge | null;
}

interface SocketRpcState {
  inFlight: number;
  tokens: number;
  lastRefillMs: number;
  joinedScopes: Set<string>;
}

type RpcAckFn = (ack: RpcAck) => void;
type DirectAckFn = (ack: unknown) => void;
type FullCp = Parameters<typeof registryCpToWire>[0];
type RpcMethod = keyof typeof METHODS;

const EXPLICIT_METHOD_SET = new Set<string>(EXPLICIT_METHODS);

export function isSocketIoPath(pathname: string): boolean {
  return pathname === "/socket.io" || pathname.startsWith(SOCKET_IO_PATH);
}

export function attachSocketIo(deps?: SocketIoDeps): SocketIoAttachment {
  const io = new SocketIoServer({
    serveClient: false,
    maxHttpBufferSize: MAX_HTTP_BUFFER,
    pingInterval: SOCKET_IO_PING_INTERVAL_MS,
    pingTimeout: SOCKET_IO_PING_TIMEOUT_MS,
  });
  const engine = new Engine({
    path: SOCKET_IO_PATH,
    pingInterval: SOCKET_IO_PING_INTERVAL_MS,
    pingTimeout: SOCKET_IO_PING_TIMEOUT_MS,
    maxHttpBufferSize: MAX_HTTP_BUFFER,
  });

  io.bind(engine);
  const registryEvents = deps
    ? createRegistryEventBridge(io, { registry: deps.registry, bus: deps.bus })
    : null;
  const runtimeDeps = deps ? { ...deps, registryEvents } : undefined;
  registerSocketHandlers(io, runtimeDeps);

  const handler = engine.handler();
  const idleTimeout = Math.max(
    handler.idleTimeout,
    Math.floor(SOCKET_IO_PING_INTERVAL_MS / 1_000) + 1,
  );

  return {
    io,
    engine,
    websocket: handler.websocket as AnyWebSocketHandler,
    idleTimeout,
    handleRequest(req, server) {
      return engine.handleRequest(req, server as never);
    },
    close() {
      registryEvents?.close();
      engine.close();
      return new Promise((resolve) => {
        io.close(() => resolve());
      });
    },
  };
}

export function registerSocketHandlers(
  io: SocketIoServer,
  deps?: SocketIoDeps,
): void {
  registerSocketAuth(io, deps?.webConsoleBasicAuth ?? null);

  io.on("connection", (socket) => {
    if (!deps) return;

    const state: SocketRpcState = {
      inFlight: 0,
      tokens: RPC_RATE_PER_SEC,
      lastRefillMs: Date.now(),
      joinedScopes: new Set(),
    };

    socket.on("rpc", (request: unknown, ack?: RpcAckFn) => {
      if (typeof ack !== "function") return;
      void handleRpc(socket, state, deps, request, ack);
    });

    socket.on("events.subscribe", (request: unknown, ack?: DirectAckFn) => {
      if (typeof ack !== "function") return;
      try {
        ack(subscribeSocket(socket, state, deps, request));
      } catch (err) {
        ack(directError(err));
      }
    });

    socket.on("events.unsubscribe", (request: unknown, ack?: DirectAckFn) => {
      if (typeof ack !== "function") return;
      try {
        unsubscribeSocket(socket, state, request);
        ack({ ok: true });
      } catch (err) {
        ack(directError(err));
      }
    });

    socket.on("disconnect", () => {
      state.joinedScopes.clear();
      state.inFlight = 0;
    });
  });
}

async function handleRpc(
  socket: SocketIoSocket,
  state: SocketRpcState,
  deps: SocketIoDeps,
  request: unknown,
  ack: RpcAckFn,
): Promise<void> {
  if (!consumeRpcToken(state)) {
    ack(errorAck("invalid_params"));
    return;
  }
  if (state.inFlight >= INFLIGHT_CAP) {
    ack(errorAck("invalid_params"));
    return;
  }

  state.inFlight += 1;
  try {
    const result = await withRpcDeadline(
      dispatchRpc(socket, state, deps, request),
    );
    ack({ ok: true, result });
  } catch (err) {
    ack(errorAck(errorCodeFrom(err)));
  } finally {
    state.inFlight = Math.max(0, state.inFlight - 1);
  }
}

async function dispatchRpc(
  socket: SocketIoSocket,
  state: SocketRpcState,
  deps: SocketIoDeps,
  request: unknown,
): Promise<unknown> {
  const parsedRequest = rpcRequestSchema.safeParse(request);
  if (!parsedRequest.success) throw new RpcFailure("invalid_params", "");

  const { cpId, method } = parsedRequest.data;
  const rawParams = readRawParams(request);

  if (!isRpcMethod(method)) throw new RpcFailure("not_found", "");

  const params = METHODS[method].params.safeParse(rawParams);
  if (!params.success) throw new RpcFailure("invalid_params", "");

  const result = await dispatchValidatedRpc(
    socket,
    state,
    deps,
    method,
    cpId,
    rawParams,
  );
  const parsedResult = METHODS[method].result.safeParse(result);
  if (!parsedResult.success) throw new Error("RPC result failed validation");
  return parsedResult.data;
}

async function dispatchValidatedRpc(
  socket: SocketIoSocket,
  state: SocketRpcState,
  deps: SocketIoDeps,
  method: RpcMethod,
  cpId: string | undefined,
  rawParams: unknown,
): Promise<unknown> {
  switch (method) {
    case "cp.list":
      return listCps(deps.registry);
    case "cp.create":
      return createCp(deps, rawParams);
    case "cp.update":
      return updateCp(deps, rawParams);
    case "cp.delete":
      return deleteCp(deps, rawParams);
    case "logs.get":
      return getLogs(deps, rawParams);
    case "logs.clear":
      return clearLogs(deps, rawParams);
    case "state.reset":
      return resetState(deps);
    case "server.shutdown":
      return shutdownServer(deps);
    case "events.subscribe":
      return subscribeSocket(socket, state, deps, rawParams);
    case "events.unsubscribe":
      unsubscribeSocket(socket, state, rawParams);
      return { ok: true };
    default:
      break;
  }

  if (EXPLICIT_METHOD_SET.has(method)) {
    throw new RpcFailure("not_found", "");
  }

  if (!cpId) throw new RpcFailure("not_found", "");
  const service = deps.registry.get(cpId);
  if (!service) throw new RpcFailure("not_found", "");

  const result = await handleJsonCommand(service, {
    command: method,
    params: rawParamsAsRecord(rawParams),
  });
  return method === "status"
    ? statusToWire(result as Parameters<typeof statusToWire>[0])
    : result;
}

function listCps(registry: CPRegistry): CpListItem[] {
  return registry
    .list()
    .map((cpId) => {
      const service = registry.get(cpId);
      return service
        ? registryCpToWire(statusCpForWire(cpId, service, service.getStatus()))
        : null;
    })
    .filter((cp): cp is CpListItem => cp !== null);
}

function createCp(deps: SocketIoDeps, rawParams: unknown): { cpId: string } {
  const init = parseCreateInput(rawParams);
  try {
    const service = deps.registry.create(init);
    if (rawParamsAsRecord(rawParams).autoConnect === true) {
      void service.connect().catch((err) => {
        process.stderr.write(
          `[server] autoConnect failed for ${init.cpId}: ${safeLogMessage(err)}\n`,
        );
      });
    }
    return { cpId: init.cpId };
  } catch (err) {
    if (err instanceof Error && err.message.includes("already exists")) {
      throw new RpcFailure("invalid_params", "");
    }
    throw err;
  }
}

function updateCp(deps: SocketIoDeps, rawParams: unknown): { cpId: string } {
  const init = parseCreateInput(rawParams);
  if (!deps.registry.has(init.cpId)) throw new RpcFailure("not_found", "");
  const service = deps.registry.update(init);
  if (rawParamsAsRecord(rawParams).autoConnect === true) {
    void service.connect().catch((err) => {
      process.stderr.write(
        `[server] reconnect after update failed for ${init.cpId}: ${safeLogMessage(err)}\n`,
      );
    });
  }
  return { cpId: init.cpId };
}

function deleteCp(deps: SocketIoDeps, rawParams: unknown): { ok: true } {
  const cpId = stringParam(rawParams, "cpId");
  if (!deps.registry.remove(cpId)) throw new RpcFailure("not_found", "");
  return { ok: true };
}

function getLogs(
  deps: SocketIoDeps,
  rawParams: unknown,
): ReadonlyArray<Record<string, unknown>> {
  const params = rawParamsAsRecord(rawParams);
  const cpId = stringParam(params, "cpId");
  const service = deps.registry.get(cpId);
  service?.flushLogs();

  let entries: Array<Record<string, unknown>> = [];
  if (deps.database) {
    const rows = deps.database.all<{
      timestamp: string;
      level: string;
      log_type: string;
      message: string;
    }>(
      "SELECT timestamp, level, log_type, message FROM logs " +
        "WHERE cp_id = ? ORDER BY id ASC",
      [cpId],
    );
    if (rows.length > 0) {
      entries = rows.map((row) => ({
        timestamp: row.timestamp,
        level: row.level,
        type: row.log_type,
        cpId,
        message: row.message,
      }));
    }
  }

  if (entries.length === 0) {
    entries = (service?.getInMemoryLogs() ?? []).map((entry) => ({
      timestamp: entry.timestamp.toISOString(),
      level: LogLevel[entry.level] ?? "INFO",
      type: entry.type,
      cpId,
      message: entry.message,
    }));
  }

  const limit = params.limit;
  return typeof limit === "number" ? entries.slice(0, limit) : entries;
}

function clearLogs(deps: SocketIoDeps, rawParams: unknown): { ok: true } {
  const cpId = stringParam(rawParams, "cpId");
  if (deps.database) {
    deps.database.run("DELETE FROM logs WHERE cp_id = ?", [cpId]);
    void deps.database.flush?.();
  }
  return { ok: true };
}

function resetState(deps: SocketIoDeps): { ok: true } {
  for (const cpId of [...deps.registry.list()]) {
    deps.registry.remove(cpId, { notify: false });
  }
  if (deps.database) {
    resetSimulatorState(deps.database);
    void deps.database.flush?.();
  }
  deps.registryEvents?.emitReset();
  return { ok: true };
}

function shutdownServer(deps: SocketIoDeps): { ok: true } {
  if (deps.requestShutdown) {
    setTimeout(() => deps.requestShutdown?.(), 100);
  }
  return { ok: true };
}

function subscribeSocket(
  socket: SocketIoSocket,
  state: SocketRpcState,
  deps: SocketIoDeps,
  rawParams: unknown,
): SubscribeResult {
  const params = METHODS["events.subscribe"].params.safeParse(rawParams);
  if (!params.success) throw new RpcFailure("invalid_params", "");

  const { scope } = params.data;
  if (!isValidSubscribeScope(deps.registry, scope)) {
    throw new RpcFailure("invalid_params", "");
  }
  if (!state.joinedScopes.has(scope) && state.joinedScopes.size >= ROOM_CAP) {
    throw new RpcFailure("invalid_params", "");
  }

  void socket.join(scope);
  state.joinedScopes.add(scope);
  const result = captureSubscribeSnapshot(deps.registry, scope);
  const parsed = subscribeResultSchema.safeParse(result);
  if (!parsed.success) throw new Error("subscribe snapshot failed validation");
  return parsed.data;
}

function unsubscribeSocket(
  socket: SocketIoSocket,
  state: SocketRpcState,
  rawParams: unknown,
): void {
  const params = METHODS["events.unsubscribe"].params.safeParse(rawParams);
  if (!params.success) throw new RpcFailure("invalid_params", "");
  const { scope } = params.data;
  void socket.leave(scope);
  state.joinedScopes.delete(scope);
}

function captureSubscribeSnapshot(
  registry: CPRegistry,
  scope: string,
): SubscribeResult {
  const entries = registry
    .list()
    .map((cpId) => {
      const service = registry.get(cpId);
      if (!service) return null;
      const status = service.getStatus();
      return {
        cpId,
        cp: statusCpForWire(cpId, service, status),
        status: statusToWire(status),
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        cpId: string;
        cp: FullCp;
        status: StatusWire;
      } => entry !== null,
    );

  const perCp: Record<string, StatusWire> = {};
  for (const entry of entries) {
    if (scope === "*" || scope === "registry" || scope === entry.cpId) {
      perCp[entry.cpId] = entry.status;
    }
  }

  return {
    subscribed: [scope],
    snapshot: {
      cps: entries.map((entry) => registryCpToWire(entry.cp)),
      perCp,
    },
  };
}

function statusCpForWire(
  cpId: string,
  service: CLIChargePointService,
  status: ReturnType<CLIChargePointService["getStatus"]>,
): FullCp {
  const init = service.getInit();
  return {
    id: cpId,
    status: status.status,
    config: status.config ?? {
      wsUrl: init.wsUrl,
      connectors: init.connectors,
      vendor: init.vendor,
      model: init.model,
      basicAuth: init.basicAuth,
      ocppVersion: init.ocppVersion,
      bootNotification: init.bootNotification ?? null,
    },
  };
}

function parseCreateInput(
  rawParams: unknown,
): ReturnType<typeof parseCreateBody> {
  try {
    return parseCreateBody(rawParams);
  } catch {
    throw new RpcFailure("invalid_params", "");
  }
}

function isValidSubscribeScope(registry: CPRegistry, scope: string): boolean {
  return scope === "*" || scope === "registry" || registry.has(scope);
}

function readRawParams(request: unknown): unknown {
  if (request && typeof request === "object" && "params" in request) {
    return (request as { params?: unknown }).params ?? {};
  }
  return {};
}

function rawParamsAsRecord(rawParams: unknown): Record<string, unknown> {
  return rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
    ? (rawParams as Record<string, unknown>)
    : {};
}

function stringParam(rawParams: unknown, key: string): string {
  const value = rawParamsAsRecord(rawParams)[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RpcFailure("invalid_params", "");
  }
  return value;
}

function consumeRpcToken(state: SocketRpcState): boolean {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, now - state.lastRefillMs) / 1_000;
  state.tokens = Math.min(
    RPC_RATE_PER_SEC,
    state.tokens + elapsedSeconds * RPC_RATE_PER_SEC,
  );
  state.lastRefillMs = now;
  if (state.tokens < 1) return false;
  state.tokens -= 1;
  return true;
}

function withRpcDeadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RpcFailure("timeout", ""));
    }, RPC_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function errorCodeFrom(err: unknown): RpcErrorCode {
  if (err instanceof RpcFailure) return err.code;
  return "internal";
}

function errorAck(code: RpcErrorCode): {
  ok: false;
  error: { code: RpcErrorCode; message: string };
} {
  return {
    ok: false,
    error: { code, message: publicErrorMessage(code) },
  };
}

function directError(err: unknown): unknown {
  const ack = errorAck(errorCodeFrom(err));
  return { ...ack, code: ack.error.code, message: ack.error.message };
}

function publicErrorMessage(code: RpcErrorCode): string {
  switch (code) {
    case "not_found":
      return "not found";
    case "invalid_params":
      return "invalid params";
    case "timeout":
      return "rpc timed out";
    case "unauthorized":
      return "unauthorized";
    case "disconnected":
      return "disconnected";
    case "internal":
    default:
      return "internal error";
  }
}

function safeLogMessage(err: unknown): string {
  if (!(err instanceof Error)) return "operation failed";
  return err.message.replace(/\/\/[^@/\s]+@/g, "//[redacted]@");
}

function registerSocketAuth(
  io: SocketIoServer,
  expected: SocketIoDeps["webConsoleBasicAuth"],
): void {
  io.use((socket, next) => {
    if (!expected) {
      next();
      return;
    }
    if (socketAuthMatches(socket.handshake.auth, expected)) {
      next();
      return;
    }
    next(new Error("unauthorized"));
  });
}

function socketAuthMatches(
  auth: unknown,
  expected: { readonly username: string; readonly password: string },
): boolean {
  const supplied = readSocketAuth(auth);
  if (!supplied) return false;
  return (
    timingSafeStringEqual(supplied.username, expected.username) &&
    timingSafeStringEqual(supplied.password, expected.password)
  );
}

function readSocketAuth(
  auth: unknown,
): { readonly username: string; readonly password: string } | null {
  if (!auth || typeof auth !== "object") return null;
  const record = auth as Record<string, unknown>;
  const username =
    typeof record.user === "string"
      ? record.user
      : typeof record.username === "string"
        ? record.username
        : null;
  const password =
    typeof record.pass === "string"
      ? record.pass
      : typeof record.password === "string"
        ? record.password
        : null;
  if (username === null || password === null) return null;
  return { username, password };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) {
    diff |= ba[i] ^ bb[i];
  }
  return diff === 0;
}

export function combineWebSocketHandlers(
  socketIoHandler: AnyWebSocketHandler,
  legacyHandler: HttpHandlers["websocket"],
): HttpHandlers["websocket"] {
  const combined: AnyWebSocketHandler = {
    maxPayloadLength: socketIoHandler.maxPayloadLength,
    open(ws) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.open?.(ws);
      }
      return legacyHandler.open?.(ws as never);
    },
    message(ws, message) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.message(ws, message);
      }
      return legacyHandler.message(ws as never, message);
    },
    close(ws, code, reason) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.close?.(ws, code, reason);
      }
      return legacyHandler.close?.(ws as never, code, reason);
    },
    drain(ws) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.drain?.(ws);
      }
      return legacyHandler.drain?.(ws as never);
    },
    ping(ws, data) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.ping?.(ws, data);
      }
      return legacyHandler.ping?.(ws as never, data);
    },
    pong(ws, data) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.pong?.(ws, data);
      }
      return legacyHandler.pong?.(ws as never, data);
    },
  };
  return combined as unknown as HttpHandlers["websocket"];
}

function isSocketIoWebSocket(
  ws: AnyWebSocket,
): ws is ServerWebSocket<SocketIoWebSocketData> {
  return Boolean((ws.data as SocketIoWebSocketData | undefined)?.transport);
}
