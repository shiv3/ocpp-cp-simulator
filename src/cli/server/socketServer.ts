import * as fs from "fs";
import type { Server as BunServer, WebSocketHandler } from "bun";
import { Server as Engine } from "@socket.io/bun-engine";
import {
  Server as SocketIoServer,
  type Socket as SocketIoSocket,
} from "socket.io";

import {
  handleJsonCommand,
  requireBoolean,
  requireNonNegativeInt,
  requireNumber,
  requireObject,
  requirePositiveInt,
  requireString,
} from "../jsonMode";
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
  redactSimulatorConfig,
  registryCpToWire,
  rpcRequestSchema,
  statusToWire,
  subscribeResultSchema,
  type CpListItem,
  type RpcAck,
  type RpcErrorCode,
  type SimulatorConfigInput,
  type StatusWire,
  type SubscribeResult,
} from "../../protocol";
import type {
  ChargePointSnapshot,
  ConnectorSnapshot,
  CreateChargePointParams,
} from "../../data/interfaces/ChargePointService";
import type { ConnectorSettingsRepository } from "../../data/interfaces/ConnectorSettingsRepository";
import type { Database } from "../../cp/domain/persistence/Database";
import { SqliteScenarioRepository } from "../../cp/domain/persistence/SqliteScenarioRepository";
import type { ScenarioRepository } from "../../cp/domain/persistence/ScenarioRepository";
import {
  isScenarioDefinitionShape,
  type ScenarioDefinition,
  type ScenarioMode,
} from "../../cp/application/scenario/ScenarioTypes";
import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import type { HistoryOptions } from "../../cp/application/services/types/StateSnapshot";
import {
  hasStatusNotificationOptions,
  OCPPStatus,
  type StatusNotificationOptions,
} from "../../cp/domain/types/OcppTypes";
import { redactSensitiveText } from "../../cp/shared/redaction";
import { SqliteConnectorSettingsRepository } from "../../data/sqlite/SqliteConnectorSettingsRepository";
import type { CPRegistry } from "./CPRegistry";
import type { EventBus } from "./eventBus";
import {
  parseCreateBody,
  parseBasicAuthHeader,
  credentialsMatch,
} from "./httpServer";
import {
  createRegistryEventBridge,
  type RegistryEventBridge,
} from "./registryEvents";
import {
  RegistryChargePointService,
  type RegistryConfigRepository,
} from "./RegistryChargePointService";

export const SOCKET_IO_PATH = "/socket.io/";
export const SOCKET_IO_PING_INTERVAL_MS = 25_000;
export const SOCKET_IO_PING_TIMEOUT_MS = 20_000;

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
  readonly configRepository?: SocketConfigRepository;
  readonly scenarioRepository?: ScenarioRepository;
  readonly connectorSettingsRepository?: ConnectorSettingsRepository;
  readonly chargePointService?: RegistryChargePointService;
  readonly registryEvents?: RegistryEventBridge | null;
}

interface RuntimeSocketIoDeps extends SocketIoDeps {
  readonly configRepository: SocketConfigRepository;
  readonly chargePointService: RegistryChargePointService;
  readonly registryEvents: RegistryEventBridge | null;
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
type FacadeDispatchResult =
  | { readonly handled: true; readonly value: unknown }
  | { readonly handled: false };

const EXPLICIT_METHOD_SET = new Set<string>(EXPLICIT_METHODS);
const CONFIG_KEY = "global_config";
const CONFIG_EVENTS_SCOPE = "config";
const SCENARIO_DEFINITIONS_EVENTS_SCOPE = "scenario-definitions";
const VALID_SCENARIO_MODES: ReadonlyArray<ScenarioMode> = [
  "manual",
  "scenario",
];
const VALID_STATUSES = new Set(Object.values(OCPPStatus));

export interface SocketConfigRepository extends RegistryConfigRepository {}

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
  const runtimeDeps = deps
    ? createRuntimeDeps(deps, registryEvents)
    : undefined;
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
  const runtimeDeps = deps ? createRuntimeDeps(deps) : undefined;

  registerSocketAuth(io, runtimeDeps?.webConsoleBasicAuth ?? null);

