import * as fs from "fs";
import * as path from "path";
import type { Server as BunServer, WebSocketHandler } from "bun";
import { Server as Engine } from "@socket.io/bun-engine";
import {
  Server as SocketIoServer,
  type Socket as SocketIoSocket,
} from "socket.io";

import { handleJsonCommand } from "../jsonMode";
import type { CLIChargePointService } from "../service";
import {
  INFLIGHT_CAP,
  MAX_HTTP_BUFFER,
  METHODS,
  ROOM_CAP,
  RPC_RATE_PER_SEC,
  RPC_TIMEOUT_MS,
  RpcFailure,
  type Blueprint,
  createManyParamsSchema,
  expandIdPattern,
  MAX_GENERATED_CP_ID_LENGTH,
  isRpcMethod,
  redactSimulatorConfig,
  registryCpToWire,
  rpcRequestSchema,
  statusToWire,
  subscribeResultSchema,
  type CpListItem,
  type Params,
  type RpcAck,
  type RpcCall,
  type RpcErrorCode,
  type ServerInfo,
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
} from "../../cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "../../scenario/scenarioSchemaValidator";
import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import type { HistoryOptions } from "../../cp/application/services/types/StateSnapshot";
import {
  hasStatusNotificationOptions,
  type StatusNotificationOptions,
} from "../../cp/domain/types/OcppTypes";
import { redactSensitiveText } from "../../cp/shared/redaction";
import { isSoapVersion } from "../../cp/domain/types/OcppVersion";
import { soapCallbackUrlSuffixWarning } from "../soapCallbackUrl";
import {
  DEFAULT_SOAP_PATH,
  SOAP_CHARGE_POINT_SERVICE_ROUTE,
} from "../soapPath";
import { appVersion } from "../appVersion";
import { OcppSecurityProfileConfigError } from "../../cp/infrastructure/transport/wsUrlWithBasic";
import { ScenarioRunStateError } from "../../cp/domain/errors/ScenarioRunStateError";
import type { NetworkSimLayerConfig } from "../../cp/infrastructure/transport/network-sim/config";
import type { AutoTrafficConfig } from "../../cp/domain/connector/AutoTraffic";
import { SqliteConnectorSettingsRepository } from "../../data/sqlite/SqliteConnectorSettingsRepository";
import { BlueprintRepository } from "../../cp/domain/persistence/BlueprintRepository";
import {
  builtInBlueprints,
  isBuiltInBlueprint,
  MAX_STORED_BLUEPRINTS,
} from "../../utils/blueprints";
import type { CPRegistry } from "./CPRegistry";
import type { EventBus } from "./eventBus";
import { selectLogWindow } from "./logWindow";
import { getGlobalMetricsRecorder } from "./metrics/MetricsRecorder";
import {
  parseCreateBody,
  parseBasicAuthHeader,
  credentialsMatch,
} from "./httpServer";
import {
  createRegistryEventBridge,
  type RegistryEventBridge,
} from "./registryEvents";
import type { FileReloadManager } from "./FileReloadManager";
import {
  forgetWatchedConnectorScenarioFiles,
  forgetWatchedScenarioFile,
  rememberWatchedScenarioFile,
} from "./watchedScenarioFiles";
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
  /** The push bridge, so a caller that produced it indirectly (the daemon's
   *  `--watch` reloader, #314) can emit through the same socket.io server. */
  readonly registryEvents: RegistryEventBridge | null;
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
  /** `server.info`; absent → version only, no SOAP public base. */
  readonly serverInfo?: ServerInfo;
  readonly webConsoleBasicAuth?: {
    readonly username: string;
    readonly password: string;
  } | null;
  readonly configRepository?: SocketConfigRepository;
  readonly scenarioRepository?: ScenarioRepository;
  readonly connectorSettingsRepository?: ConnectorSettingsRepository;
  /**
   * Injected so socket.io and the MCP endpoint share one instance. Without
   * `--state-db` — the daemon's default — the repository holds blueprints in
   * memory, so a per-transport instance would make a blueprint saved over one
   * transport `not_found` over the other.
   */
  readonly blueprints?: BlueprintRepository;
  readonly chargePointService?: RegistryChargePointService;
  readonly registryEvents?: RegistryEventBridge | null;
  /**
   * The `--watch` file reloader (#314), or null/absent when the daemon was
   * started without `--watch`. Threaded through so the RPCs that load a
   * scenario *from a path* can register that path — without it `--watch`
   * would only ever cover the startup flags, and a scenario loaded over the
   * control plane would silently not be watched.
   */
  readonly fileReload?: FileReloadManager | null;
}

export interface RuntimeSocketIoDeps extends SocketIoDeps {
  readonly configRepository: SocketConfigRepository;
  readonly chargePointService: RegistryChargePointService;
  readonly registryEvents: RegistryEventBridge | null;
  readonly blueprints: BlueprintRepository;
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

const CONFIG_KEY = "global_config";
const CONFIG_EVENTS_SCOPE = "config";
const SCENARIO_DEFINITIONS_EVENTS_SCOPE = "scenario-definitions";
const FILE_RELOAD_EVENTS_SCOPE = "file-reload";

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
    registryEvents,
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

    // Counted here rather than in `dispatchRpcCore`: these two are handled as
    // named socket.io events and never reach it, so leaving them out made
    // `ocppcp_rpc_requests_total` quietly incomplete for the two calls every
    // event-consuming client makes first.
    socket.on("events.subscribe", (request: unknown, ack?: DirectAckFn) => {
      if (typeof ack !== "function") return;
      void Promise.resolve()
        .then(() =>
          subscribeSocket(
            socket,
            state,
            runtimeDeps,
            parseRpcParams("events.subscribe", request),
          ),
        )
        .then(
          (result) => {
            getGlobalMetricsRecorder()?.countRpc("events.subscribe", "ok");
            ack(result);
          },
          (err) => {
            getGlobalMetricsRecorder()?.countRpc("events.subscribe", "error");
            ack(directError(err));
          },
        );
    });

    socket.on("events.unsubscribe", (request: unknown, ack?: DirectAckFn) => {
      if (typeof ack !== "function") return;
      try {
        unsubscribeSocket(
          socket,
          state,
          parseRpcParams("events.unsubscribe", request),
        );
        getGlobalMetricsRecorder()?.countRpc("events.unsubscribe", "ok");
        ack({ ok: true });
      } catch (err) {
        getGlobalMetricsRecorder()?.countRpc("events.unsubscribe", "error");
        ack(directError(err));
      }
    });

    socket.on("disconnect", () => {
      state.joinedScopes.clear();
      state.inFlight = 0;
    });
  });
}

export function createRuntimeDeps(
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
    blueprints: deps.blueprints ?? new BlueprintRepository(database),
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
    getGlobalMetricsRecorder()?.countRpc(rpcMethodLabel(request), "error");
    ack(errorAck("invalid_params"));
    return;
  }
  if (state.inFlight >= INFLIGHT_CAP) {
    getGlobalMetricsRecorder()?.countRpc(rpcMethodLabel(request), "error");
    ack(errorAck("invalid_params"));
    return;
  }

  state.inFlight += 1;
  // Counted around the *whole* request, not around the dispatch it wraps.
  // Parameter validation, the deadline and result validation all live out
  // here: counting inside `dispatchRpcCore` dropped every rejected request
  // and recorded a failed result validation as `ok`.
  const recorder = getGlobalMetricsRecorder();
  const method = rpcMethodLabel(request);
  try {
    const result = await withRpcDeadline(
      dispatchRpc(socket, state, deps, request),
    );
    recorder?.countRpc(method, "ok");
    ack({ ok: true, result });
  } catch (err) {
    recorder?.countRpc(method, "error");
    ack(errorAck(errorCodeFrom(err), rpcFailureMessage(err)));
  } finally {
    state.inFlight = Math.max(0, state.inFlight - 1);
  }
}

