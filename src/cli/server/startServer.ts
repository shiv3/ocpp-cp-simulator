import * as fs from "fs";
import type { Server } from "bun";
import { CLIChargePointService } from "../service";

type AnyServer = Server<unknown>;
import type { ChargePointInitOptions } from "../types";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "../../scenario/scenarioSchemaValidator";
import { CPRegistry } from "./CPRegistry";
import { NetworkSimManager } from "./NetworkSimManager";
import { EventBus } from "./eventBus";
import { createLifecycle } from "./lifecycle";
import { createHttpHandlers, type CorsPolicy } from "./httpServer";
import {
  attachSocketIo,
  createSocketConfigRepository,
  createRuntimeDeps,
  isSocketIoPath,
} from "./socketServer";
import { createMcpHandler } from "./mcp/mcpServer";
import { RegistryChargePointService } from "./RegistryChargePointService";
import { BunSqliteDatabase } from "../../cp/domain/persistence/BunSqliteDatabase";
import type { Database } from "../../cp/domain/persistence/Database";
import { SqliteScenarioRepository } from "../../cp/domain/persistence/SqliteScenarioRepository";
import { SqliteConnectorSettingsRepository } from "../../data/sqlite/SqliteConnectorSettingsRepository";
import { getGlobalLogFormat } from "../../cp/shared/Logger";
import { expandIdPattern } from "../../protocol";
import { resolveSoapCallbackUrl } from "../soapCallbackUrl";
import { soapCallbackRouteCpId } from "./socketServer";
import {
  MetricsRecorder,
  setGlobalMetricsRecorder,
} from "./metrics/MetricsRecorder";
import { renderMetrics } from "./metrics/render";
import { BlueprintRepository } from "../../cp/domain/persistence/BlueprintRepository";
import { FileReloadManager } from "./FileReloadManager";
import { forgetWatchedScenarioFile } from "./watchedScenarioFiles";

/**
 * Setup-time chatter from the daemon ("[server] Listening on …",
 * "[server] Connecting to CSMS…"). Plain mode keeps the legacy
 * "[server] <msg>" prefix; JSON mode wraps each call in a one-line JSON
 * object so the whole stderr stream is structured.
 */
function serverLog(message: string): void {
  if (getGlobalLogFormat() === "json") {
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "INFO",
        type: "Server",
        message,
      }) + "\n",
    );
    return;
  }
  process.stderr.write(`[server] ${message}\n`);
}