  io.on("connection", (socket) => {
    if (!runtimeDeps) return;

    const state: SocketRpcState = {
      inFlight: 0,
      tokens: RPC_RATE_PER_SEC,
      lastRefillMs: Date.now(),
      joinedScopes: new Set(),
    };

    socket.on("rpc", (request: unknown, ack?: RpcAckFn) => {
      if (typeof ack !== "function") return;
      void handleRpc(socket, state, runtimeDeps, request, ack);
    });

    socket.on("events.subscribe", (request: unknown, ack?: DirectAckFn) => {
      if (typeof ack !== "function") return;
      void subscribeSocket(socket, state, runtimeDeps, request).then(
        (result) => ack(result),
        (err) => ack(directError(err)),
      );
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

function createRuntimeDeps(
  deps: SocketIoDeps,
  registryEvents: RegistryEventBridge | null = deps.registryEvents ?? null,
): RuntimeSocketIoDeps {
  const database = deps.database ?? null;
  const configRepository =
    deps.configRepository ?? createSocketConfigRepository(database);
  return {
    ...deps,
    database,
    configRepository,
    registryEvents,
    chargePointService:
      deps.chargePointService ??
      new RegistryChargePointService(deps.registry, {
        database,
        configRepository,
        scenarioRepository:
          deps.scenarioRepository ?? new SqliteScenarioRepository(database),
        connectorSettingsRepository:
          deps.connectorSettingsRepository ??
          new SqliteConnectorSettingsRepository(database),
      }),
  };
}

async function handleRpc(
  socket: SocketIoSocket,
  state: SocketRpcState,
  deps: RuntimeSocketIoDeps,
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
  deps: RuntimeSocketIoDeps,
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
  deps: RuntimeSocketIoDeps,
  method: RpcMethod,
  cpId: string | undefined,
  rawParams: unknown,
): Promise<unknown> {
  switch (method) {
    case "cp.list":
      return listCps(deps.chargePointService);
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
    case "config.get":
      return getConfig(deps.chargePointService);
    case "config.save":
      return saveConfig(deps, rawParams);
    case "scenario.templates":
      return deps.chargePointService.getScenarioTemplates();
    case "scenario.definitions.list":
      return listScenarioDefinitions(deps, rawParams);
    case "scenario.definitions.save":
      return saveScenarioDefinition(deps, rawParams);
    case "scenario.definitions.replace":
      return replaceConnectorScenarioDefinitions(deps, rawParams);
    case "scenario.definitions.delete":
      return deleteScenarioDefinition(deps, rawParams);
    case "connector_settings.auto_meter.get":
      return getAutoMeterConfig(deps, rawParams);
    case "connector_settings.auto_meter.save":
      return saveAutoMeterConfig(deps, rawParams);
    case "connector_settings.soc_meter_sync.get":
      return getSocMeterSync(deps, rawParams);
    case "connector_settings.soc_meter_sync.save":
      return saveSocMeterSync(deps, rawParams);
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

  const facadeResult = await dispatchFacadeCpCommand(
    deps.chargePointService,
    method,
    cpId,
    rawParams,
  );
  if (facadeResult.handled) return facadeResult.value;

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

async function listCps(
  chargePointService: RegistryChargePointService,
): Promise<CpListItem[]> {
  return runFacadeOperation(async () =>
    (await chargePointService.listChargePoints()).map(snapshotToRegistryCpWire),
  );
}

async function createCp(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<{ cpId: string }> {
  const init = parseCreateInput(rawParams);
  await runFacadeOperation(() =>
    deps.chargePointService.createChargePoint(
      init as unknown as CreateChargePointParams,
    ),
  );
  if (rawParamsAsRecord(rawParams).autoConnect === true) {
    void deps.chargePointService.connect(init.cpId).catch((err) => {
      process.stderr.write(
        `[server] autoConnect failed for ${init.cpId}: ${safeLogMessage(err)}\n`,
      );
    });
  }
  return { cpId: init.cpId };
}

async function updateCp(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<{ cpId: string }> {
  const cpId = stringParam(rawParams, "cpId");
  const existing = deps.registry.get(cpId);
  if (!existing) throw new RpcFailure("not_found", "");
  const init = parseCreateInput(mergeUpdateParams(rawParams, existing));
  await runFacadeOperation(() =>
    deps.chargePointService.updateChargePoint(
      init as unknown as CreateChargePointParams,
    ),
  );
  if (rawParamsAsRecord(rawParams).autoConnect === true) {
    void deps.chargePointService.connect(init.cpId).catch((err) => {
      process.stderr.write(
        `[server] reconnect after update failed for ${init.cpId}: ${safeLogMessage(err)}\n`,
      );
    });
  }
  return { cpId: init.cpId };
}

async function deleteCp(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<{ ok: true }> {
  const cpId = stringParam(rawParams, "cpId");
  await runFacadeOperation(() =>
    deps.chargePointService.removeChargePoint(cpId),
  );
  return { ok: true };
}

async function getLogs(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<ReadonlyArray<unknown>> {
  const params = rawParamsAsRecord(rawParams);
  const cpId = stringParam(params, "cpId");
  const entries = await runFacadeOperation(() =>
    deps.chargePointService.listStoredLogs(cpId),
  );
  const limit = params.limit;
  return typeof limit === "number" ? entries.slice(0, limit) : entries;
}

async function clearLogs(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<{ ok: true }> {
  const cpId = stringParam(rawParams, "cpId");
  await runFacadeOperation(() => deps.chargePointService.clearStoredLogs(cpId));
  return { ok: true };
}

async function resetState(deps: RuntimeSocketIoDeps): Promise<{ ok: true }> {
  await runFacadeOperation(() => deps.chargePointService.resetAllState());
  deps.registryEvents?.emitReset();
  return { ok: true };
}

async function getConfig(
  chargePointService: RegistryChargePointService,
): Promise<unknown> {
  const config = await runFacadeOperation(() =>
    chargePointService.loadConfig(),
  );
  return config ? redactSimulatorConfig(config) : null;
}

async function saveConfig(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<{ ok: true }> {
  const params = METHODS["config.save"].params.safeParse(rawParams);
  if (!params.success) throw new RpcFailure("invalid_params", "");

  const saved = await runFacadeOperation(async () => {
    await deps.chargePointService.saveConfig(params.data.config);
    return deps.chargePointService.loadConfig();
  });
  deps.registryEvents?.emitConfigChanged(saved);
  return { ok: true };
}

async function listScenarioDefinitions(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<ScenarioDefinition[]> {
  const params =
    METHODS["scenario.definitions.list"].params.safeParse(rawParams);
  if (!params.success) throw new RpcFailure("invalid_params", "");

  return runFacadeOperation(() =>
    deps.chargePointService.listScenarioDefinitions(
      params.data.cpId,
      params.data.connectorId,
    ),
  );
}

async function saveScenarioDefinition(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<ScenarioDefinition> {
  const params =
    METHODS["scenario.definitions.save"].params.safeParse(rawParams);
  if (!params.success) throw new RpcFailure("invalid_params", "");

  const definition = params.data.definition as unknown as ScenarioDefinition;
  const saved = await runFacadeOperation(() =>
    deps.chargePointService.saveScenarioDefinition(
      params.data.cpId,
      params.data.connectorId,
      definition,
    ),
  );
  await emitScenarioDefinitionsChanged(
    deps,
    params.data.cpId,
    params.data.connectorId,
  );
  return saved;
}

async function replaceConnectorScenarioDefinitions(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<ScenarioDefinition[]> {
  const params =
    METHODS["scenario.definitions.replace"].params.safeParse(rawParams);
  if (!params.success) throw new RpcFailure("invalid_params", "");

  const definitions = params.data
    .definitions as unknown as ScenarioDefinition[];
  const saved = await runFacadeOperation(() =>
    deps.chargePointService.replaceConnectorScenarioDefinitions(
      params.data.cpId,
      params.data.connectorId,
      definitions,
    ),
  );
  deps.registryEvents?.emitScenarioDefinitionsChanged(
    params.data.cpId,
    params.data.connectorId,
    saved,
  );
  return saved;
}

async function deleteScenarioDefinition(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<{ ok: true }> {
  const params =
    METHODS["scenario.definitions.delete"].params.safeParse(rawParams);
  if (!params.success) throw new RpcFailure("invalid_params", "");

  await runFacadeOperation(() =>
    deps.chargePointService.deleteScenarioDefinition(
      params.data.cpId,
      params.data.connectorId,
      params.data.definitionId,
    ),
  );
  await emitScenarioDefinitionsChanged(
    deps,
    params.data.cpId,
    params.data.connectorId,
  );
  return { ok: true };
}

/**
 * Used by save/delete, which only know the single definition they touched.
 * Unlike `replaceConnectorScenarioDefinitions` (whose own return value already
 * *is* the resulting full list), an upsert or a delete-by-id has no way to
 * know the connector's remaining full list without asking for it — this
 * query is the one unavoidable read, not a redundant one, so don't "optimize"
 * it away to match replace's call site without also giving save/delete a way
 * to produce the same answer for free.
 */
async function emitScenarioDefinitionsChanged(
  deps: RuntimeSocketIoDeps,
  cpId: string,
  connectorId: number | null,
): Promise<void> {
  if (!deps.registryEvents) return;
  const definitions = await runFacadeOperation(() =>
    deps.chargePointService.listScenarioDefinitions(cpId, connectorId),
  );
  deps.registryEvents.emitScenarioDefinitionsChanged(
    cpId,
    connectorId,
    definitions,
  );
}

async function getAutoMeterConfig(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<AutoMeterValueConfig | null> {
  const params =
    METHODS["connector_settings.auto_meter.get"].params.safeParse(rawParams);
  if (!params.success) throw new RpcFailure("invalid_params", "");

  return runFacadeOperation(() =>
    deps.chargePointService.getAutoMeterConfig(
      params.data.cpId,
      params.data.connectorId,
    ),
  );
}

async function saveAutoMeterConfig(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<{ ok: true }> {
  const params =
    METHODS["connector_settings.auto_meter.save"].params.safeParse(rawParams);
  if (!params.success) throw new RpcFailure("invalid_params", "");

  await runFacadeOperation(() =>
    deps.chargePointService.saveAutoMeterConfig(
      params.data.cpId,
      params.data.connectorId,
      params.data.config as unknown as AutoMeterValueConfig,
    ),
  );
  return { ok: true };
}

async function getSocMeterSync(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<boolean> {
  const params =
    METHODS["connector_settings.soc_meter_sync.get"].params.safeParse(
      rawParams,
    );
  if (!params.success) throw new RpcFailure("invalid_params", "");

  return runFacadeOperation(() =>
    deps.chargePointService.getSocMeterSync(
      params.data.cpId,
      params.data.connectorId,
    ),
  );
}

async function saveSocMeterSync(
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<{ ok: true }> {
  const params =
    METHODS["connector_settings.soc_meter_sync.save"].params.safeParse(
      rawParams,
    );
  if (!params.success) throw new RpcFailure("invalid_params", "");

  await runFacadeOperation(() =>
    deps.chargePointService.saveSocMeterSync(
      params.data.cpId,
      params.data.connectorId,
      params.data.enabled,
    ),
  );
  return { ok: true };
}

function shutdownServer(deps: RuntimeSocketIoDeps): { ok: true } {
  if (deps.requestShutdown) {
    setTimeout(() => deps.requestShutdown?.(), 100);
  }
  return { ok: true };
}

export function createSocketConfigRepository(
  db: Database | null,
): SocketConfigRepository {
  let cached: SimulatorConfigInput | null = null;
  let cacheValid = false;
  const listeners = new Set<(config: SimulatorConfigInput | null) => void>();
  const notify = (config: SimulatorConfigInput | null) => {
    listeners.forEach((listener) => {
      try {
        listener(config);
      } catch (error) {
        console.error("[SocketConfigRepository] listener error", error);
      }
    });
  };
  const repository: SocketConfigRepository = {
    async load() {
      if (!db) return cacheValid ? cached : null;
      const row = db.get<{ value: string }>(
        "SELECT value FROM kv WHERE key = ?",
        [CONFIG_KEY],
      );
      if (!row) return null;
      try {
        return METHODS["config.save"].params.parse({
          config: JSON.parse(row.value),
        }).config;
      } catch {
        return null;
      }
    },
    async save(config) {
      if (!db) {
        cached = config;
        cacheValid = true;
        notify(config);
        return;
      }
      if (config === null) {
        db.run("DELETE FROM kv WHERE key = ?", [CONFIG_KEY]);
      } else {
        db.run(
          "INSERT INTO kv (key, value) VALUES (?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          [CONFIG_KEY, JSON.stringify(config)],
        );
      }
      await db.flush?.();
      notify(config);
    },
    subscribe(handler) {
      listeners.add(handler);
      void repository.load().then(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
  return repository;
}

async function dispatchFacadeCpCommand(
  chargePointService: RegistryChargePointService,
  method: RpcMethod,
  cpId: string | undefined,
  rawParams: unknown,
): Promise<FacadeDispatchResult> {
  const params = rawParamsAsRecord(rawParams);

  switch (method) {
    case "connect": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() => chargePointService.connect(id));
      return handled(undefined);
    }
    case "disconnect": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() => chargePointService.disconnect(id));
      return handled(undefined);
    }
    case "status": {
      const snapshot = await requireChargePointSnapshot(
        chargePointService,
        requireFacadeCpId(cpId),
      );
      return handled(snapshotToWireStatus(snapshot));
    }
    case "heartbeat": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() => chargePointService.sendHeartbeat(id));
      return handled(undefined);
    }
    case "start_heartbeat": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.startHeartbeat(
          id,
          requireNumber(params, "interval"),
        ),
      );
      return handled(undefined);
    }
    case "stop_heartbeat": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() => chargePointService.stopHeartbeat(id));
      return handled(undefined);
    }
    case "start_transaction": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.startTransaction(
          id,
          requirePositiveInt(params, "connector"),
          requireString(params, "tagId"),
        ),
      );
      return handled(undefined);
    }
    case "stop_transaction": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.stopTransaction(
          id,
          requirePositiveInt(params, "connector"),
        ),
      );
      return handled(undefined);
    }
    case "authorize": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.authorize(id, requireString(params, "tagId")),
      );
      return handled(undefined);
    }
    case "diagnostics_status_notification": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.sendDiagnosticsStatusNotification(
          id,
          requireString(params, "status"),
        ),
      );
      return handled(undefined);
    }
    case "firmware_status_notification": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.sendFirmwareStatusNotification(
          id,
          requireString(params, "status"),
        ),
      );
      return handled(undefined);
    }
    case "security_event_notification": {
      const id = requireFacadeCpId(cpId);
      const techInfo =
        params.techInfo === undefined
          ? undefined
          : requireString(params, "techInfo");
      await runFacadeOperation(() =>
        chargePointService.sendSecurityEventNotification(
          id,
          requireString(params, "type"),
          techInfo,
        ),
      );
      return handled(undefined);
    }
    case "sign_certificate": {
      const id = requireFacadeCpId(cpId);
      const csr =
        params.csr === undefined ? undefined : requireString(params, "csr");
      await runFacadeOperation(() =>
        chargePointService.sendSignCertificate(id, csr),
      );
      return handled(undefined);
    }
    case "update_connector_status": {
      const id = requireFacadeCpId(cpId);
      const status = requireString(params, "status");
      if (!VALID_STATUSES.has(status as OCPPStatus)) {
        throw new Error(
          `Invalid status: ${status}. Valid: ${[...VALID_STATUSES].join(", ")}`,
        );
      }
      await runFacadeOperation(() =>
        chargePointService.sendStatusNotification(
          id,
          requireNonNegativeInt(params, "connector"),
          status as OCPPStatus,
          readStatusNotificationOptions(params),
        ),
      );
      return handled(undefined);
    }
    case "set_meter_value": {
      const id = requireFacadeCpId(cpId);
      const value = requireNumber(params, "value");
      if (value < 0 || !Number.isInteger(value)) {
        throw new Error("value must be a non-negative integer (Wh)");
      }
      await runFacadeOperation(() =>
        chargePointService.setMeterValue(
          id,
          requirePositiveInt(params, "connector"),
          value,
        ),
      );
      return handled(undefined);
    }
    case "send_meter_value": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.sendMeterValue(
          id,
          requirePositiveInt(params, "connector"),
        ),
      );
      return handled(undefined);
    }
    case "remove_connector": {
      const id = requireFacadeCpId(cpId);
      const connectorId = requirePositiveInt(params, "connector");
      const before = await requireChargePointSnapshot(chargePointService, id);
      await runFacadeOperation(() =>
        chargePointService.removeConnector(id, connectorId),
      );
      const after = await chargePointService.getChargePoint(id);
      return handled({
        removed:
          before.connectors.some((connector) => connector.id === connectorId) &&
          !after?.connectors.some((connector) => connector.id === connectorId),
      });
    }
    case "set_ev_settings": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.setEVSettings(
          id,
          requirePositiveInt(params, "connector"),
          requireObject(params, "settings") as unknown as EVSettings,
        ),
      );
      return handled(undefined);
    }
    case "get_ev_settings": {
      const id = requireFacadeCpId(cpId);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getEVSettings(
            id,
            requirePositiveInt(params, "connector"),
          ),
        ),
      );
    }
    case "set_auto_meter_config": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.setAutoMeterValueConfig(
          id,
          requirePositiveInt(params, "connector"),
          requireObject(params, "config") as unknown as AutoMeterValueConfig,
        ),
      );
      return handled(undefined);
    }
    case "get_auto_meter_config": {
      const id = requireFacadeCpId(cpId);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getAutoMeterValueConfig(
            id,
            requirePositiveInt(params, "connector"),
          ),
        ),
      );
    }
    case "set_auto_reset_to_available": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.setAutoResetToAvailable(
          id,
          requirePositiveInt(params, "connector"),
          requireBoolean(params, "enabled"),
        ),
      );
      return handled(undefined);
    }
    case "set_mode": {
      const id = requireFacadeCpId(cpId);
      const mode = requireString(params, "mode");
      if (!VALID_SCENARIO_MODES.includes(mode as ScenarioMode)) {
        throw new Error(
          `Invalid mode: ${mode}. Valid: ${VALID_SCENARIO_MODES.join(", ")}`,
        );
      }
      await runFacadeOperation(() =>
        chargePointService.setConnectorMode(
          id,
          requirePositiveInt(params, "connector"),
          mode as ScenarioMode,
        ),
      );
      return handled(undefined);
    }
    case "set_soc": {
      const id = requireFacadeCpId(cpId);
      const rawSoc = params.soc;
      const soc: number | null =
        rawSoc === null || rawSoc === undefined
          ? null
          : typeof rawSoc === "number"
            ? rawSoc
            : (() => {
                throw new Error("'soc' must be a number or null");
              })();
      await runFacadeOperation(() =>
        chargePointService.setConnectorSoc(
          id,
          requirePositiveInt(params, "connector"),
          soc,
        ),
      );
      return handled(undefined);
    }
    case "set_soc_meter_sync": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.setConnectorSocMeterSync(
          id,
          requirePositiveInt(params, "connector"),
          requireBoolean(params, "enabled"),
        ),
      );
      return handled(undefined);
    }
    case "get_charging_profiles": {
      const id = requireFacadeCpId(cpId);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getChargingProfiles(
            id,
            requirePositiveInt(params, "connector"),
          ),
        ),
      );
    }
    case "get_state_history": {
      const id = requireFacadeCpId(cpId);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getStateHistory(
            id,
            parseHistoryOptions(params.options),
          ),
        ),
      );
    }
    case "list_scenario_templates": {
      await requireChargePointSnapshot(
        chargePointService,
        requireFacadeCpId(cpId),
      );
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getScenarioTemplates(),
        ),
      );
    }
    case "load_scenario_template": {
      const id = requireFacadeCpId(cpId);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.loadScenarioTemplate(
            id,
            requireString(params, "templateId"),
            requirePositiveInt(params, "connector"),
            params.evSettings as Partial<EVSettings> | undefined,
          ),
        ),
      );
    }
    case "load_scenario": {
      const id = requireFacadeCpId(cpId);
      const connectorId = requirePositiveInt(params, "connector");
      if (typeof params.file === "string") {
        const parsed: unknown = JSON.parse(
          fs.readFileSync(params.file, "utf-8"),
        );
        if (!isScenarioDefinitionShape(parsed)) {
          throw new RpcFailure("invalid_params", "");
        }
        return handled(
          await runFacadeOperation(() =>
            chargePointService.loadScenario(id, connectorId, parsed),
          ),
        );
      }
      if (params.scenario) {
        return handled(
          await runFacadeOperation(() =>
            chargePointService.loadScenario(
              id,
              connectorId,
              params.scenario as ScenarioDefinition,
            ),
          ),
        );
      }
      throw new Error("Either 'file' or 'scenario' parameter is required");
    }
    case "list_scenarios": {
      const id = requireFacadeCpId(cpId);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.listScenarios(
            id,
            requirePositiveInt(params, "connector"),
          ),
        ),
      );
    }
    case "run_scenario": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.runScenario(
          id,
          requirePositiveInt(params, "connector"),
          requireString(params, "scenarioId"),
        ),
      );
      return handled(undefined);
    }
    case "scenario_status": {
      const id = requireFacadeCpId(cpId);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getScenarioStatus(
            id,
            requirePositiveInt(params, "connector"),
            requireString(params, "scenarioId"),
          ),
        ),
      );
    }
    case "get_scenario": {
      const id = requireFacadeCpId(cpId);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getScenario(
            id,
            requirePositiveInt(params, "connector"),
            requireString(params, "scenarioId"),
          ),
        ),
      );
    }
    case "stop_scenario": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.stopScenario(
          id,
          requirePositiveInt(params, "connector"),
          requireString(params, "scenarioId"),
        ),
      );
      return handled(undefined);
    }
    case "step_scenario": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.stepScenario(
          id,
          requirePositiveInt(params, "connector"),
          requireString(params, "scenarioId"),
          params.force === true,
        ),
      );
      return handled(undefined);
    }
    case "stop_all_scenarios": {
      const id = requireFacadeCpId(cpId);
      await runFacadeOperation(() =>
        chargePointService.stopAllScenarios(
          id,
          requirePositiveInt(params, "connector"),
        ),
      );
      return handled(undefined);
    }
    case "remove_scenario": {
      const id = requireFacadeCpId(cpId);
      const connectorId = requirePositiveInt(params, "connector");
      const scenarioId = requireString(params, "scenarioId");
      const before = await runFacadeOperation(() =>
        chargePointService.listScenarios(id, connectorId),
      );
      await runFacadeOperation(() =>
        chargePointService.removeScenario(id, connectorId, scenarioId),
      );
      const after = await chargePointService.listScenarios(id, connectorId);
      return handled({
        removed:
          before.some((scenario) => scenario.scenarioId === scenarioId) &&
          !after.some((scenario) => scenario.scenarioId === scenarioId),
      });
    }
    case "run_scenario_file": {
      const id = requireFacadeCpId(cpId);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.runScenarioFile(
            id,
            requireString(params, "file"),
            { connectorId: requirePositiveInt(params, "connector") },
          ),
        ),
      );
    }
    case "run_scenario_template": {
      const id = requireFacadeCpId(cpId);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.runScenarioTemplate(
            id,
            requireString(params, "templateId"),
            {
              connectorId: requirePositiveInt(params, "connector"),
              evSettings: params.evSettings as Partial<EVSettings> | undefined,
            },
          ),
        ),
      );
    }
    default:
      return { handled: false };
  }
}