/**
 * The `method` label for a request that may not have parsed.
 *
 * Bounded on purpose: an unparseable or unknown method is counted as
 * `unknown` rather than minting a Prometheus series per garbage value, the
 * same rule the wire `action` label follows.
 */
function rpcMethodLabel(request: unknown): string {
  const method = rawParamsAsRecord(request).method;
  return typeof method === "string" && isRpcMethod(method) ? method : "unknown";
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

  const call = parseRpcCall(method, rawParams);
  const result = await dispatchValidatedRpc(
    socket,
    state,
    deps,
    call,
    rpcTarget(cpId, rawParams),
  );
  const parsedResult = METHODS[method].result.safeParse(result);
  if (!parsedResult.success) throw new Error("RPC result failed validation");
  return parsedResult.data;
}

/**
 * The one narrowing step on the daemon path (#383): the method's schema
 * validates the params, and the handlers receive what it parsed rather than
 * re-deriving it from the raw value. A second pass could only drift from the
 * schema (#382) and report its own failures as `internal`.
 *
 * The casts here are the only place a method and its params are paired: TS
 * cannot correlate `METHODS[method]` with the union member for `method`.
 */
function parseRpcCall(method: RpcMethod, rawParams: unknown): RpcCall {
  return { method, params: parseRpcParams(method, rawParams) } as RpcCall;
}

/** {@link parseRpcCall} for a caller that already knows its method. */
function parseRpcParams<M extends RpcMethod>(
  method: M,
  rawParams: unknown,
): Params<M> {
  const params = METHODS[method].params.safeParse(rawParams);
  if (!params.success) throw new RpcFailure("invalid_params", "");
  return params.data as Params<M>;
}

/**
 * Where a request is aimed. `cpIdInParams` is read off the raw params because
 * the schema strips an undeclared `cpId`, and it is the only way to tell the
 * caller that theirs is in the wrong place (#286).
 */
interface RpcTarget {
  readonly cpId: string | undefined;
  readonly cpIdInParams: boolean;
}

function rpcTarget(cpId: string | undefined, rawParams: unknown): RpcTarget {
  return {
    cpId,
    cpIdInParams: typeof rawParamsAsRecord(rawParams).cpId === "string",
  };
}

// Socket-free RPC dispatch for use by non-socket transports (e.g., MCP HTTP endpoint).
// Throws RpcFailure for events.subscribe/unsubscribe (socket-only operations).
export async function dispatchRpcCore(
  deps: RuntimeSocketIoDeps,
  call: RpcCall,
  target: RpcTarget,
): Promise<unknown> {
  // Not counted here. The metric is recorded at the two boundaries that
  // produce a final ack — `handleRpc` for socket.io and `runRpc` for the MCP
  // tools and the CLI client — because parameter validation, the deadline and
  // result validation all sit outside this function.
  switch (call.method) {
    case "cp.list":
      return listCps(deps.chargePointService);
    case "cp.create":
      return createCp(deps, call.params);
    case "cp.create_many":
      return createManyCps(deps, call.params);
    case "blueprint.list":
      // Built-ins first, then stored ones. Ids are unique across both because
      // `blueprint.save` refuses a built-in id.
      return [...builtInBlueprints(), ...deps.blueprints.list()];
    case "blueprint.save":
      return saveBlueprint(deps, call.params);
    case "blueprint.delete":
      return deleteBlueprint(deps, call.params);
    case "cp.update":
      return updateCp(deps, call.params);
    case "cp.delete":
      return deleteCp(deps, call.params);
    case "logs.get":
      return getLogs(deps, call.params);
    case "logs.clear":
      return clearLogs(deps, call.params);
    case "state.reset":
      return resetState(deps);
    case "config.get":
      return getConfig(deps.chargePointService);
    case "config.save":
      return saveConfig(deps, call.params);
    case "network_sim.global.get":
      return getNetworkSimGlobal(deps);
    case "network_sim.global.save":
      return saveNetworkSimGlobal(deps, call.params);
    case "network_sim.cp.get":
      return getNetworkSimCp(deps, call.params);
    case "network_sim.cp.save":
      return saveNetworkSimCp(deps, call.params);
    case "network_sim.disconnect.trigger":
      return triggerNetworkSimDisconnect(deps, call.params);
    case "scenario.templates":
      return deps.chargePointService.getScenarioTemplates();
    case "scenario.definitions.list":
      return listScenarioDefinitions(deps, call.params);
    case "scenario.definitions.save":
      return saveScenarioDefinition(deps, call.params);
    case "scenario.definitions.replace":
      return replaceConnectorScenarioDefinitions(deps, call.params);
    case "scenario.definitions.delete":
      return deleteScenarioDefinition(deps, call.params);
    case "connector_settings.auto_meter.get":
      return getAutoMeterConfig(deps, call.params);
    case "connector_settings.auto_meter.save":
      return saveAutoMeterConfig(deps, call.params);
    case "connector_settings.auto_traffic.get":
      return getAutoTrafficSetting(deps, call.params);
    case "connector_settings.auto_traffic.save":
      return saveAutoTrafficSetting(deps, call.params);
    case "connector_settings.soc_meter_sync.get":
      return getSocMeterSync(deps, call.params);
    case "connector_settings.soc_meter_sync.save":
      return saveSocMeterSync(deps, call.params);
    case "ev_settings.apply_default":
      return applyDefaultEVSettingsRpc(deps, call.params);
    case "server.shutdown":
      return shutdownServer(deps);
    case "server.info":
      return serverInfo(deps);
    case "events.subscribe":
      throw new RpcFailure(
        "not_found",
        "events.subscribe/unsubscribe are only available over socket.io",
      );
    case "events.unsubscribe":
      throw new RpcFailure(
        "not_found",
        "events.subscribe/unsubscribe are only available over socket.io",
      );
    default:
      break;
  }

  // Every method past the switch is CP-scoped.
  const cpId = requireFacadeCpId(target);
  const facadeResult = await dispatchFacadeCpCommand(
    deps.chargePointService,
    call,
    cpId,
    deps.fileReload ?? null,
    deps.database ?? null,
  );
  if (facadeResult.handled) return facadeResult.value;

  const service = deps.registry.get(cpId);
  if (!service) throw new RpcFailure("not_found", "");

  return handleJsonCommand(service, {
    command: call.method,
    params: call.params as Record<string, unknown>,
  });
}

async function dispatchValidatedRpc(
  socket: SocketIoSocket,
  state: SocketRpcState,
  deps: RuntimeSocketIoDeps,
  call: RpcCall,
  target: RpcTarget,
): Promise<unknown> {
  switch (call.method) {
    case "events.subscribe":
      return subscribeSocket(socket, state, deps, call.params);
    case "events.unsubscribe":
      unsubscribeSocket(socket, state, call.params);
      return { ok: true };
    default:
      return dispatchRpcCore(deps, call, target);
  }
}