export interface ServerOptions {
  readonly httpPort: number | null;
  readonly httpHost: string;
  readonly pidPath: string | null;
  readonly bootstrap: ChargePointInitOptions | null;
  /**
   * Number of charge points to bootstrap from `bootstrap`. Above 1 the `cpId`
   * is replaced by `bootstrapIdPattern` expanded per index; the rest of the
   * options are shared. Mirrors the `cp.create_many` RPC so a CI job gets the
   * same fleet from a flag as from the control plane.
   */
  readonly bootstrapCount?: number;
  readonly bootstrapIdPattern?: string;
  /**
   * SOAP callback inputs, kept unresolved so a fleet can derive one address
   * per charge point. `bootstrap.soapCallbackUrl` is already resolved for the
   * single-CP case and stays authoritative there.
   */
  readonly soapCallbackUrlExplicit?: string | null;
  readonly soapPublicBaseUrl?: string | null;
  /** Serve `GET /metrics`. Off by default; `--metrics` turns it on. */
  readonly metrics?: boolean;
  /**
   * Serve `/metrics` outside the Basic Auth gate. Opt-in for a trusted
   * network — the default is that the gate covers it, unlike the health path.
   */
  readonly metricsNoAuth?: boolean;
  readonly autoConnect: boolean;
  readonly startupScenario: {
    readonly scenario: string | null;
    readonly scenarioTemplate: string | null;
    readonly scenarioTemplateFile: string | null;
    /** "all" | "1" | "1,2,3" — resolved to a list of connector ids at startup. */
    readonly scenarioConnector: string;
  } | null;
  readonly cors: CorsPolicy;
  /**
   * If set, non-/v1 GETs are served from this directory (SPA aware).
   * Lets you ship the daemon and the browser UI in one process.
   */
  readonly staticDir: string | null;
  /**
   * Optional second HTTP listener for the bundled web console. If equal
   * to `httpPort`, a single listener serves both socket.io/health and UI. If different,
   * a second `Bun.serve` is bound to this port (the UI is also exposed on
   * that port together with socket.io/health so the browser can reach both at the
   * same origin).
   */
  readonly webConsolePort: number | null;
  /** Filesystem path for the SQLite state DB. `null` means run in memory
   *  — handy for tests / one-off CSMS probes; durable persistence is off. */
  readonly stateDb: string | null;
  /** Absolute URL path the health-check JSON is served on. Defaults to
   *  `/v1/healthz` (set by the CLI). */
  readonly healthPath: string;
  /** Optional Basic Auth credentials for the inbound HTTP server (web
   *  console / non-health HTTP). Health path is exempt. Null = no
   *  auth. Plumbed straight through to `createHttpHandlers`. */
  readonly webConsoleBasicAuth: {
    readonly username: string;
    readonly password: string;
  } | null;
  readonly insecureTlsKeyPerms: boolean;
  /**
   * Re-read the blueprint-instantiated idTag files and scenario files this
   * process loaded when they change on disk (#314). Off by default: a daemon
   * that silently re-reads files under the operator is surprising, and the
   * agent-driven workflows this project is built around go through the control
   * plane, where there is nothing on disk to re-read.
   */
  readonly watch?: boolean;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  // Open the persistent state DB up front so every CP we create (boot
  // bootstrap or via socket.io RPC) gets the same Database handle. Without
  // --state-db we stay in-memory; the log line below makes the choice
  // visible because a silent in-memory daemon would surprise the operator.
  let database: Database | null = null;
  if (opts.stateDb) {
    database = BunSqliteDatabase.open(opts.stateDb);
    serverLog(`State DB: ${opts.stateDb}`);
  } else {
    serverLog("State DB: in-memory (pass --state-db <path> to persist)");
  }

  // One recorder for the whole daemon: the exposition is process-wide and
  // carries no cpId label, so there is nothing per-charge-point to keep.
  //
  // Registered HERE, before `restoreFromDatabase()` below, for the same reason
  // the network-sim manager is: a restored charge point's
  // CLIChargePointService constructor is where the recorder gets attached, and
  // a recorder created after that runs would leave every persisted charge
  // point counted in the gauges but silent in every counter, for the life of
  // the daemon.
  const metricsRecorder = opts.metrics ? new MetricsRecorder() : null;
  setGlobalMetricsRecorder(metricsRecorder);

  // One instance for both transports: without --state-db the repository holds
  // blueprints in memory, so a per-transport instance would make a blueprint
  // saved over socket.io `not_found` over MCP, and vice versa.
  const blueprints = new BlueprintRepository(database);

  const bus = new EventBus();
  // Passed so a restored charge point resumes the background traffic it was
  // configured with (#300); the config lives in `connector_settings`, not the
  // connector row, so it needs its own restore.
  const connectorSettingsRepository = new SqliteConnectorSettingsRepository(
    database,
  );
  const registry = new CPRegistry(
    bus,
    database,
    { allowInsecureTlsKeyPerms: opts.insecureTlsKeyPerms },
    connectorSettingsRepository,
  );
  // Create network simulation manager and wire it to the registry BEFORE
  // restoring CPs so they get their config attached before connect().
  const networkSimManager = new NetworkSimManager(database, {
    listLiveWsCpIds: () => registry.liveWsCpIds(),
    applyToCp: (cpId, resolved) => {
      registry.get(cpId)?.setNetworkSimConfig(resolved);
    },
    triggerCpDisconnect: (cpId, ruleId) => {
      const svc = registry.get(cpId);
      if (!svc) {
        return { ok: false, error: "not_connected" };
      }
      return svc.triggerNetworkSimDisconnect(ruleId);
    },
  });
  registry.setNetworkSimManager(networkSimManager);