async function subscribeSocket(
  socket: SocketIoSocket,
  state: SocketRpcState,
  deps: RuntimeSocketIoDeps,
  rawParams: unknown,
): Promise<SubscribeResult> {
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
  const result = await captureSubscribeSnapshot(deps.chargePointService, scope);
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

async function captureSubscribeSnapshot(
  chargePointService: RegistryChargePointService,
  scope: string,
): Promise<SubscribeResult> {
  // `snapshot.cps` (built from snapshotToFullCp) always ships regardless of
  // scope — the client unconditionally uses it to refresh its registry
  // cache (see RemoteChargePointService.applySubscribeResult). `perCp`
  // (built from snapshotToWireStatus, which maps every connector per CP) is
  // only read for registry/wildcard/single-cpId scopes; the config and
  // scenario-definitions scopes never populate it, so skip computing it for
  // those instead of doing the per-connector work and discarding the result.
  const wantsPerCp =
    scope !== CONFIG_EVENTS_SCOPE &&
    scope !== SCENARIO_DEFINITIONS_EVENTS_SCOPE;
  const snapshots = await chargePointService.listChargePoints();

  const perCp: Record<string, StatusWire> = {};
  if (wantsPerCp) {
    for (const snapshot of snapshots) {
      if (scope === "*" || scope === "registry" || scope === snapshot.id) {
        perCp[snapshot.id] = snapshotToWireStatus(snapshot);
      }
    }
  }

  return {
    subscribed: [scope],
    snapshot: {
      cps: snapshots.map((snapshot) =>
        registryCpToWire(snapshotToFullCp(snapshot)),
      ),
      perCp,
    },
  };
}

function handled(value: unknown): FacadeDispatchResult {
  return { handled: true, value };
}

async function runFacadeOperation<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof RpcFailure) throw err;
    if (err instanceof Error) {
      if (err.message.includes("already exists")) {
        throw new RpcFailure("invalid_params", "");
      }
      if (
        err.message.includes("cpId not found") ||
        err.message.includes("not registered in LocalChargePointService")
      ) {
        throw new RpcFailure("not_found", "");
      }
    }
    throw err;
  }
}