// Socket-free RPC runner for non-socket transports (e.g., MCP HTTP endpoint).
// Mirrors dispatchRpc behavior exactly, minus the socket and rate-limiting.
export async function runRpc(
  deps: RuntimeSocketIoDeps,
  request: { cpId?: string; method: string; params?: unknown },
): Promise<unknown> {
  const { method, cpId } = request;
  const rawParams = request.params ?? {};

  const recorder = getGlobalMetricsRecorder();
  const label = isRpcMethod(method) ? method : "unknown";
  try {
    if (!isRpcMethod(method)) throw new RpcFailure("not_found", "");

    const call = parseRpcCall(method, rawParams);
    const result = await withRpcDeadline(
      dispatchRpcCore(deps, call, rpcTarget(cpId, rawParams)),
    );
    const parsedResult = METHODS[method].result.safeParse(result);
    if (!parsedResult.success) throw new Error("RPC result failed validation");
    recorder?.countRpc(label, "ok");
    return parsedResult.data;
  } catch (err) {
    recorder?.countRpc(label, "error");
    throw err;
  }
}

async function listCps(
  chargePointService: RegistryChargePointService,
): Promise<CpListItem[]> {
  return runFacadeOperation(async () =>
    (await chargePointService.listChargePoints()).map(snapshotToRegistryCpWire),
  );
}

/**
 * Create exactly one charge point from an already-shaped params object.
 *
 * Split out of `createCp` so `cp.create_many` runs the identical path — the
 * SOAP callback warning, the facade error classification and the fire-and-
 * forget autoConnect included. A bulk-created charge point that behaved even
 * slightly differently from a singly-created one would be a trap.
 */
async function createOneCp(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.create">,
): Promise<string> {
  const init = parseCreateInput(deps, params);
  if (isSoapVersion(init.ocppVersion) && init.soapCallbackUrl) {
    const suffixWarning = soapCallbackUrlSuffixWarning(init.soapCallbackUrl);
    if (suffixWarning) {
      process.stderr.write(`[server] Warning: ${suffixWarning}\n`);
    }
  }
  await runFacadeOperation(() =>
    deps.chargePointService.createChargePoint(
      init as unknown as CreateChargePointParams,
    ),
  );
  if (params.autoConnect === true) {
    void deps.chargePointService.connect(init.cpId).catch((err) => {
      process.stderr.write(
        `[server] autoConnect failed for ${init.cpId}: ${safeLogMessage(err)}\n`,
      );
    });
  }
  return init.cpId;
}

async function createCp(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.create">,
): Promise<{ cpId: string }> {
  return { cpId: await createOneCp(deps, params) };
}

/**
 * `cp.create_many` — one call, N charge points sharing every parameter but the
 * generated id.
 *
 * Two behaviours worth naming because they are contracts, not incidentals:
 *
 * - **Partial success is the result.** A CSMS URL that only some ids can reach,
 *   or an id that collides with an existing charge point, must not discard the
 *   ones that came up. Failures are collected per id and returned; the call
 *   itself only fails when the parameters are unusable.
 * - **Creation is sequential.** Registry `event` pushes therefore arrive in id
 *   order, which a subscriber can rely on. Bulk creation is not on a hot path,
 *   so there is nothing to win by racing them.
 */
/**
 * Drop keys whose value is `undefined` so a spread cannot un-set a blueprint
 * field. `{ ...blueprint, ...requested }` with `requested.vendor === undefined`
 * would otherwise erase the blueprint's vendor.
 */
function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v;
  }
  return out as T;
}

function saveBlueprint(
  deps: RuntimeSocketIoDeps,
  { blueprint }: Params<"blueprint.save">,
): { id: string } {
  if (isBuiltInBlueprint(blueprint.id)) {
    // Refused rather than shadowed: `blueprint.delete` cannot restore a
    // built-in, so an accidental overwrite would be permanent for that daemon.
    throw new RpcFailure(
      "invalid_params",
      `"${blueprint.id}" is a built-in blueprint and cannot be replaced; choose another id`,
    );
  }
  // Checked before the write: the list result carries the built-ins too, so an
  // unbounded store would make `blueprint.list` fail validation for everyone
  // rather than refuse the one save that crossed the line.
  const stored = deps.blueprints.list();
  if (
    stored.length >= MAX_STORED_BLUEPRINTS &&
    !stored.some((b) => b.id === blueprint.id)
  ) {
    throw new RpcFailure(
      "invalid_params",
      `at most ${MAX_STORED_BLUEPRINTS} blueprints can be stored; delete one first`,
    );
  }
  deps.blueprints.save(blueprint);
  return { id: blueprint.id };
}

function deleteBlueprint(
  deps: RuntimeSocketIoDeps,
  { id }: Params<"blueprint.delete">,
): { ok: true } {
  if (isBuiltInBlueprint(id)) {
    throw new RpcFailure(
      "invalid_params",
      `"${id}" is a built-in blueprint and cannot be deleted`,
    );
  }
  // `not_found` rather than a silent success: a delete that reports ok for an
  // id that was never there hides a typo until the instantiate fails.
  if (!deps.blueprints.delete(id)) throw new RpcFailure("not_found", "");
  return { ok: true };
}

/**
 * Why one charge point in a batch could not be created, in a form safe to send
 * back over the control plane.
 *
 * `classifyFacadeError` deliberately blanks the message for the failures whose
 * text could carry a CSMS URL — an "already exists" collision among them — so
 * falling back to the error code is what keeps the row from being an empty
 * string. Terse, but paired with the `cpId` it is enough to act on, and it
 * leaks nothing. Anything else goes through the same redaction the log lines
 * use, since a create can fail on a URL carrying Basic Auth credentials.
 */
function createFailureReason(err: unknown): string {
  const reason =
    err instanceof RpcFailure ? err.message || err.code : safeLogMessage(err);
  // Bounded to the result schema's own limit. A failure whose message repeats a
  // long input — a 40 KB `tlsCaPath` that does not exist, say — would otherwise
  // make the *whole batch's* ack fail result validation and answer `internal`,
  // discarding the per-item report this method exists to give.
  return reason.length > MAX_FAILURE_REASON_LENGTH
    ? reason.slice(0, MAX_FAILURE_REASON_LENGTH - 1) + "\u2026"
    : reason;
}

/** Fits inside the result schema's `STR_64K`, with room for the ellipsis. */
const MAX_FAILURE_REASON_LENGTH = 2_000;

/** Bounds an expanded `soapCallbackUrl`; generous for a real URL. */
const MAX_SOAP_CALLBACK_URL_LENGTH = 2_048;

/**
 * The charge point id a callback URL's path would route to, or `null` if the
 * path is not a `ChargePointService` route at all. Uses the router's own
 * pattern and percent-decoding so this check and the router cannot disagree.
 */
export function soapCallbackRouteCpId(callbackUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(callbackUrl).pathname;
  } catch {
    return null;
  }
  const match = SOAP_CHARGE_POINT_SERVICE_ROUTE.exec(pathname);
  if (!match?.[2]) return null;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