  // #314: constructed before the charge points are restored below so the
  // initial `syncFromRegistry()` sees them, and before attachSocketIo so the
  // RPC layer can hand it the scenario files it loads. Its push sink is set
  // once the socket.io bridge exists.
  const fileReload = opts.watch
    ? new FileReloadManager(registry, { log: serverLog, database })
    : null;
  if (fileReload) {
    registry.onInitChange(() => fileReload.syncFromRegistry());
  }

  const configRepository = createSocketConfigRepository(database);
  const scenarioRepository = new SqliteScenarioRepository(database);
  const chargePointService = new RegistryChargePointService(registry, {
    database,
    configRepository,
    scenarioRepository,
    connectorSettingsRepository,
  });
  // Re-create CPs that were registered before the previous daemon shut
  // down. Has to happen BEFORE the CLI bootstrap (`opts.bootstrap`) so a
  // re-run with the same --cp-id is treated as "update wsUrl/connectors"
  // rather than "create + collide".
  const restored = await Promise.resolve(
    chargePointService.restoreFromDatabase(),
  );
  if (restored.length > 0) {
    serverLog(
      `Restored ${restored.length} CP(s) from state DB: ${restored.join(", ")}`,
    );
  }
  let lifecycle: ReturnType<typeof createLifecycle> | null = null;
  const socketIo = attachSocketIo({
    registry,
    bus,
    database,
    configRepository,
    scenarioRepository,
    connectorSettingsRepository,
    blueprints,
    chargePointService,
    fileReload,
    webConsoleBasicAuth: opts.webConsoleBasicAuth,
    requestShutdown: () => {
      lifecycle?.requestShutdown();
    },
  });
  // The bridge only exists once socket.io is attached, so the sink is wired
  // here rather than at construction.
  fileReload?.setSink((event) =>
    socketIo.registryEvents?.emitFileReloaded(event),
  );
  // #314: a reloaded scenario is a definition change like any other, and the
  // console listens on the `scenario-definitions` scope, not on `file-reload`.
  fileReload?.setScenarioDefinitionsSink((cpId, connectorId, definitions) =>
    socketIo.registryEvents?.emitScenarioDefinitionsChanged(
      cpId,
      connectorId,
      definitions,
    ),
  );
  lifecycle = createLifecycle({
    pidPath: opts.pidPath,
    registry,
    onShutdownStart: () => {
      fileReload?.close();
      void socketIo.close();
    },
  });
  const socketIoRoute = {
    matches: isSocketIoPath,
    handleRequest: socketIo.handleRequest,
  };

  // Build runtime deps for MCP handler (shares state with socket.io).
  // This uses the same instances as attachSocketIo to ensure both transports
  // operate on the same CPRegistry, database, and repositories.
  const runtimeDeps = createRuntimeDeps({
    registry,
    bus,
    database,
    configRepository,
    scenarioRepository,
    connectorSettingsRepository,
    blueprints,
    chargePointService,
    fileReload,
  });
  const mcpHandler = createMcpHandler(runtimeDeps);

  // Two listener configurations:
  //   * "api"  — health + socket.io, no static fallback.
  //   * "console" — health + socket.io + static files (UI); used by the
  //     --web-console port so the browser talks to the daemon at the same
  //     origin without CORS.
  const metricsConfig = metricsRecorder
    ? {
        render: () => renderMetrics(registry, metricsRecorder),
        exemptFromBasicAuth: opts.metricsNoAuth === true,
      }
    : null;