function requireFacadeCpId(cpId: string | undefined): string {
  if (!cpId) throw new RpcFailure("not_found", "");
  return cpId;
}

async function requireChargePointSnapshot(
  chargePointService: RegistryChargePointService,
  cpId: string,
): Promise<ChargePointSnapshot> {
  const snapshot = await runFacadeOperation(() =>
    chargePointService.getChargePoint(cpId),
  );
  if (!snapshot) throw new RpcFailure("not_found", "");
  return snapshot;
}

function snapshotToRegistryCpWire(snapshot: ChargePointSnapshot): CpListItem {
  return registryCpToWire(snapshotToFullCp(snapshot));
}

/**
 * `ChargePointSnapshot.config` is typed optional to cover Local mode
 * (the browser owns config) and older daemons that predate the field —
 * neither applies to a Registry-produced snapshot today, since
 * `CLIChargePointService.getStatus()` always populates it. Still, throwing
 * here would take down `listCps`/`captureSubscribeSnapshot` for every
 * registered CP over one anomalous snapshot; fall back to a minimal,
 * clearly-incomplete config and warn instead of crashing the RPC.
 */
function snapshotToFullCp(snapshot: ChargePointSnapshot): FullCp {
  if (!snapshot.config) {
    console.warn(
      `[socketServer] CP snapshot missing config, using fallback: ${snapshot.id}`,
    );
    return {
      id: snapshot.id,
      status: snapshot.status,
      config: {
        wsUrl: "",
        connectors: snapshot.connectors.length,
        vendor: "",
        model: "",
        basicAuth: null,
        bootNotification: null,
      },
    };
  }
  return {
    id: snapshot.id,
    status: snapshot.status,
    config: snapshot.config,
  };
}

