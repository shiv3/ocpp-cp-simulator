import type { ModemCommand as ModemCommandInput } from "@ocpp-cp-simulator/contracts/modem";
import { describeDefaultBehaviors } from "@ocpp-cp-simulator/core/cp/application/engine/behaviors/index";
import { runtime, type RuntimeServer, type SocketIoEngine } from "../runtime";
import type { BunWebSocketHandler } from "../runtime/bun";
import {
  Server as SocketIoServer,
  type Socket as SocketIoSocket,
} from "socket.io";
import { handleJsonCommand } from "../jsonMode";
import {
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
  subscribeResultSchema,
  type Params,
  type RpcAck,
  type RpcCall,
  type RpcErrorCode,
  type ServerInfo,
  type SimulatorConfigInput,
  type StatusWire,
  type SubscribeResult,
} from "@ocpp-cp-simulator/contracts/index";
import type { ConnectorSettingsRepository } from "@ocpp-cp-simulator/client/interfaces/ConnectorSettingsRepository";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { FleetTemplateRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/FleetTemplateRepository";
import type { ScenarioRepository } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioRepository";
import { redactSensitiveText } from "@ocpp-cp-simulator/core/cp/shared/redaction";
import { DEFAULT_SOAP_PATH } from "../soapPath";
import { appVersion } from "../appVersion";
import { createScenarioRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/createScenarioRepository";
import { SqliteConnectorSettingsRepository } from "@ocpp-cp-simulator/client/sqlite/SqliteConnectorSettingsRepository";
import { BlueprintRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BlueprintRepository";
import { VehicleProfileRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/VehicleProfileRepository";
import type { VehicleCatalog } from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleCatalog";
import {
  deleteVehicleProfile,
  getCatalogVariant,
  listCatalogMakes,
  listCatalogVariants,
  listVehicleProfiles,
  saveVehicleProfile,
  searchCatalogModels,
} from "./vehicleRpc";
import { builtInBlueprints } from "@ocpp-cp-simulator/core/utils/blueprints/index";
import {
  classifyFacadeError,
  requireFacadeCpId,
  runFacadeOperation,
  type RpcTarget,
} from "./rpc/facadeErrors";
import { snapshotToFullCp, snapshotToWireStatus } from "./rpc/wireSnapshot";
import { registerSocketAuth } from "./rpc/socketAuth";
import {
  createCp,
  createFleet,
  createManyCps,
  deleteBlueprint,
  deleteFleetTemplate,
  getFleetTemplate,
  reloadBehaviors,
  saveBlueprint,
  saveFleetTemplate,
  setCpBehaviors,
  setCpLabels,
  soapCallbackRouteCpId,
  updateCp,
} from "./rpc/cpProvisioning";
import { dispatchFacadeCpCommand } from "./rpc/facadeCpCommands";
import {
  getConfig,
  saveConfig,
  getNetworkSimGlobal,
  saveNetworkSimGlobal,
  getNetworkSimCp,
  saveNetworkSimCp,
  saveCellularPolicies,
  triggerNetworkSimDisconnect,
  applyDefaultEVSettingsRpc,
  listScenarioRuns,
  getTimeline,
  listChargingSessions,
  getConfigKeys,
  setConfigKey,
  getAutoMeterConfig,
  saveAutoMeterConfig,
  getAutoTrafficSetting,
  saveAutoTrafficSetting,
  getSocMeterSync,
  saveSocMeterSync,
} from "./rpc/settingsRpcs";
import {
  listCps,
  bulkCps,
  runScenarioOnSelector,
  deleteCp,
  getLogs,
  clearLogs,
  resetState,
} from "./rpc/cpRpcs";
import { probeCp } from "./rpc/cpProbe";
import type { CPRegistry } from "./CPRegistry";
import type { EventBus } from "./eventBus";
import { getGlobalMetricsRecorder } from "./metrics/MetricsRecorder";
import {
  createRegistryEventBridge,
  type RegistryEventBridge,
} from "./registryEvents";
import type { FileReloadManager } from "./FileReloadManager";
import {
  deleteScenarioDefinition,
  listScenarioDefinitions,
  replaceConnectorScenarioDefinitions,
  saveScenarioDefinition,
} from "./rpc/scenarioDefinitions";
import {
  RegistryChargePointService,
  type RegistryConfigRepository,
} from "./RegistryChargePointService";
export const SOCKET_IO_PATH = "/socket.io/";
export const SOCKET_IO_PING_INTERVAL_MS = 25_000;
export const SOCKET_IO_PING_TIMEOUT_MS = 20_000;

export interface SocketIoAttachment {
  readonly io: SocketIoServer;
  /** The runtime's Engine.IO server; pass it to `runtime.serve({ socketIo })`. */
  readonly engine: SocketIoEngine;
  /** Bun only: the `websocket` handler for `Bun.serve` (see {@link SocketIoEngine}). */
  readonly websocket: BunWebSocketHandler;
  readonly idleTimeout: number;
  /** The push bridge, so a caller that produced it indirectly (the daemon's
   *  `--watch` reloader, #314) can emit through the same socket.io server. */
  readonly registryEvents: RegistryEventBridge | null;
  handleRequest(req: Request, server: RuntimeServer): Promise<Response>;
  close(): Promise<void>;
}

export interface SocketIoDeps {
  readonly registry: CPRegistry;
  readonly bus: EventBus;
  readonly database?: Database | null;
  readonly requestShutdown?: () => void;
  /** `server.info`; absent → version only, no SOAP public base. */
  readonly serverInfo?: ServerInfo;
  /** #622: per-charge-point wait of `cp.bulk` / `cp.scenario.run` (ms). */
  readonly cpBulkWaitMs?: number;
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
  /** Shared for the same reason as `blueprints` (#445). */
  readonly fleetTemplates?: FleetTemplateRepository;
  /** Shared for the same reason as `blueprints` (#458). */
  readonly vehicleProfiles?: VehicleProfileRepository;
  /**
   * The vehicle catalog an import reads (#458), holding the daemon's API
   * key; absent or null when no `--oed-base-url` was given.
   */
  readonly vehicleCatalog?: VehicleCatalog | null;
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
  readonly fleetTemplates: FleetTemplateRepository;
  readonly vehicleProfiles: VehicleProfileRepository;
  readonly vehicleCatalog: VehicleCatalog | null;
}

interface SocketRpcState {
  inFlight: number;
  tokens: number;
  lastRefillMs: number;
  joinedScopes: Set<string>;
}

type RpcAckFn = (ack: RpcAck) => void;
type DirectAckFn = (ack: unknown) => void;
type RpcMethod = keyof typeof METHODS;

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
  const engine = runtime.createSocketIoEngine(io, {
    path: SOCKET_IO_PATH,
    pingInterval: SOCKET_IO_PING_INTERVAL_MS,
    pingTimeout: SOCKET_IO_PING_TIMEOUT_MS,
    maxHttpBufferSize: MAX_HTTP_BUFFER,
  });
  const registryEvents = deps
    ? createRegistryEventBridge(io, { registry: deps.registry, bus: deps.bus })
    : null;
  const runtimeDeps = deps
    ? createRuntimeDeps(deps, registryEvents)
    : undefined;
  registerSocketHandlers(io, runtimeDeps);

  return {
    io,
    engine,
    // Undefined on Node, where upgrades arrive on the http.Server.
    websocket: engine.websocket as BunWebSocketHandler,
    idleTimeout: engine.idleTimeout,
    registryEvents,
    handleRequest(req, server) {
      return engine.handleRequest(req, server);
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
    fleetTemplates:
      deps.fleetTemplates ?? new FleetTemplateRepository(database),
    vehicleProfiles:
      deps.vehicleProfiles ?? new VehicleProfileRepository(database),
    vehicleCatalog: deps.vehicleCatalog ?? null,
    chargePointService:
      deps.chargePointService ??
      new RegistryChargePointService(deps.registry, {
        database,
        configRepository,
        scenarioRepository:
          deps.scenarioRepository ??
          // A registry test double may not carry one.
          deps.registry.scenarioDefinitions ??
          createScenarioRepository(database),
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
    ack(
      errorAck(
        errorCodeFrom(err),
        rpcFailureMessage(err),
        retryAfterSecondsFrom(err),
      ),
    );
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
      return listCps(deps.chargePointService, call.params);
    case "cp.create":
      return createCp(deps, call.params);
    case "cp.probe":
      return probeCp(deps, call.params);
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
    case "fleet.template.list":
      return deps.fleetTemplates.list();
    case "fleet.template.get":
      return getFleetTemplate(deps, call.params);
    case "fleet.template.save":
      return saveFleetTemplate(deps, call.params);
    case "fleet.template.delete":
      return deleteFleetTemplate(deps, call.params);
    case "fleet.create":
      return createFleet(deps, call.params);
    case "cp.update":
      return updateCp(deps, call.params);
    case "cp.delete":
      return deleteCp(deps, call.params);
    case "cp.labels.set":
      return setCpLabels(deps, call.params);
    case "cp.behaviors.set":
      return setCpBehaviors(deps, call.params);
    case "behavior.list":
      return {
        behaviors: deps.registry.library.describe(),
        watching: deps.registry.library.watching,
        defaults: describeDefaultBehaviors(),
      };
    case "behavior.reload":
      return reloadBehaviors(deps);
    case "cp.bulk":
      return bulkCps(deps, call.params);
    case "cp.scenario.run":
      return runScenarioOnSelector(deps, call.params);
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
    case "network_sim.cellular.get":
      return runFacadeOperation(() => ({
        policies: deps.chargePointService.getCellularPolicies(),
      }));
    case "network_sim.cellular.save":
      return saveCellularPolicies(deps, call.params);
    case "network_sim.cellular.status":
      return runFacadeOperation(() =>
        deps.chargePointService.getCellularStatus(),
      );
    case "network_sim.disconnect.trigger":
      return triggerNetworkSimDisconnect(deps, call.params);
    case "modem.get":
      return runFacadeOperation(() =>
        deps.chargePointService.getModem(call.params.cpId),
      );
    case "modem.command": {
      const { cpId, ...command } = call.params;
      return runFacadeOperation(() =>
        deps.chargePointService.modemCommand(
          cpId,
          command as ModemCommandInput,
        ),
      );
    }
    case "power.loss": {
      const { cpId, ...options } = call.params;
      return runFacadeOperation(() =>
        deps.chargePointService.powerLoss(cpId, options),
      );
    }
    case "power.restore": {
      const { cpId, ...options } = call.params;
      return runFacadeOperation(() =>
        deps.chargePointService.powerRestore(cpId, options),
      );
    }
    case "scenario.templates":
      return deps.chargePointService.getScenarioTemplates();
    case "scenario.runs.list":
      return listScenarioRuns(deps, call.params);
    case "timeline.get":
      return getTimeline(deps, call.params);
    case "sessions.list":
      return listChargingSessions(deps, call.params);
    case "cp.config_keys.get":
      return getConfigKeys(deps, call.params);
    case "cp.config_keys.set":
      return setConfigKey(deps, call.params);
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
    case "vehicle_profiles.list":
      return listVehicleProfiles(deps);
    case "vehicle_profiles.save":
      return saveVehicleProfile(deps, call.params);
    case "vehicle_profiles.delete":
      return deleteVehicleProfile(deps, call.params);
    case "vehicle_catalog.list_makes":
      return listCatalogMakes(deps);
    case "vehicle_catalog.search_models":
      return searchCatalogModels(deps, call.params);
    case "vehicle_catalog.list_variants":
      return listCatalogVariants(deps, call.params);
    case "vehicle_catalog.get_variant":
      return getCatalogVariant(deps, call.params);
    case "events.subscribe":
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
  /** #458: whether a catalog URL and key are set — never the key itself. */
  vehicleCatalog?: { configured: boolean; authenticated: boolean };
}): ServerInfo {
  return {
    version: appVersion(),
    soap: {
      publicBaseUrl: soap.soapPublicBaseUrl,
      path: soap.soapPath,
      tunnel: soap.tunnel,
    },
    vehicleCatalog: {
      provider: "open-ev-directory",
      configured: soap.vehicleCatalog?.configured ?? false,
      authenticated: soap.vehicleCatalog?.authenticated ?? false,
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
  retryAfterSeconds?: number,
): {
  ok: false;
  error: { code: RpcErrorCode; message: string; retryAfterSeconds?: number };
} {
  return {
    ok: false,
    error: {
      code,
      message: message ?? publicErrorMessage(code),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  };
}

/** #458: how long a `rate_limited` upstream asked the client to wait. */
export function retryAfterSecondsFrom(err: unknown): number | undefined {
  return err instanceof RpcFailure ? err.retryAfterSeconds : undefined;
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
  const ack = errorAck(
    errorCodeFrom(err),
    rpcFailureMessage(err),
    retryAfterSecondsFrom(err),
  );
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
    case "rate_limited":
      return "rate limited";
    case "unavailable":
      return "unavailable";
    case "internal":
    default:
      return "internal error";
  }
}

export { classifyFacadeError, soapCallbackRouteCpId };