  const apiHandlers = createHttpHandlers({
    registry,
    bus,
    lifecycle,
    cors: opts.cors,
    database,
    healthPath: opts.healthPath,
    webConsoleBasicAuth: opts.webConsoleBasicAuth,
    socketIo: socketIoRoute,
    mcp: { handler: mcpHandler },
    metrics: metricsConfig,
  });
  const consoleHandlers = opts.staticDir
    ? createHttpHandlers({
        registry,
        bus,
        lifecycle,
        cors: opts.cors,
        staticDir: opts.staticDir,
        database,
        healthPath: opts.healthPath,
        webConsoleBasicAuth: opts.webConsoleBasicAuth,
        socketIo: socketIoRoute,
        mcp: { handler: mcpHandler },
        metrics: metricsConfig,
      })
    : apiHandlers;
  if (opts.staticDir) {
    serverLog(`Web console: ${opts.staticDir}`);
  }
  if (metricsRecorder) {
    serverLog(
      opts.metricsNoAuth
        ? "Metrics: GET /metrics (unauthenticated — trusted network only)"
        : "Metrics: GET /metrics",
    );
  }
  if (opts.webConsoleBasicAuth) {
    // Visible-on-startup log line so an operator can confirm the gate is on.
    // Credential values are intentionally not logged.
    serverLog(
      `HTTP Basic Auth: enabled (health path ${opts.healthPath} exempt)`,
    );
  }
  serverLog(`Health endpoint: GET ${opts.healthPath}`);
  const servers: AnyServer[] = [];

  // --http-port and --web-console may share a port (single listener) or
  // use different ports (two listeners). When they share, the listener
  // gets the console handler (socket.io/health + UI).
  const httpPortShared =
    opts.httpPort != null && opts.httpPort === opts.webConsolePort;

  if (opts.httpPort != null) {
    const handlers = httpPortShared ? consoleHandlers : apiHandlers;
    const httpServer = Bun.serve({
      port: opts.httpPort,
      hostname: opts.httpHost,
      fetch: handlers.fetch,
      idleTimeout: socketIo.idleTimeout,
      websocket: socketIo.websocket,
    });
    servers.push(httpServer);
    lifecycle.attachServer(httpServer);
    serverLog(
      `Listening on http://${opts.httpHost}:${opts.httpPort}` +
        (httpPortShared ? " (socket.io + web console)" : " (socket.io)"),
    );
    serverLog(
      `MCP endpoint: POST http://${opts.httpHost}:${opts.httpPort}/mcp`,
    );
  }

  if (opts.webConsolePort != null && !httpPortShared) {
    const consoleServer = Bun.serve({
      port: opts.webConsolePort,
      hostname: opts.httpHost,
      fetch: consoleHandlers.fetch,
      idleTimeout: socketIo.idleTimeout,
      websocket: socketIo.websocket,
    });
    servers.push(consoleServer);
    lifecycle.attachServer(consoleServer);
    serverLog(`Web console on http://${opts.httpHost}:${opts.webConsolePort}`);
    serverLog(
      `MCP endpoint: POST http://${opts.httpHost}:${opts.webConsolePort}/mcp`,
    );
  }

  if (servers.length === 0) {
    throw new Error("Server has no listener (httpPort required)");
  }

  lifecycle.installSignalHandlers();

  const fleet = expandBootstrap(opts);
  const hasExplicitStartupScenario =
    !!opts.startupScenario &&
    (!!opts.startupScenario.scenario ||
      !!opts.startupScenario.scenarioTemplate ||
      !!opts.startupScenario.scenarioTemplateFile);
  const seedDefault = !hasExplicitStartupScenario;

  // Register the whole fleet first. Creation is synchronous, so every charge
  // point is in the registry — and answering `cp.list` — before anything waits
  // on a network. Connecting inside the loop instead meant an unreachable CSMS
  // serialised a 30s connect (and up to another 30s of boot wait in a startup
  // scenario) per charge point, so a 20-CP bootstrap could take 20 minutes
  // before the last one existed at all.
  const started: Array<{
    svc: ReturnType<CPRegistry["create"]>;
    init: ChargePointInitOptions;
  }> = [];
  for (const init of fleet) {
    // The same cpId can already exist when --state-db restored it above.
    // Reuse the restored instance in that case — re-creating would throw
    // and we'd lose all of its persisted state. Skip the auto-seed for
    // bootstrap CPs that arrive together with an explicit startup
    // scenario; otherwise both would land on the connector and race for
    // the auto-start slot.
    const existing = registry.get(init.cpId);
    const svc = existing ?? registry.create(init, { seedDefault });
    if (existing) {
      serverLog(`Bootstrap matches restored CP "${init.cpId}"; reusing`);
    } else {
      serverLog(`Bootstrapped CP "${init.cpId}"`);
    }
    started.push({ svc, init });
  }