async function createManyCps(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.create_many">,
): Promise<{
  created: string[];
  failed: Array<{ cpId: string; reason: string }>;
}> {
  // A blueprint supplies the parameter block; anything given alongside it
  // wins, so a fleet can share hardware and differ in one field. Resolved
  // before validation of the merged result, since the merge is what the
  // charge points are actually created from.
  const { blueprintId, ...requested } = params;
  let merged = requested;
  let defaults: Pick<Blueprint, "evSettings" | "scenarioTemplateId"> = {};
  if (blueprintId !== undefined) {
    const blueprint =
      builtInBlueprints().find((b) => b.id === blueprintId) ??
      deps.blueprints.get(blueprintId);
    if (!blueprint) {
      throw new RpcFailure("not_found", `no blueprint "${blueprintId}"`);
    }
    merged = { ...blueprint.params, ...stripUndefined(requested) };
    // A blueprint is more than its `cp.create` block: the schema also promises
    // default EV settings and a startup scenario. Copying only `params` left
    // both silently unapplied — including for every built-in, which is where
    // the EV settings are the whole point of picking a 150 kW profile.
    defaults = {
      evSettings: blueprint.evSettings,
      scenarioTemplateId: blueprint.scenarioTemplateId,
    };
  }
  // A blueprint batch may omit `idPattern`; derive one from the blueprint id so
  // `{ blueprintId, count }` is a complete call rather than a validation error.
  const withPattern =
    merged.idPattern === undefined && blueprintId !== undefined
      ? { ...merged, idPattern: `${blueprintId}-{n:03}` }
      : merged;
  const validated = createManyParamsSchema.safeParse(withPattern);
  if (!validated.success) {
    throw new RpcFailure(
      "invalid_params",
      validated.error.issues[0]?.message ?? "",
    );
  }
  const { count, idPattern, startIndex, ...shared } = validated.data;
  const first = startIndex ?? 1;

  const soapCallbackUrl = shared.soapCallbackUrl;

  // Expand every id first and check the batch as a whole. Creating as we go
  // and failing partway would leave charge points registered under ids the
  // result cannot even report — the schema caps the result strings — so the
  // parameters are rejected outright instead, before any side effect.
  const plan: Array<{ cpId: string; soapCallbackUrl?: string }> = [];
  for (let i = 0; i < count; i++) {
    const index = first + i;
    const cpId = expandIdPattern(idPattern, index);
    if (cpId.length > MAX_GENERATED_CP_ID_LENGTH) {
      // The pad-width cap does not bound this on its own: a pattern may repeat
      // the placeholder, and a few KB of input expands to a huge id.
      throw new RpcFailure(
        "invalid_params",
        `idPattern expands to a charge point id longer than ${MAX_GENERATED_CP_ID_LENGTH} characters`,
      );
    }
    if (!soapCallbackUrl) {
      plan.push({ cpId });
      continue;
    }
    // A SOAP charge point advertises the address the CSMS calls back on, and
    // the daemon routes those calls by the cpId embedded in it
    // (`<soapPath>/<cpId>/ChargePointService`). One URL shared across a batch
    // would point every station at the first station's route; so would a URL
    // whose placeholder is spelled differently from `idPattern`'s, e.g.
    // `SOAP{n}` against ids generated as `SOAP{n:03}` — the station registers
    // as SOAP001 while advertising SOAP1, and every inbound call 404s. Both
    // creates succeed either way, so the check has to be here.
    const expanded = expandIdPattern(soapCallbackUrl, index);
    // Bounded for the same reason the id is: a template repeating the
    // placeholder expands far past what any string limit allows, and this
    // value is retained and persisted per charge point.
    if (expanded.length > MAX_SOAP_CALLBACK_URL_LENGTH) {
      throw new RpcFailure(
        "invalid_params",
        `soapCallbackUrl expands to more than ${MAX_SOAP_CALLBACK_URL_LENGTH} characters`,
      );
    }
    if (soapCallbackRouteCpId(expanded) !== cpId) {
      // Checked through the router's own pattern and percent-decoding rather
      // than by substring: an id like "SITE A-1" is advertised as
      // "/SITE%20A-1/" and would fail a raw match, while
      // "/SITE A-1/extra/ChargePointService" would pass one and still 404.
      throw new RpcFailure(
        "invalid_params",
        `soapCallbackUrl must expand to a route whose charge point segment is "${cpId}" and which ends in /ChargePointService; the daemon routes inbound SOAP calls by that segment`,
      );
    }
    plan.push({ cpId, soapCallbackUrl: expanded });
  }

  const connectors = validated.data.connectors ?? 1;
  const created: string[] = [];
  const failed: Array<{ cpId: string; reason: string }> = [];
  for (const entry of plan) {
    try {
      const cpId = await createOneCp(deps, {
        ...shared,
        cpId: entry.cpId,
        ...(entry.soapCallbackUrl
          ? { soapCallbackUrl: entry.soapCallbackUrl }
          : {}),
      });
      try {
        await applyBlueprintDefaults(deps, cpId, connectors, defaults);
      } catch (err) {
        // Roll the charge point back. `createOneCp` has already registered and
        // persisted it, so reporting the id in `failed` while leaving it
        // behind would put a half-configured station in `cp.list` and make the
        // obvious retry fail with an already-exists error.
        await deps.chargePointService
          .removeChargePoint(cpId)
          .catch(() => undefined);
        throw err;
      }
      created.push(cpId);
    } catch (err) {
      failed.push({ cpId: entry.cpId, reason: createFailureReason(err) });
    }
  }
  return { created, failed };
}

/**
 * Apply a blueprint's EV settings and startup scenario to a created charge
 * point, one connector at a time.
 *
 * A failure here fails the charge point: it is reported in `failed` rather
 * than left half-configured in `created`, since a station that came up with
 * generic EV settings while the caller asked for a 150 kW profile is the kind
 * of wrong that only shows up in the meter readings.
 */
async function applyBlueprintDefaults(
  deps: RuntimeSocketIoDeps,
  cpId: string,
  connectors: number,
  defaults: Pick<Blueprint, "evSettings" | "scenarioTemplateId">,
): Promise<void> {
  if (!defaults.evSettings && !defaults.scenarioTemplateId) return;
  for (let connectorId = 1; connectorId <= connectors; connectorId++) {
    if (defaults.evSettings) {
      await runFacadeOperation(() =>
        deps.chargePointService.setEVSettings(
          cpId,
          connectorId,
          defaults.evSettings as never,
        ),
      );
    }
    if (defaults.scenarioTemplateId) {
      await runFacadeOperation(() =>
        deps.chargePointService.loadScenarioTemplate(
          cpId,
          defaults.scenarioTemplateId as string,
          connectorId,
          // The blueprint's EV settings again, as the override: a template
          // carries its own and applies them when it starts, so without this
          // the scenario would quietly undo the settings applied above.
          defaults.evSettings as never,
        ),
      );
    }
  }
}