function snapshotToWireStatus(snapshot: ChargePointSnapshot): StatusWire {
  return statusToWire({
    id: snapshot.id,
    status: snapshot.status,
    error: snapshot.error,
    connectors: snapshot.connectors.map(connectorSnapshotToWire),
    heartbeat: snapshot.heartbeat,
    config: snapshot.config,
  });
}

function connectorSnapshotToWire(
  connector: ConnectorSnapshot,
): StatusWire["connectors"][number] {
  return {
    id: connector.id,
    status: connector.status,
    availability: connector.availability,
    meterValue: connector.meterValue,
    transactionId: connector.transactionId,
    soc: connector.soc,
    mode: connector.mode,
    autoResetToAvailable: connector.autoResetToAvailable,
    autoMeterValueConfig: connector.autoMeterValueConfig as Record<
      string,
      unknown
    > | null,
    evSettings: connector.evSettings as Record<string, unknown> | null,
    chargingProfile: connector.chargingProfile as Record<
      string,
      unknown
    > | null,
    chargingProfiles: connector.chargingProfiles.map(
      (profile) => profile as unknown as Record<string, unknown>,
    ),
    transactionStartTime: toIsoStringOrNull(connector.transactionStartTime),
    transactionTagId: connector.transactionTagId,
    transactionBatteryCapacityKwh: connector.transactionBatteryCapacityKwh,
  };
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
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
  return (
    scope === "*" ||
    scope === "registry" ||
    scope === CONFIG_EVENTS_SCOPE ||
    scope === SCENARIO_DEFINITIONS_EVENTS_SCOPE ||
    registry.has(scope)
  );
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

function isRecord(rawParams: unknown): rawParams is Record<string, unknown> {
  return (
    rawParams !== null &&
    typeof rawParams === "object" &&
    !Array.isArray(rawParams)
  );
}

function mergeUpdateParams(
  rawParams: unknown,
  existing: CLIChargePointService,
): Record<string, unknown> {
  const params = rawParamsAsRecord(rawParams);
  const init = existing.getInit();
  const merged: Record<string, unknown> = { ...params };

  preserveWhenMissing(merged, "basicAuth", init.basicAuth);
  preserveWhenMissing(merged, "securityProfile", init.securityProfile);
  preserveWhenMissing(merged, "authorizationKey", init.authorizationKey);
  preserveWhenMissing(merged, "cpoName", init.cpoName);
  preserveWhenMissing(merged, "tlsCaPath", init.tlsCaPath);
  preserveWhenMissing(merged, "tlsCertPath", init.tlsCertPath);
  preserveWhenMissing(merged, "tlsKeyPath", init.tlsKeyPath);
  preserveWhenMissing(merged, "tls", init.tls);

  if (isRecord(merged.basicAuth) && init.basicAuth) {
    const basicAuth = { ...merged.basicAuth };
    if (
      typeof basicAuth.password !== "string" ||
      basicAuth.password.length === 0
    ) {
      basicAuth.password = init.basicAuth.password;
    }
    if (typeof basicAuth.username !== "string") {
      basicAuth.username = init.basicAuth.username;
    }
    merged.basicAuth = basicAuth;
  }

  if (isRecord(merged.tls) && init.tls) {
    merged.tls = { ...init.tls, ...merged.tls };
  }

  return merged;
}

function preserveWhenMissing(
  params: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (
    value !== undefined &&
    !Object.prototype.hasOwnProperty.call(params, key)
  ) {
    params[key] = value;
  }
}

function stringParam(rawParams: unknown, key: string): string {
  const value = rawParamsAsRecord(rawParams)[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RpcFailure("invalid_params", "");
  }
  return value;
}

function readStatusNotificationOptions(
  params: Record<string, unknown>,
): StatusNotificationOptions | undefined {
  const opts: StatusNotificationOptions = {};
  readOptionalString(params, "errorCode", opts);
  readOptionalString(params, "info", opts);
  readOptionalString(params, "vendorErrorCode", opts);
  readOptionalString(params, "vendorId", opts);
  readOptionalTimestamp(params, "timestamp", opts);
  readOptionalBoolean(params, "suppressChargingStateTransactionEvent", opts);
  return hasStatusNotificationOptions(opts) ? opts : undefined;
}

function readOptionalString(
  params: Record<string, unknown>,
  key: "errorCode" | "info" | "vendorErrorCode" | "vendorId",
  target: StatusNotificationOptions,
): void {
  const val = params[key];
  if (val === undefined) return;
  if (typeof val !== "string") {
    throw new Error(`Missing or invalid parameter: ${key} (expected string)`);
  }
  target[key] = val;
}

function readOptionalTimestamp(
  params: Record<string, unknown>,
  key: "timestamp",
  target: StatusNotificationOptions,
): void {
  const val = params[key];
  if (val === undefined) return;
  const date =
    val instanceof Date ? val : typeof val === "string" ? new Date(val) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(
      `Missing or invalid parameter: ${key} (expected ISO timestamp)`,
    );
  }
  target[key] = date;
}