  fileReload?.syncFromRegistry();

  if (!opts.autoConnect && !opts.startupScenario) {
    finishWatchSetup(fileReload, serverLog);
    return;
  }

  // Bounded rather than unbounded: a fleet all dialling at once is a thundering
  // herd at the CSMS, and the point here is only that one slow connect must not
  // block the next.
  await forEachBounded(
    started,
    BOOTSTRAP_CONCURRENCY,
    async ({ svc, init }) => {
      if (opts.autoConnect) {
        serverLog(`Connecting ${init.cpId} to CSMS...`);
        try {
          await svc.connect();
          serverLog(`Connected ${init.cpId}.`);
        } catch (err) {
          serverLog(
            `Connection failed for ${init.cpId}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      if (opts.startupScenario) {
        await runStartupScenario(
          svc,
          opts.startupScenario,
          init.connectors,
          fileReload,
          database,
        );
      }
    },
  );

  finishWatchSetup(fileReload, serverLog);
}

/**
 * Re-establish the watches a previous run registered over the control plane,
 * then say what is being watched (#314).
 *
 * Deliberately **after** the bootstrap has run its `--scenario` /
 * `--scenario-template-file` loads, not before. A stored row can name the same
 * scenario id the operator's flag uses — `--scenario` keeps the file's own id
 * when the file already targets its connector — and restoring first meant
 * reconciling that abandoned file, auto-starting its graph if the edit it
 * picked up while the daemon was down carried a matching trigger, and then
 * having the real startup load replace only the definition while
 * `startScenarioIfNotAlreadyActive` saw the stale executor still running. The
 * operator's explicit flag lost to a row.
 *
 * Ordering rather than filtering, because ownership is already expressed: a
 * startup registration takes over its key and deletes any row stored under it.
 * Running the bootstrap first simply lets that assertion happen before anything
 * reads the rows, so the two rules compose instead of needing a third that
 * knows which keys are startup-owned. Rows for scenarios the flags do *not*
 * claim are restored exactly as before.
 */
function finishWatchSetup(
  fileReload: FileReloadManager | null,
  serverLog: (message: string) => void,
): void {
  fileReload?.restoreScenarioWatches();
  logWatchSummary(fileReload, serverLog);
}

/**
 * Report what `--watch` ended up watching.
 *
 * Logged after the fleet exists *and* after `runStartupScenario` has registered
 * whatever `--scenario` / `--scenario-template-file` loaded — those register
 * inside the bootstrap loop, so counting before it told an operator "0 file(s)"
 * about a daemon that was watching a scenario file (#314). An operator who sees
 * nothing reload can then tell "--watch is off" from "--watch is on and no file
 * is behind any of this daemon's state". A filesystem that cannot watch reports
 * itself separately, once, from FileWatcher.
 */
function logWatchSummary(
  fileReload: FileReloadManager | null,
  serverLog: (message: string) => void,
): void {
  if (!fileReload) return;
  const paths = fileReload.watchedPaths();
  serverLog(
    `Watch: enabled — re-reading ${paths.length} loaded file(s) on change (#314)` +
      (paths.length > 0 ? `: ${paths.join(", ")}` : ""),
  );
}

/** How many bootstrap charge points connect at once. */
const BOOTSTRAP_CONCURRENCY = 8;

async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (let i = next++; i < items.length; i = next++) {
        await run(items[i]!);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * The charge points `--cp-id` (plus `--cp-count` / `--cp-id-pattern`) asks for.
 *
 * One without a count, N with one — sequential, so the log and the registry
 * events read in id order. Everything but `cpId` is shared, exactly as
 * `cp.create_many` shares it.
 */
function expandBootstrap(
  opts: ServerOptions,
): readonly ChargePointInitOptions[] {
  if (!opts.bootstrap) return [];
  const count = opts.bootstrapCount ?? 1;
  if (count <= 1) return [opts.bootstrap];
  const pattern = opts.bootstrapIdPattern ?? `${opts.bootstrap.cpId}{n:03}`;
  const fleet: ChargePointInitOptions[] = [];
  for (let i = 1; i <= count; i++) {
    const cpId = expandIdPattern(pattern, i);
    fleet.push({
      ...opts.bootstrap,
      cpId,
      soapCallbackUrl: fleetSoapCallbackUrl(opts, cpId, i),
    });
  }
  return fleet;
}

/**
 * The SOAP callback address for one charge point in a fleet.
 *
 * The daemon routes inbound CS→CP calls on `<soapPath>/<cpId>/ChargePointService`
 * and advertises this URL verbatim, so a fleet sharing one address would send
 * every station's callbacks to the first station's route. `--soap-public-base-url`
 * is therefore re-derived per generated id rather than reused from the resolved
 * single-CP value, and an explicit `--soap-callback-url` carries the same `{n}`
 * placeholder as the id pattern (the CLI refuses one that does not).
 */
function fleetSoapCallbackUrl(
  opts: ServerOptions,
  cpId: string,
  index: number,
): string | undefined {
  const explicit = opts.soapCallbackUrlExplicit?.trim();
  if (explicit) {
    const expanded = expandIdPattern(explicit, index);
    // Same rule the RPC enforces, checked the same way — through the router's
    // own pattern and percent-decoding, so the two cannot disagree about an id
    // that needs encoding or a path with an extra segment.
    if (soapCallbackRouteCpId(expanded) !== cpId) {
      throw new Error(
        `--soap-callback-url expands to "${expanded}", whose charge point route segment is not "${cpId}". ` +
          `The daemon routes inbound SOAP calls by that segment, so the CSMS would get 404s.`,
      );
    }
    return expanded;
  }
  const resolved = resolveSoapCallbackUrl({
    explicitCallbackUrl: null,
    publicBaseUrl: opts.soapPublicBaseUrl ?? null,
    cpId,
    soapPath: opts.bootstrap?.soapPath,
  });
  return resolved ?? undefined;
}

/**
 * Resolve a `--scenario-connector` value ("all" | "1" | "1,2,3") to an
 * explicit list of connector ids in [1..connectorCount]. Silently skips
 * out-of-range values and de-duplicates.
 */
function resolveConnectorIds(raw: string, connectorCount: number): number[] {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "all") {
    const ids: number[] = [];
    for (let i = 1; i <= connectorCount; i++) ids.push(i);
    return ids;
  }
  const seen = new Set<number>();
  for (const part of trimmed.split(",")) {
    const n = parseInt(part, 10);
    if (Number.isInteger(n) && n >= 1 && n <= connectorCount) {
      seen.add(n);
    }
  }
  return [...seen];
}

/**
 * Issue #214: advisory (warning-only) schema check for a scenario file read
 * from disk at startup. Never throws and never blocks loading — a schema
 * mismatch is logged to stderr and the caller proceeds exactly as it would
 * have before this check existed.
 */
function warnOnScenarioSchemaMismatch(source: string, value: unknown): void {
  const result = validateScenarioSchema(value);
  if (!result.valid) {
    process.stderr.write(
      `[server] Warning: "${source}" does not match schema/scenario.schema.json (loading anyway): ${result.errors.slice(0, 5).join("; ")}\n`,
    );
  }
}

/**
 * Start `scenarioId` unless it's already running. Loading a scenario
 * (loadScenario/loadScenarioTemplate) while the CP is already Available
 * synchronously triggers CLIChargePointService's own "connect"-trigger
 * auto-start for manual, `triggerOn: "connect"` scenarios (the common/
 * default case — see `tryAutoStartForConnector`) — which is exactly the
 * case for every startup scenario once we've waited for boot acceptance
 * below. Calling `runScenario` unconditionally after `loadScenario`
 * would then throw "already running". Checking first keeps this
 * idempotent for both that auto-started case AND scenarios the
 * auto-start engine doesn't cover (non-"connect" triggers, disabled-then-
 * re-enabled, etc.), which still need this explicit call.
 */
function startScenarioIfNotAlreadyActive(
  svc: CLIChargePointService,
  connectorId: number,
  scenarioId: string,
): void {
  const alreadyActive = svc
    .listScenarios(connectorId)
    .some((s) => s.scenarioId === scenarioId && s.active);
  if (!alreadyActive) {
    svc.runScenario(connectorId, scenarioId);
  }
}

export async function runStartupScenario(
  svc: CLIChargePointService,
  opt: NonNullable<ServerOptions["startupScenario"]>,
  connectorCount: number,
  /** Null unless the daemon runs with `--watch` (#314). */
  fileReload: FileReloadManager | null = null,
  /**
   * The `--state-db`, when there is one. Separate from `fileReload` because a
   * startup registration's effect on stored state is not conditional on the
   * watcher: taking over a key deletes whatever row was stored under it, and a
   * daemon started without `--watch` must still do that or a later watched
   * start would reattach the abandoned file (#314).
   */
  database: Database | null = null,
): Promise<void> {
  const connectors = resolveConnectorIds(opt.scenarioConnector, connectorCount);
  if (connectors.length === 0) {
    process.stderr.write(
      `[server] No matching connectors for --scenario-connector "${opt.scenarioConnector}"\n`,
    );
    return;
  }

  // Wait (bounded) for each target connector's boot gate to open before
  // firing anything. `svc.connect()` above only waits for the WebSocket
  // to open, not for BootNotification.conf — a scenario with no leading
  // delay before its first transaction node (e.g.
  // cert16-tc005-ev-side-disconnect) can otherwise send StartTransaction
  // while the boot gate is still closed. The boot gate silently drops
  // gated outgoing CALLs sent before Accepted (see
  // OCPPMessageHandler.sendRequest's isCallAllowed check), so the
  // scenario would proceed with a locally fabricated transactionId that
  // the CSMS never sees. See waitForBootAccepted() for the full
  // rationale and the timeout policy (30s bound, warn-and-proceed).
  await Promise.all(
    connectors.map((connectorId) =>
      svc.waitForBootAccepted(connectorId, {
        onTimeout: () => {
          process.stderr.write(
            `[server] Warning: BootNotification not accepted within 30s for connector ${connectorId}; starting scenario anyway (its outgoing CALLs may be dropped by the boot gate until the CSMS accepts)\n`,
          );
        },
      }),
    ),
  );

  // 1) Built-in template by id — instantiate per connector.
  if (opt.scenarioTemplate) {
    for (const connectorId of connectors) {
      try {
        const scenarioId = svc.loadScenarioTemplate(
          opt.scenarioTemplate,
          connectorId,
        );
        startScenarioIfNotAlreadyActive(svc, connectorId, scenarioId);
        process.stderr.write(
          `[server] Scenario template "${opt.scenarioTemplate}" started (id: ${scenarioId}, connector: ${connectorId})\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[server] Failed to start scenario template on connector ${connectorId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
    }
    return;
  }

  // 2) Template JSON file — read once, instantiate per connector (cpId-independent).
  if (opt.scenarioTemplateFile) {
    let template: ScenarioDefinition;
    let templateText: string;
    try {
      templateText = fs.readFileSync(opt.scenarioTemplateFile, "utf-8");
      template = JSON.parse(templateText) as ScenarioDefinition;
    } catch (err) {
      process.stderr.write(
        `[server] Failed to read scenario template file: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
      return;
    }
    warnOnScenarioSchemaMismatch(opt.scenarioTemplateFile, template);
    for (const connectorId of connectors) {
      try {
        const instance = instantiateTemplate(template, connectorId);
        const scenarioId = svc.loadScenario(connectorId, instance);
        // #314: `prepare` replays the same per-connector rewrite on every
        // reload, so a fan-out across connectors keeps its independent copies
        // instead of collapsing onto the file's own targetId.
        fileReload?.registerScenarioFile({
          filePath: opt.scenarioTemplateFile as string,
          cpId: svc.getInit().cpId,
          connectorId,
          scenarioId,
          prepare: (definition) => instantiateTemplate(definition, connectorId),
          loadedText: templateText,
          // Not persisted: a row cannot carry `prepare`, and this bootstrap
          // runs again on every boot with a fresh instance id per connector.
          // Persisting it left the next `--state-db` start with the previous
          // run's watches restored prepare-less, reloading the file's own
          // target over the prepared copies (#314).
          persist: false,
        });
        forgetWatchedScenarioFile(
          database,
          svc.getInit().cpId,
          connectorId,
          scenarioId,
        );
        startScenarioIfNotAlreadyActive(svc, connectorId, scenarioId);
        process.stderr.write(
          `[server] Scenario template file "${opt.scenarioTemplateFile}" applied (id: ${scenarioId}, connector: ${connectorId})\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[server] Failed to apply template file on connector ${connectorId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
    }
    return;
  }

  // 3) Single scenario file — for fan-out, treat it like a template (rewrite
  // ids per connector); for single-connector, behave as before.
  if (opt.scenario) {
    let definition: ScenarioDefinition;
    let scenarioText: string;
    try {
      scenarioText = fs.readFileSync(opt.scenario, "utf-8");
      definition = JSON.parse(scenarioText) as ScenarioDefinition;
    } catch (err) {
      process.stderr.write(
        `[server] Failed to read scenario file: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
      return;
    }
    warnOnScenarioSchemaMismatch(opt.scenario, definition);
    for (const connectorId of connectors) {
      try {
        // Re-evaluated per definition, not captured once (#314). A single
        // connector whose `--scenario` already targets it is loaded as-is; edit
        // `targetId` or `targetType` in that file and the answer changes, so a
        // `prepare` that remembered the first answer left the definition
        // registered on the original connector while its executor derived
        // expectations from the edited target — waiting on a connector it was
        // not attached to, and never firing.
        const alreadyTargeted = (next: ScenarioDefinition): boolean =>
          connectors.length === 1 &&
          next.targetType === "connector" &&
          next.targetId === connectorId;
        const prepare = (next: ScenarioDefinition): ScenarioDefinition =>
          alreadyTargeted(next) ? next : instantiateTemplate(next, connectorId);
        const scenarioId = svc.loadScenario(connectorId, prepare(definition));
        fileReload?.registerScenarioFile({
          filePath: opt.scenario as string,
          cpId: svc.getInit().cpId,
          connectorId,
          scenarioId,
          prepare,
          loadedText: scenarioText,
          // As above: `prepare` decides per reload whether the file already
          // targets this connector, and no persisted row can replay that.
          persist: false,
        });
        forgetWatchedScenarioFile(
          database,
          svc.getInit().cpId,
          connectorId,
          scenarioId,
        );
        startScenarioIfNotAlreadyActive(svc, connectorId, scenarioId);
        process.stderr.write(
          `[server] Scenario file "${opt.scenario}" started (id: ${scenarioId}, connector: ${connectorId})\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[server] Failed to start scenario file on connector ${connectorId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
    }
  }
}

/**
 * Produce a connector-specific copy of a scenario definition by rewriting
 * targetType / targetId / id / name. Nodes and edges are deep-cloned so
 * multiple connectors can run independent state machines from one file.
 */
function instantiateTemplate(
  template: ScenarioDefinition,
  connectorId: number,
): ScenarioDefinition {
  const cloned = JSON.parse(JSON.stringify(template)) as ScenarioDefinition;
  return {
    ...cloned,
    id: `${cloned.id}-c${connectorId}-${Date.now()}`,
    name: cloned.name
      ? `${cloned.name} (Connector ${connectorId})`
      : `Connector ${connectorId}`,
    targetType: "connector",
    targetId: connectorId,
  };
}

export { DEFAULT_HTTP_PORT } from "./constants";
export const DEFAULT_PID_PATH = "/tmp/ocpp-server.pid";