async function updateCp(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.update">,
): Promise<{ cpId: string }> {
  const existing = deps.registry.get(params.cpId);
  if (!existing) throw new RpcFailure("not_found", "");
  const init = parseCreateInput(deps, mergeUpdateParams(params, existing));
  await runFacadeOperation(() =>
    deps.chargePointService.updateChargePoint(
      init as unknown as CreateChargePointParams,
    ),
  );
  if (params.autoConnect === true) {
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
  { cpId }: Params<"cp.delete">,
): Promise<{ ok: true }> {
  await runFacadeOperation(() =>
    deps.chargePointService.removeChargePoint(cpId),
  );
  return { ok: true };
}

async function getLogs(
  deps: RuntimeSocketIoDeps,
  params: Params<"logs.get">,
): Promise<ReadonlyArray<unknown>> {
  const entries = await runFacadeOperation(() =>
    deps.chargePointService.listStoredLogs(params.cpId),
  );
  // `limit` selects the NEWEST n (see selectLogWindow). It used to take the
  // oldest n, which made the parameter useless on a long-running charge point:
  // no limit could reach recent activity.
  return selectLogWindow(entries, {
    limit: params.limit,
    offset: params.offset,
    order: params.order ?? "asc",
  });
}

async function clearLogs(
  deps: RuntimeSocketIoDeps,
  { cpId }: Params<"logs.clear">,
): Promise<{ ok: true }> {
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
  params: Params<"config.save">,
): Promise<{ ok: true }> {
  const saved = await runFacadeOperation(async () => {
    await deps.chargePointService.saveConfig(params.config);
    return deps.chargePointService.loadConfig();
  });
  deps.registryEvents?.emitConfigChanged(saved);
  return { ok: true };
}

async function getNetworkSimGlobal(
  deps: RuntimeSocketIoDeps,
): Promise<unknown> {
  const config = await runFacadeOperation(() =>
    deps.chargePointService.getNetworkSimGlobal(),
  );
  return { config };
}

async function saveNetworkSimGlobal(
  deps: RuntimeSocketIoDeps,
  params: Params<"network_sim.global.save">,
): Promise<{ ok: true }> {
  try {
    await runFacadeOperation(() =>
      deps.chargePointService.saveNetworkSimGlobal(
        params.config as NetworkSimLayerConfig | null,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    throw new RpcFailure("invalid_params", message);
  }
  return { ok: true };
}

async function getNetworkSimCp(
  deps: RuntimeSocketIoDeps,
  params: Params<"network_sim.cp.get">,
): Promise<unknown> {
  return runFacadeOperation(() =>
    deps.chargePointService.getNetworkSimCp(params.cpId),
  );
}

async function saveNetworkSimCp(
  deps: RuntimeSocketIoDeps,
  params: Params<"network_sim.cp.save">,
): Promise<{ ok: true }> {
  try {
    await runFacadeOperation(() =>
      deps.chargePointService.saveNetworkSimCp(
        params.cpId,
        params.config as NetworkSimLayerConfig | null,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    throw new RpcFailure("invalid_params", message);
  }
  return { ok: true };
}

async function triggerNetworkSimDisconnect(
  deps: RuntimeSocketIoDeps,
  params: Params<"network_sim.disconnect.trigger">,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return runFacadeOperation(() =>
    deps.chargePointService.triggerNetworkSimDisconnect(
      params.cpId,
      params.ruleId,
    ),
  );
}

async function applyDefaultEVSettingsRpc(
  deps: RuntimeSocketIoDeps,
  params: Params<"ev_settings.apply_default">,
): Promise<undefined> {
  await runFacadeOperation(() =>
    deps.chargePointService.applyDefaultEVSettings(
      params.settings as unknown as EVSettings,
    ),
  );
  return undefined;
}

async function listScenarioDefinitions(
  deps: RuntimeSocketIoDeps,
  params: Params<"scenario.definitions.list">,
): Promise<ScenarioDefinition[]> {
  return runFacadeOperation(() =>
    deps.chargePointService.listScenarioDefinitions(
      params.cpId,
      params.connectorId,
    ),
  );
}

async function saveScenarioDefinition(
  deps: RuntimeSocketIoDeps,
  params: Params<"scenario.definitions.save">,
): Promise<ScenarioDefinition> {
  const definition = params.definition as unknown as ScenarioDefinition;
  const saved = await runFacadeOperation(() =>
    deps.chargePointService.saveScenarioDefinition(
      params.cpId,
      params.connectorId,
      definition,
    ),
  );
  await emitScenarioDefinitionsChanged(deps, params.cpId, params.connectorId);
  return saved;
}

/**
 * Stop the file behind one scenario from being authoritative, and forget the
 * row that would re-establish it (#314).
 *
 * Every path that takes a definition away from the daemon calls this, because
 * the alternative has now been three separate bugs with one shape: a definition
 * removed through one door while the file behind it kept its watch, so the next
 * edit put it back. The enumeration, so the fourth door is noticed when it is
 * added:
 *
 * - `remove_scenario` — removes runtime *and* stored definition.
 * - `load_scenario { scenario }` under an id a file already owns — replaces the
 *   runtime definition inline; the console becomes the source of truth.
 * - `scenario.definitions.delete` — removes only the stored row, leaving the
 *   runtime scenario loaded, so `stillLoaded` passes and a reload re-persists
 *   exactly what the operator deleted.
 * - `scenario.definitions.replace` — the whole connector at once; see
 *   {@link detachConnectorScenarioFiles}.
 *
 * `scenario.definitions.save` is an upsert and removes nothing.
 * `cp.delete` and `state.reset` are handled at the registry and schema level
 * instead, because they are about a charge point rather than one scenario.
 *
 * The watch and the row are dropped together and unconditionally: the row is a
 * fact about stored state, not about `--watch`, so a daemon running without the
 * flag still invalidates it.
 */
function detachScenarioFile(
  fileReload: FileReloadManager | null | undefined,
  database: Database | null | undefined,
  cpId: string,
  connectorId: number,
  scenarioId: string,
): void {
  fileReload?.unregisterScenario(cpId, connectorId, scenarioId);
  forgetWatchedScenarioFile(database, cpId, connectorId, scenarioId);
}

/**
 * Record where a control-plane load got its scenario, and watch the file when
 * this daemon is watching (#314).
 *
 * The row goes in whether or not `--watch` is on, and that is the whole point:
 * it is a fact about stored state, not about the feature that consumes it.
 * Written only behind the flag, a `--state-db` daemon started without `--watch`
 * recorded no origin, and a later restart *with* `--watch` had nothing to
 * restore — the persisted scenario came back silently unwatched. This is the
 * same rule as {@link detachScenarioFile}'s unconditional delete, in the other
 * direction: both the writing and the clearing of the row are independent of
 * the watcher, and only the in-memory watch is behind the flag.
 *
 * The startup flags do not come through here: they own their keys and
 * deliberately store nothing — see `ScenarioFileRegistration.persist`.
 */
function attachScenarioFile(
  fileReload: FileReloadManager | null | undefined,
  database: Database | null | undefined,
  registration: {
    readonly filePath: string;
    readonly cpId: string;
    readonly connectorId: number;
    readonly scenarioId: string;
    readonly loadedText?: string | null;
  },
): void {
  rememberWatchedScenarioFile(
    database,
    registration.cpId,
    registration.connectorId,
    registration.scenarioId,
    // Resolved the same way `registerScenarioFile` resolves it, so the row a
    // watcher writes and the row it reads back are the same string.
    path.resolve(registration.filePath),
  );
  fileReload?.registerScenarioFile(registration);
}

/**
 * The connector-wide twin of {@link detachScenarioFile}, for the upload that
 * replaces a connector's whole definition set.
 *
 * A CP-level (`connectorId === null`) scope is deliberately not handled: a
 * watch is only ever registered against a numeric connector, so no null-scoped
 * row can exist for one to invalidate.
 */
function detachConnectorScenarioFiles(
  fileReload: FileReloadManager | null | undefined,
  database: Database | null | undefined,
  cpId: string,
  connectorId: number,
): void {
  fileReload?.unregisterConnectorScenarios(cpId, connectorId);
  forgetWatchedConnectorScenarioFiles(database, cpId, connectorId);
}

async function replaceConnectorScenarioDefinitions(
  deps: RuntimeSocketIoDeps,
  params: Params<"scenario.definitions.replace">,
): Promise<ScenarioDefinition[]> {
  const definitions = params.definitions as unknown as ScenarioDefinition[];
  const saved = await runFacadeOperation(() =>
    deps.chargePointService.replaceConnectorScenarioDefinitions(
      params.cpId,
      params.connectorId,
      definitions,
    ),
  );
  // #314: the console has just become the source of truth for this connector's
  // whole definition set. A file still watched behind one of these ids would
  // overwrite the upload at its next edit.
  if (params.connectorId !== null) {
    detachConnectorScenarioFiles(
      deps.fileReload,
      deps.database,
      params.cpId,
      params.connectorId,
    );
  }
  deps.registryEvents?.emitScenarioDefinitionsChanged(
    params.cpId,
    params.connectorId,
    saved,
  );
  return saved;
}

async function deleteScenarioDefinition(
  deps: RuntimeSocketIoDeps,
  params: Params<"scenario.definitions.delete">,
): Promise<{ ok: true }> {
  await runFacadeOperation(() =>
    deps.chargePointService.deleteScenarioDefinition(
      params.cpId,
      params.connectorId,
      params.definitionId,
    ),
  );
  // #314: this deletes the stored row and leaves the runtime scenario loaded,
  // so without dropping the watch the next edit of the file behind it would
  // pass `stillLoaded`, reload, and persist the definition just deleted.
  if (params.connectorId !== null) {
    detachScenarioFile(
      deps.fileReload,
      deps.database,
      params.cpId,
      params.connectorId,
      params.definitionId,
    );
  }
  await emitScenarioDefinitionsChanged(deps, params.cpId, params.connectorId);
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
  params: Params<"connector_settings.auto_meter.get">,
): Promise<AutoMeterValueConfig | null> {
  return runFacadeOperation(() =>
    deps.chargePointService.getAutoMeterConfig(params.cpId, params.connectorId),
  );
}

async function saveAutoMeterConfig(
  deps: RuntimeSocketIoDeps,
  params: Params<"connector_settings.auto_meter.save">,
): Promise<{ ok: true }> {
  await runFacadeOperation(() =>
    deps.chargePointService.saveAutoMeterConfig(
      params.cpId,
      params.connectorId,
      params.config as unknown as AutoMeterValueConfig,
    ),
  );
  return { ok: true };
}

async function getAutoTrafficSetting(
  deps: RuntimeSocketIoDeps,
  params: Params<"connector_settings.auto_traffic.get">,
): Promise<AutoTrafficConfig | null> {
  return runFacadeOperation(() =>
    deps.chargePointService.getAutoTrafficConfig(
      params.cpId,
      params.connectorId,
    ),
  );
}

async function saveAutoTrafficSetting(
  deps: RuntimeSocketIoDeps,
  params: Params<"connector_settings.auto_traffic.save">,
): Promise<{ ok: true }> {
  await runFacadeOperation(() =>
    deps.chargePointService.saveAutoTrafficConfig(
      params.cpId,
      params.connectorId,
      params.config as unknown as AutoTrafficConfig,
    ),
  );
  return { ok: true };
}

async function getSocMeterSync(
  deps: RuntimeSocketIoDeps,
  params: Params<"connector_settings.soc_meter_sync.get">,
): Promise<boolean> {
  return runFacadeOperation(() =>
    deps.chargePointService.getSocMeterSync(params.cpId, params.connectorId),
  );
}

async function saveSocMeterSync(
  deps: RuntimeSocketIoDeps,
  params: Params<"connector_settings.soc_meter_sync.save">,
): Promise<{ ok: true }> {
  await runFacadeOperation(() =>
    deps.chargePointService.saveSocMeterSync(
      params.cpId,
      params.connectorId,
      params.enabled,
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

/** Fixed for the daemon's lifetime, so built once by startServer. */
export function buildServerInfo(soap: {
  soapPublicBaseUrl: string | null;
  soapPath: string;
  tunnel: ServerInfo["soap"]["tunnel"];
}): ServerInfo {
  return {
    version: appVersion(),
    soap: {
      publicBaseUrl: soap.soapPublicBaseUrl,
      path: soap.soapPath,
      tunnel: soap.tunnel,
    },
  };
}

function serverInfo(deps: RuntimeSocketIoDeps): ServerInfo {
  return (
    deps.serverInfo ??
    buildServerInfo({
      soapPublicBaseUrl: null,
      soapPath: DEFAULT_SOAP_PATH,
      tunnel: null,
    })
  );
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

/**
 * Issue #214: advisory (warning-only) schema check for a scenario value
 * received over the `load_scenario` RPC. Never throws and never blocks
 * loading — a schema mismatch is logged and the caller proceeds exactly as
 * it would have before this check existed.
 */
function warnOnScenarioSchemaMismatch(source: string, value: unknown): void {
  const result = validateScenarioSchema(value);
  if (!result.valid) {
    console.warn(
      `[socketServer] "${source}" does not match schema/scenario.schema.json (loading anyway): ${result.errors.slice(0, 5).join("; ")}`,
    );
  }
}

async function dispatchFacadeCpCommand(
  chargePointService: RegistryChargePointService,
  call: RpcCall,
  id: string,
  /** Null unless the daemon runs with `--watch` (#314). */
  fileReload: FileReloadManager | null = null,
  /** The `--state-db`, when there is one. Separate from `fileReload` on
   *  purpose: a `watched_scenario_files` row is a fact about stored state, so
   *  invalidating it must not depend on this daemon happening to watch (#314). */
  database: Database | null = null,
): Promise<FacadeDispatchResult> {
  switch (call.method) {
    case "connect": {
      await runFacadeOperation(() => chargePointService.connect(id));
      return handled(undefined);
    }
    case "disconnect": {
      await runFacadeOperation(() => chargePointService.disconnect(id));
      return handled(undefined);
    }
    case "status": {
      const snapshot = await requireChargePointSnapshot(chargePointService, id);
      return handled(snapshotToWireStatus(snapshot));
    }
    case "heartbeat": {
      await runFacadeOperation(() => chargePointService.sendHeartbeat(id));
      return handled(undefined);
    }
    case "start_heartbeat": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.startHeartbeat(id, params.interval),
      );
      return handled(undefined);
    }
    case "stop_heartbeat": {
      await runFacadeOperation(() => chargePointService.stopHeartbeat(id));
      return handled(undefined);
    }
    case "start_transaction": {
      const { params } = call;
      await runFacadeOperation(() => {
        const connectorId = params.connector;
        return chargePointService.startTransaction(
          id,
          connectorId,
          // Optional on the control plane since #299 but not in OCPP's
          // StartTransaction.req, so a missing one is drawn from the pool here.
          chargePointService.resolveIdTag(id, params.tagId, connectorId),
          {
            triggerReason: params.triggerReason,
            chargingState: params.chargingState,
          },
        );
      });
      return handled(undefined);
    }
    case "stop_transaction": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.stopTransaction(id, params.connector, {
          reason: params.reason,
          triggerReason: params.triggerReason,
        }),
      );
      return handled(undefined);
    }
    case "transaction_event": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendTransactionUpdate(id, params.connector, {
          triggerReason: params.triggerReason,
          chargingState: params.chargingState,
          meterValues: params.meterValues,
          context: params.context,
        }),
      );
      return handled(undefined);
    }
    case "authorize": {
      const { params } = call;
      // `tagId` is optional on the control plane (#299) but not in OCPP's
      // Authorize.req, so a missing one is drawn from the pool here.
      await runFacadeOperation(() =>
        chargePointService.authorize(
          id,
          chargePointService.resolveIdTag(id, params.tagId),
        ),
      );
      return handled(undefined);
    }
    case "data_transfer": {
      const { params } = call;
      // #348: the answer is the point of the message, so it is the result.
      return handled(
        await runFacadeOperation(() =>
          chargePointService.sendDataTransfer(
            id,
            params.vendorId,
            params.messageId,
            params.data,
          ),
        ),
      );
    }
    case "diagnostics_status_notification": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendDiagnosticsStatusNotification(id, params.status),
      );
      return handled(undefined);
    }
    case "firmware_status_notification": {
      const { params } = call;
      const { status, requestId } = params;
      await runFacadeOperation(() =>
        requestId === undefined
          ? chargePointService.sendFirmwareStatusNotification(id, status)
          : chargePointService.sendFirmwareStatusNotification(
              id,
              status,
              requestId,
            ),
      );
      return handled(undefined);
    }
    case "log_status_notification": {
      const { params } = call;
      // #345: the schema already holds `status` to the 2.0.1 vocabulary.
      await runFacadeOperation(() =>
        chargePointService.sendLogStatusNotification(
          id,
          params.status,
          params.requestId,
        ),
      );
      return handled(undefined);
    }
    case "security_event_notification": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendSecurityEventNotification(
          id,
          params.type,
          params.techInfo,
        ),
      );
      return handled(undefined);
    }
    case "sign_certificate": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendSignCertificate(id, params.csr),
      );
      return handled(undefined);
    }
    case "update_connector_status": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendStatusNotification(
          id,
          params.connector,
          params.status,
          readStatusNotificationOptions(params),
        ),
      );
      return handled(undefined);
    }
    case "set_meter_value": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setMeterValue(id, params.connector, params.value),
      );
      return handled(undefined);
    }
    case "send_meter_value": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendMeterValue(id, params.connector, params.context),
      );
      return handled(undefined);
    }
    case "remove_connector": {
      const { params } = call;
      const connectorId = params.connector;
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
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setEVSettings(
          id,
          params.connector,
          params.settings as unknown as EVSettings,
        ),
      );
      return handled(undefined);
    }
    case "get_ev_settings": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getEVSettings(id, params.connector),
        ),
      );
    }
    case "set_auto_traffic_config": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setAutoTrafficConfig(
          id,
          params.connector,
          params.config as unknown as AutoTrafficConfig,
        ),
      );
      return handled(undefined);
    }
    case "get_auto_traffic_config": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getAutoTrafficConfig(id, params.connector),
        ),
      );
    }
    case "set_auto_meter_config": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setAutoMeterValueConfig(
          id,
          params.connector,
          params.config as unknown as AutoMeterValueConfig,
        ),
      );
      return handled(undefined);
    }
    case "get_auto_meter_config": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getAutoMeterValueConfig(id, params.connector),
        ),
      );
    }
    case "set_auto_reset_to_available": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setAutoResetToAvailable(
          id,
          params.connector,
          params.enabled,
        ),
      );
      return handled(undefined);
    }
    case "set_mode": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setConnectorMode(id, params.connector, params.mode),
      );
      return handled(undefined);
    }
    case "set_soc": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setConnectorSoc(id, params.connector, params.soc),
      );
      return handled(undefined);
    }
    case "set_soc_meter_sync": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setConnectorSocMeterSync(
          id,
          params.connector,
          params.enabled,
        ),
      );
      return handled(undefined);
    }
    case "get_charging_profiles": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getChargingProfiles(id, params.connector),
        ),
      );
    }
    case "get_state_history": {
      const { params } = call;
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
      await requireChargePointSnapshot(chargePointService, id);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getScenarioTemplates(),
        ),
      );
    }
    case "load_scenario_template": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.loadScenarioTemplate(
            id,
            params.templateId,
            params.connector,
            params.evSettings as Partial<EVSettings> | undefined,
          ),
        ),
      );
    }
    case "load_scenario": {
      const { params } = call;
      const connectorId = params.connector;
      if (typeof params.file === "string") {
        // Kept, not re-read: the reload baseline has to be the bytes this
        // definition came from, or a write between here and the watch starting
        // is recorded as already-seen and never applied (#314).
        const loadedText = fs.readFileSync(params.file, "utf-8");
        const parsed: unknown = JSON.parse(loadedText);
        if (!isScenarioDefinitionShape(parsed)) {
          throw new RpcFailure("invalid_params", "");
        }
        warnOnScenarioSchemaMismatch(params.file, parsed);
        const loaded = await runFacadeOperation(() =>
          chargePointService.loadScenario(id, connectorId, parsed),
        );
        // #314: a scenario loaded *from a path* is watchable; the inline
        // `params.scenario` branch below has no file behind it and is not.
        attachScenarioFile(fileReload, database, {
          filePath: params.file,
          cpId: id,
          connectorId,
          scenarioId: loaded.scenarioId,
          loadedText,
        });
        return handled(loaded);
      }
      if (params.scenario) {
        warnOnScenarioSchemaMismatch(
          "load_scenario params.scenario",
          params.scenario,
        );
        const loaded = await runFacadeOperation(() =>
          chargePointService.loadScenario(
            id,
            connectorId,
            params.scenario as unknown as ScenarioDefinition,
          ),
        );
        // #314: an inline definition replaces whatever was under this id, file
        // or not. Leaving an earlier `load_scenario { file }` watch in place
        // would let the next edit of that file overwrite the definition the
        // operator just installed by hand — and leaving its persisted row in
        // place would let a later `--watch` restart do the same, which is why
        // that goes whether or not this daemon is watching anything.
        detachScenarioFile(
          fileReload,
          database,
          id,
          connectorId,
          loaded.scenarioId,
        );
        return handled(loaded);
      }
      throw new Error("Either 'file' or 'scenario' parameter is required");
    }
    case "list_scenarios": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.listScenarios(id, params.connector),
        ),
      );
    }
    case "run_scenario": {
      const { params } = call;
      const { strict, awaitArmed } = params;
      await runFacadeOperation(() =>
        chargePointService.runScenario(
          id,
          params.connector,
          params.scenarioId,
          strict !== undefined || awaitArmed !== undefined
            ? { strict, awaitArmed }
            : undefined,
        ),
      );
      return handled(undefined);
    }
    case "scenario_status": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getScenarioStatus(
            id,
            params.connector,
            params.scenarioId,
          ),
        ),
      );
    }
    case "scenario_report": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getScenarioReport(
            id,
            params.connector,
            params.scenarioId,
            params.runId,
          ),
        ),
      );
    }
    case "get_scenario": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getScenario(
            id,
            params.connector,
            params.scenarioId,
          ),
        ),
      );
    }
    case "stop_scenario": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.stopScenario(
          id,
          params.connector,
          params.scenarioId,
        ),
      );
      return handled(undefined);
    }
    case "scenario_reset": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.resetScenario(
          id,
          params.connector,
          params.scenarioId,
        ),
      );
      return handled(undefined);
    }
    case "step_scenario": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.stepScenario(
          id,
          params.connector,
          params.scenarioId,
          params.force === true,
        ),
      );
      return handled(undefined);
    }
    case "extend_scenario_wait": {
      const id = requireFacadeCpId(cpId, rawParams);
      await runFacadeOperation(() =>
        chargePointService.extendScenarioWait(
          id,
          requirePositiveInt(params, "connector"),
          requireString(params, "scenarioId"),
          requirePositiveInt(params, "seconds"),
        ),
      );
      return handled(undefined);
    }
    case "retry_scenario_wait": {
      const id = requireFacadeCpId(cpId, rawParams);
      await runFacadeOperation(() =>
        chargePointService.retryScenarioWait(
          id,
          requirePositiveInt(params, "connector"),
          requireString(params, "scenarioId"),
        ),
      );
      return handled(undefined);
    }
    case "continue_scenario_wait": {
      const id = requireFacadeCpId(cpId, rawParams);
      await runFacadeOperation(() =>
        chargePointService.continueScenarioWait(
          id,
          requirePositiveInt(params, "connector"),
          requireString(params, "scenarioId"),
        ),
      );
      return handled(undefined);
    }
    case "stop_all_scenarios": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.stopAllScenarios(id, params.connector),
      );
      return handled(undefined);
    }
    case "remove_scenario": {
      const { params } = call;
      const connectorId = params.connector;
      const scenarioId = params.scenarioId;
      const before = await runFacadeOperation(() =>
        chargePointService.listScenarios(id, connectorId),
      );
      await runFacadeOperation(() =>
        chargePointService.removeScenario(id, connectorId, scenarioId),
      );
      const after = await chargePointService.listScenarios(id, connectorId);
      // #314: the file behind a removed scenario stops being watched, or the
      // next edit would re-create the scenario that was just deleted. The
      // persisted row goes unconditionally — it is a fact about stored state,
      // not about `--watch`, and a daemon running without the flag would
      // otherwise leave it for a later watched restart to reattach.
      detachScenarioFile(fileReload, database, id, connectorId, scenarioId);
      return handled({
        removed:
          before.some((scenario) => scenario.scenarioId === scenarioId) &&
          !after.some((scenario) => scenario.scenarioId === scenarioId),
      });
    }
    case "run_scenario_file": {
      const { params } = call;
      const filePath = params.file;
      const connectorId = params.connector;
      let loadedText: string | undefined;
      const started = await runFacadeOperation(() =>
        chargePointService.runScenarioFile(id, filePath, {
          connectorId,
          strict: params.strict,
          onSourceText: (text) => {
            loadedText = text;
          },
        }),
      );
      attachScenarioFile(fileReload, database, {
        filePath,
        cpId: id,
        connectorId,
        scenarioId: started.scenarioId,
        loadedText,
      });
      return handled(started);
    }
    case "run_scenario_template": {
      const { params } = call;
      const once = params.once;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.runScenarioTemplate(id, params.templateId, {
            connectorId: params.connector,
            evSettings: params.evSettings as Partial<EVSettings> | undefined,
            strict: params.strict,
            ...(once === undefined ? {} : { once }),
          }),
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
  { scope }: Params<"events.subscribe">,
): Promise<SubscribeResult> {
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
  { scope }: Params<"events.unsubscribe">,
): void {
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
    scope !== SCENARIO_DEFINITIONS_EVENTS_SCOPE &&
    scope !== FILE_RELOAD_EVENTS_SCOPE;
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

/**
 * The rule that decides which word a facade failure gets back (#286).
 *
 * Exported because it *is* the contract: `not_found` is a statement about the
 * registry, `connect_failed` about the CSMS, `internal` about this daemon, and
 * a test that re-implements the rule instead of calling it would keep passing
 * while the three drifted apart. Returns null when the error is not one this
 * rule classifies, leaving it to propagate.
 */
export function classifyFacadeError(err: unknown): RpcFailure | null {
  if (err instanceof RpcFailure) return err;
  // cp.create/cp.update reject bad security-profile config (missing
  // authorizationKey for profiles 1-2, missing client cert/key for profile 3)
  // eagerly via CPRegistry.prepareInit, before anything is mutated.
  if (err instanceof OcppSecurityProfileConfigError) {
    return new RpcFailure("invalid_params", err.message);
  }
  if (!(err instanceof Error)) return null;
  if (err.message.includes("already exists")) {
    return new RpcFailure("invalid_params", "");
  }
  if (
    err.message.includes("cpId not found") ||
    err.message.includes("not registered in LocalChargePointService")
  ) {
    return new RpcFailure("not_found", "");
  }
  // #286: `connect` resolves when the socket opens and rejects on the first
  // close, so a CSMS that refuses the upgrade lands here. Nothing broke -- the
  // daemon opened a socket, the CSMS said no, and the reconnect loop is
  // already running -- so `internal` was the wrong word for it. The close code
  // and reason travel in the message.
  if (
    err.message.startsWith("Connection failed:") ||
    err.message.startsWith("Connection timeout")
  ) {
    return new RpcFailure("connect_failed", err.message);
  }
  // #240: a scenario control aimed at a scenario that cannot take it (unknown,
  // not running, not parked on a wait, …) is a caller error, not a daemon
  // fault. The message names only the scenario id.
  if (err instanceof ScenarioRunStateError) {
    return new RpcFailure("invalid_params", err.message);
  }
  return null;
}

async function runFacadeOperation<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof RpcFailure) throw err;
    // The config rejection is the one case worth a server-side line: it names
    // the missing field (never a secret) and an operator reading the daemon
    // log should see why a create was refused.
    if (err instanceof OcppSecurityProfileConfigError) {
      console.warn(`[server] rejected charge point config: ${err.message}`);
    }
    const classified = classifyFacadeError(err);
    if (classified) throw classified;
    throw err;
  }
}