function readOptionalBoolean(
  params: Record<string, unknown>,
  key: "suppressChargingStateTransactionEvent",
  target: StatusNotificationOptions,
): void {
  const val = params[key];
  if (val === undefined) return;
  if (typeof val !== "boolean") {
    throw new Error(`Missing or invalid parameter: ${key} (expected boolean)`);
  }
  target[key] = val;
}

function parseHistoryOptions(raw: unknown): HistoryOptions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: HistoryOptions = {};
  if (typeof src.entity === "string") {
    out.entity = src.entity as HistoryOptions["entity"];
  }
  if (typeof src.entityId === "number") {
    out.entityId = src.entityId;
  }
  if (typeof src.transitionType === "string") {
    out.transitionType = src.transitionType as HistoryOptions["transitionType"];
  }
  if (typeof src.limit === "number") {
    out.limit = src.limit;
  }
  if (typeof src.fromTimestamp === "string") {
    out.fromTimestamp = new Date(src.fromTimestamp);
  } else if (src.fromTimestamp instanceof Date) {
    out.fromTimestamp = src.fromTimestamp;
  }
  if (typeof src.toTimestamp === "string") {
    out.toTimestamp = new Date(src.toTimestamp);
  } else if (src.toTimestamp instanceof Date) {
    out.toTimestamp = src.toTimestamp;
  }
  return out;
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
  return redactSensitiveText(
    err.message.replace(/\/\/[^@/\s]+@/g, "//[redacted]@"),
  );
}