/**
 * #286 — a missing `cpId` is `invalid_params`, not `not_found`.
 *
 * `not_found` is a statement about the registry: this charge point does not
 * exist. When the envelope simply carried `cpId` in the wrong place it does
 * exist, and the reader is sent hunting for a creation bug. The two shapes
 * are genuinely easy to mix up — `cp.create` takes `cpId` INSIDE `params`,
 * every CP-scoped method takes it as a SIBLING of `method` — so the message
 * names the confusion when the params object is where it ended up.
 */
function requireFacadeCpId(target: RpcTarget): string {
  if (!target.cpId) throw missingCpId(target);
  return target.cpId;
}

function missingCpId(target: RpcTarget): RpcFailure {
  return new RpcFailure(
    "invalid_params",
    target.cpIdInParams
      ? 'missing cpId: it belongs beside "method", not inside "params"'
      : "missing cpId",
  );
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
      networkSim: snapshot.networkSim,
    };
  }
  return {
    id: snapshot.id,
    status: snapshot.status,
    config: snapshot.config,
    networkSim: snapshot.networkSim,
  };
}

function snapshotToWireStatus(snapshot: ChargePointSnapshot): StatusWire {
  return statusToWire({
    id: snapshot.id,
    status: snapshot.status,
    error: snapshot.error,
    connectors: snapshot.connectors.map(connectorSnapshotToWire),
    heartbeat: snapshot.heartbeat,
    networkSim: snapshot.networkSim,
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
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.create"> | Record<string, unknown>,
): ReturnType<typeof parseCreateBody> {
  try {
    return parseCreateBody(params, {
      soapCallbackUrlDerivable: deps.registry.canDeriveSoapCallbackUrl(),
    });
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
    scope === FILE_RELOAD_EVENTS_SCOPE ||
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
  params: Params<"cp.update">,
  existing: CLIChargePointService,
): Record<string, unknown> {
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

function readStatusNotificationOptions({
  errorCode,
  info,
  vendorErrorCode,
  vendorId,
  timestamp,
  suppressChargingStateTransactionEvent,
}: Params<"update_connector_status">): StatusNotificationOptions | undefined {
  const opts: StatusNotificationOptions = stripUndefined({
    errorCode,
    info,
    vendorErrorCode,
    vendorId,
    timestamp: timestamp === undefined ? undefined : new Date(timestamp),
    suppressChargingStateTransactionEvent,
  });
  return hasStatusNotificationOptions(opts) ? opts : undefined;
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

export function errorCodeFrom(err: unknown): RpcErrorCode {
  if (err instanceof RpcFailure) return err.code;
  return "internal";
}

function errorAck(
  code: RpcErrorCode,
  message?: string,
): {
  ok: false;
  error: { code: RpcErrorCode; message: string };
} {
  return {
    ok: false,
    error: { code, message: message ?? publicErrorMessage(code) },
  };
}

/**
 * Most RpcFailures carry an empty message and rely on `publicErrorMessage`'s
 * canned per-code text. A few (e.g. the security-profile config validation
 * mapped in runFacadeOperation) carry a specific, non-secret message naming
 * what's wrong — thread that through to the client instead of discarding it.
 */
export function rpcFailureMessage(err: unknown): string | undefined {
  if (err instanceof RpcFailure && err.message) {
    return redactSensitiveText(err.message);
  }
  return undefined;
}

function directError(err: unknown): unknown {
  const ack = errorAck(errorCodeFrom(err), rpcFailureMessage(err));
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