/**
 * Read the `Authorization` header off a Socket.IO handshake, tolerating both
 * the plain `IncomingHttpHeaders` record (Node/Engine.IO) and a `Headers`
 * instance, plus the rare repeated-header array form.
 */
function handshakeAuthorizationHeader(headers: unknown): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get("authorization");
  }
  const value = (headers as Record<string, unknown>).authorization;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
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
    // 1) Explicit Socket.IO `auth` payload — used by the CLI client and any
    //    cross-origin caller that holds the credentials and echoes them in.
    if (socketAuthMatches(socket.handshake.auth, expected)) {
      next();
      return;
    }
    // 2) HTTP `Authorization: Basic` header on the handshake request. The
    //    bundled web console is served from the same origin as this daemon, so
    //    it is loaded behind the browser's Basic Auth prompt; the browser then
    //    replays those cached credentials on the same-origin Socket.IO
    //    handshake. They are opaque to page JS and cannot be copied into the
    //    `auth` payload above, so accepting the header lets the web console
    //    connect under --web-console-basic-auth without a second credential
    //    entry. (A WebSocket upgrade can't carry the header, but Socket.IO
    //    authenticates once at the handshake, before the transport upgrade.)
    const headerCreds = parseBasicAuthHeader(
      handshakeAuthorizationHeader(socket.handshake.headers),
    );
    if (headerCreds && credentialsMatch(headerCreds, expected)) {
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
