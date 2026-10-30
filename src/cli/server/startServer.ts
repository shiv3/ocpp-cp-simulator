import * as fs from "fs";
import type { Server } from "bun";
import { CLIChargePointService } from "../service";

type AnyServer = Server<unknown>;
import type { ChargePointInitOptions, SoapTunnelConfig } from "../types";
import { matchesLabelSelector, type Labels } from "../../protocol/labels";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "../../scenario/scenarioSchemaValidator";
import { CPRegistry } from "./CPRegistry";
import { NetworkSimManager } from "./NetworkSimManager";
import { EventBus } from "./eventBus";
import { createLifecycle } from "./lifecycle";
import {
  createHttpHandlers,
  createSoapCallbackHandlers,
  type CorsPolicy,
} from "./httpServer";
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
import { SqliteConnectorSettingsRepository } from "../../data/sqlite/SqliteConnectorSettingsRepository";
import { getGlobalLogFormat } from "../../cp/shared/Logger";
import { expandIdPattern } from "../../protocol";
import {
  localHostForTunnel,
  soapTunnelStartupLines,
  startSoapTunnel,
  type SoapTunnel,
} from "../soapTunnel";
import { buildServerInfo, soapCallbackRouteCpId } from "./socketServer";
import {
  MetricsRecorder,
  setGlobalMetricsRecorder,
} from "./metrics/MetricsRecorder";
import { renderMetrics } from "./metrics/render";
import { VehicleProfileRepository } from "../../cp/domain/persistence/VehicleProfileRepository";
import { OpenEvDirectoryClient } from "../../cp/infrastructure/vehicle-catalog/open-ev-directory/OpenEvDirectoryClient";
import type { VehicleCatalogConfig } from "../vehicleCatalogConfig";
import { BlueprintRepository } from "../../cp/domain/persistence/BlueprintRepository";
import { FileReloadManager } from "./FileReloadManager";
import { forgetWatchedScenarioFile } from "./watchedScenarioFiles";
import {
  deleteScenarioRow,
  listStartupScenarioRows,
  loadWithStartupProvenance,
} from "./startupScenarioRows";
import { scenarioInstanceId } from "../scenarioInstanceId";
import { LEGACY_STARTUP_SOURCE_PREFIX } from "../../cp/domain/persistence/legacyStartupInstances";
import { getTemplateById } from "../../utils/scenarioTemplates";
import * as path from "path";

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
  /**
   * #458: the Open EV Directory API the console imports vehicle profiles
   * through, with the daemon's API key. Null or absent: import is off and
   * `vehicle_catalog.*` answers `unavailable`.
   */
  readonly vehicleCatalog?: VehicleCatalogConfig | null;
  /** `--soap-path`; the daemon-wide default for derived callback URLs. */
  readonly soapPath: string;
  /**
   * `--soap-tunnel ngrok` (#183): bind a listener that serves the SOAP
   * callback route and nothing else, expose it through ngrok, and use the
   * tunnel's public origin as the SOAP public base. Refused together with
   * `soapCallbackUrlExplicit` / `soapPublicBaseUrl`, as the CLI does.
   */
  readonly soapTunnel?: SoapTunnelConfig | null;
  /**
   * The tunnel provider; `startSoapTunnel` (ngrok) unless a caller supplies
   * another. Tests hand in one that needs no agent.
   */
  readonly startSoapTunnel?: typeof startSoapTunnel;
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

/** What `startServer` hands back: the bound ports and a way to stop it all. */
export interface RunningServer {
  /** Port the API listener bound (`httpPort`, resolved when it was 0); null without one. */
  readonly httpPort: number | null;
  /** Port of the SOAP-only listener the tunnel forwards to; null without a tunnel. */
  readonly soapCallbackPort: number | null;
  /** Stops every listener, the tunnel and the charge points without exiting the process. */
  stop(): void;
}

export async function startServer(
  inputOpts: ServerOptions,
): Promise<RunningServer> {
  // Refused before anything is opened. Two startup scenario flags used to be
  // silently ranked, differently by each of the three functions that read them,
  // and the disagreement showed up as restore rows held back for a scenario the
  // boot was never going to load. The CLI refuses this at parse time with the
  // same message; this is the door for every other caller, and it is here — not
  // at the first read, several hundred lines in — so a refused daemon has not
  // opened the state DB, registered metrics or restored a fleet first (#314).
  const startupConflict = startupScenarioOptionConflict(
    inputOpts.startupScenario,
  );
  if (startupConflict) throw new Error(startupConflict);

  // #183, in the issue's order: the SOAP callback listener, then the tunnel
  // that forwards to it, then everything that needs the tunnel's origin. The
  // listener serves the callback route and nothing else (see
  // `createSoapCallbackHandlers`), so the tunnel publishes that route alone —
  // socket.io, the console and MCP stay on the listeners bound further down.
  // Bound before the registry, which needs the origin, and reading the
  // registry per request: by the time a restored charge point tells the CSMS
  // its callback URL, a callback finds a bound listener and a routed charge
  // point. Failing here — a missing ngrok binary, a bad token — refuses the
  // daemon with only this listener to unwind.
  let registryRef: CPRegistry | null = null;
  let lifecycle: ReturnType<typeof createLifecycle> | null = null;
  const soapCallbackServer = inputOpts.soapTunnel
    ? Bun.serve({
        port: inputOpts.soapTunnel.localPort,
        hostname: inputOpts.httpHost,
        fetch: createSoapCallbackHandlers({ registry: () => registryRef })
          .fetch,
      })
    : null;
  let soapTunnel: SoapTunnel | null = null;
  try {
    soapTunnel = await openSoapTunnel(
      inputOpts,
      soapCallbackServer?.port ?? 0,
      (code) => {
        serverLog(
          `ngrok tunnel exited unexpectedly (code ${code}); SOAP callbacks are unreachable, shutting down`,
        );
        if (lifecycle) lifecycle.requestShutdown(1);
        else process.exit(1);
      },
      inputOpts.startSoapTunnel,
    );
  } catch (error) {
    soapCallbackServer?.stop(true);
    throw error;
  }
  const opts = soapTunnel
    ? { ...inputOpts, soapPublicBaseUrl: soapTunnel.publicBaseUrl }
    : inputOpts;

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
  // #458: one store and one catalog client for both transports, for the
  // same reason as the blueprints above.
  const vehicleProfiles = new VehicleProfileRepository(database);
  const vehicleCatalog = opts.vehicleCatalog
    ? new OpenEvDirectoryClient({
        baseUrl: opts.vehicleCatalog.baseUrl,
        apiKey: opts.vehicleCatalog.apiKey,
      })
    : null;

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
    {
      allowInsecureTlsKeyPerms: opts.insecureTlsKeyPerms,
      // Every SOAP charge point without a callback URL — bootstrapped,
      // restored or created over RPC — derives one from this base (#183).
      soapPublicBaseUrl: opts.soapPublicBaseUrl ?? null,
      soapPath: opts.soapPath,
    },
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
  // The SOAP callback listener above routes from here on.
  registryRef = registry;

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
  // #495: the registry's, which its charge points write to as well.
  const scenarioRepository = registry.scenarioDefinitions;
  const chargePointService = new RegistryChargePointService(registry, {
    database,
    configRepository,
    scenarioRepository,
    connectorSettingsRepository,
  });
  // Computed here rather than at the bootstrap loop because the watch restore
  // below needs it: these are the charge points a startup flag will load a
  // scenario onto, and their rows wait for the second pass.
  const fleet = expandBootstrap(opts);
  const hasExplicitStartupScenario = isExplicitStartupScenario(
    opts.startupScenario,
  );
  const seedDefault = !hasExplicitStartupScenario;
  // Two questions, two predicates. They are not the same set and conflating
  // them is what let a whole class of startup mode through (#314):
  //
  // - *Which stored scenario ids will a startup flag overwrite on this charge
  //   point?* — `startupClaimedByCp`, below. Used to hold watch rows back for
  //   the second pass, where being narrow is the entire point: skip more than
  //   the flag claims and the other restored scenarios go unwatched until they
  //   dial.
  // - *Which charge points is startup about to configure at all?* —
  //   `startupTargets`. Used to hold the dial back, where being narrow is
  //   wrong: a flag whose file cannot be read claims nothing and answers the
  //   first question with an empty set while still being about to reconfigure
  //   the charge point.
  //
  // Per charge point for the first, because the connector count decides whether
  // `--scenario` keeps the file's own id or instantiates a fresh one.
  //
  // Read **once**, here, and handed to both the prediction and the load. The
  // two used to open the file separately, minutes apart across the restored
  // fleet's connect, so an edit in that window made the prediction describe a
  // file that was no longer the one being loaded (#314). See
  // {@link readStartupScenarioFile}.
  const startupScenarioSource = readStartupScenarioFile(opts.startupScenario);
  // The exact (connector, id) pairs the flags will install, per bootstrap
  // charge point — `null` where the boot cannot tell (#338). The startup prune
  // keeps these and nothing else; the watch restore's first pass skips their
  // ids.
  const startupClaims = new Map(
    fleet.map((init) => [
      init.cpId,
      startupClaimedInstances(
        opts.startupScenario,
        init.connectors,
        startupScenarioSource,
      ),
    ]),
  );
  const startupClaimedByCp = new Map<string, ReadonlySet<string>>(
    [...startupClaims].map(([cpId, claimed]) => [
      cpId,
      new Set((claimed ?? []).map((one) => one.scenarioId)),
    ]),
  );
  const startupTargets = startupTargetCpIds(opts.startupScenario, fleet);

  // Re-create CPs that were registered before the previous daemon shut
  // down. Has to happen BEFORE the CLI bootstrap (`opts.bootstrap`) so a
  // re-run with the same --cp-id is treated as "update wsUrl/connectors"
  // rather than "create + collide".
  //
  // Rebuilt without dialling: the moment a restored charge point's boot gate
  // opens, a persisted connect-triggered scenario starts, and it must start
  // from the file as it reads now rather than as it read when the daemon
  // stopped (#314). The watches go back on in between, and `connectRestored`
  // below lets the fleet dial.
  // Straight to the registry rather than through the facade: the facade's
  // `restoreFromDatabase` is part of the shared `ChargePointService` interface
  // the browser implements too, and deferring the dial is a daemon concern.
  const restored = registry.restoreFromDatabase({ connect: false });
  if (restored.length > 0) {
    serverLog(
      `Restored ${restored.length} CP(s) from state DB: ${restored.join(", ")}`,
    );
  }
  // The one startup prune (#338): every restored charge point drops the
  // startup-generated rows this boot's flags no longer call for — before its
  // watches are restored and before anything dials, so a copy left by a
  // configuration no longer in force can neither be watched nor auto-start.
  for (const cpId of restored) {
    const svc = registry.get(cpId);
    if (svc) pruneStaleStartupScenarios(svc, database, startupClaims);
  }
  // First pass. See `finishWatchSetup` for the second, and for the three
  // constraints this sequence has to satisfy at once.
  fileReload?.restoreScenarioWatches({
    skip: startupClaimedRowSkip(startupClaimedByCp),
  });
  // Split, not just deferred. A charge point that startup is about to configure
  // must not dial here when the bootstrap loop is going to dial it anyway: the
  // moment its boot gate opens, the *restored* copy of its scenarios
  // auto-starts, and dialling this early leaves the whole bootstrap loop —
  // every other charge point's connect, which can be minutes against a slow
  // CSMS — between that start and the flag's load. Held back, the dial and the
  // load happen in the same iteration, one immediately after the other.
  //
  // Only when `--auto-connect` is on, because that is what makes the bootstrap
  // loop dial. Without it nothing else would, and `runStartupScenario`'s
  // `waitForBootAccepted` would spend its full 30s timeout per connector on a
  // charge point this function had deliberately left unconnected (#314).
  const dialLater = restoredDialsToDefer(
    restored,
    startupTargets,
    opts.autoConnect === true,
  );
  registry.connectRestored(restored.filter((cpId) => !dialLater.has(cpId)));
  // Fixed for the daemon's lifetime and answered by both transports:
  // `server.info` over Socket.IO and over MCP `call_method` must describe
  // the same daemon, so the one object is handed to both below (#354
  // follow-up: the MCP path used to get none and answered the no-base
  // fallback while a tunnel was up).
  const serverInfo = buildServerInfo({
    soapPublicBaseUrl: opts.soapPublicBaseUrl ?? null,
    soapPath: opts.soapPath,
    tunnel: soapTunnel
      ? { provider: soapTunnel.provider, mode: soapTunnel.mode }
      : null,
    vehicleCatalog: {
      configured: vehicleCatalog?.configured ?? false,
      authenticated: vehicleCatalog?.authenticated ?? false,
    },
  });
  const socketIo = attachSocketIo({
    registry,
    bus,
    database,
    serverInfo,
    configRepository,
    scenarioRepository,
    connectorSettingsRepository,
    blueprints,
    vehicleProfiles,
    vehicleCatalog,
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
      // Sync kill, so the agent is gone before process.exit() below.
      soapTunnel?.close();
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
    serverInfo,
    configRepository,
    scenarioRepository,
    connectorSettingsRepository,
    blueprints,
    vehicleProfiles,
    vehicleCatalog,
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
  let boundHttpPort: number | null = null;
  if (soapCallbackServer) {
    servers.push(soapCallbackServer);
    lifecycle.attachServer(soapCallbackServer);
    serverLog(
      `SOAP callback listener on http://${opts.httpHost}:${soapCallbackServer.port} (tunnel target; callback route only)`,
    );
  }

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
    boundHttpPort = httpServer.port ?? null;
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

  if (soapTunnel) {
    // The token, when one was given, went to ngrok through its environment
    // and is deliberately not part of these lines.
    for (const line of soapTunnelStartupLines({
      tunnel: soapTunnel,
      soapPath: opts.bootstrap?.soapPath ?? opts.soapPath,
      cpId:
        (opts.bootstrapCount ?? 1) > 1 ? null : (opts.bootstrap?.cpId ?? null),
    })) {
      serverLog(line);
    }
  }

  if (opts.httpPort == null && opts.webConsolePort == null) {
    throw new Error("Server has no listener (httpPort required)");
  }

  lifecycle.installSignalHandlers();

  // ---------------------------------------------------------------------
  // The daemon is now SERVING. `Bun.serve` is bound above, so socket.io and
  // the HTTP routes accept requests from here on, and everything below runs
  // concurrently with them: fleet creation, `--state-db` restore, the bounded
  // connect loop (which awaits the network), `runStartupScenario`, and the
  // watch restore at the end. There is no quiescent window after the listener
  // opens, so anything below that reads persisted state has to treat what this
  // process already holds as newer than what the database remembers — see
  // `FileReloadManager.restoreScenarioWatches`. Listening later is not the
  // answer: `cp.list` answering before an unreachable CSMS times out is the
  // behaviour the ordering above exists for (#314).
  // ---------------------------------------------------------------------

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
      serverLog(
        `Bootstrap matches restored CP "${init.cpId}"; reusing` +
          labelsNotAppliedNote(init.labels, existing.getInit().labels),
      );
    } else {
      serverLog(`Bootstrapped CP "${init.cpId}"`);
    }
    started.push({ svc, init });
  }

  fileReload?.syncFromRegistry();

  const running: RunningServer = {
    httpPort: boundHttpPort,
    soapCallbackPort: soapCallbackServer?.port ?? null,
    stop() {
      fileReload?.close();
      void socketIo.close();
      soapTunnel?.close();
      for (const server of servers) server.stop(true);
      registry.shutdownAll();
      database?.close();
    },
  };

  if (!opts.autoConnect && !opts.startupScenario) {
    finishWatchSetup(fileReload, serverLog);
    return running;
  }

  // Bounded rather than unbounded: a fleet all dialling at once is a thundering
  // herd at the CSMS, and the point here is only that one slow connect must not
  // block the next.
  await forEachBounded(
    started,
    BOOTSTRAP_CONCURRENCY,
    async ({ svc, init }) => {
      // Install BEFORE the dial, start after (#314). The two halves used to be
      // one call placed after `connect()`, and with a restored `--state-db`
      // that left the boot gate auto-starting the *previous* boot's copy of
      // this very scenario: since a generated instance's id is stable, the
      // load that followed found its own id already active, left the stale
      // executor running, and never ran the current graph. Installing first
      // makes what the gate auto-starts the configured definition, and gives
      // `--watch`'s registration a chance to reconcile the captured copy
      // against disk while nothing is in flight to defer the result behind.
      const installed = opts.startupScenario
        ? installStartupScenario(
            svc,
            opts.startupScenario,
            init.connectors,
            fileReload,
            database,
            // The same object `startupClaimedByCp` was built from: the claim
            // and the load must describe the same bytes (#314).
            startupScenarioSource,
          )
        : [];
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
      await startStartupScenario(svc, installed);
    },
  );

  finishWatchSetup(fileReload, serverLog);
  return running;
}

/**
 * Second pass of the watch restore, then say what is being watched (#314).
 *
 * Three constraints have to hold at once, and no single position in the
 * sequence satisfies all three — which is why the restore is split rather than
 * moved again:
 *
 * 1. **A restored charge point must not run a stale graph.** Its persisted
 *    connect-triggered scenarios start as soon as its boot gate opens, so the
 *    watch has to be back and the file reconciled *before* it dials. The first
 *    pass runs immediately after `restoreFromDatabase({ connect: false })` and
 *    before `connectRestored`.
 * 2. **A startup flag owns its keys before its rows are read.** A stored row
 *    can name the id `--scenario` will claim, and reconciling it first would
 *    put the abandoned graph on the connector and possibly start it. The first
 *    pass therefore skips the bootstrap charge points; this second pass, after
 *    `runStartupScenario`, picks up whatever the flags did not claim — by then
 *    a takeover has deleted the rows they did.
 * 3. **A restored row must not overwrite a live registration.** The listener is
 *    bound before the bootstrap, so an RPC can register a watch at any point
 *    in here. That one is *not* solved by position: `restoreScenarioWatches`
 *    skips keys it already holds, in both passes. Keeping it out of the
 *    ordering is what lets 1 and 2 be satisfied independently.
 *
 * This pass also does the pruning: a row whose scenario is no longer loaded is
 * dropped here, once every path that could still load one has run.
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
 * Suffix for the "reusing" log line when `--label` asked for labels a
 * restored charge point does not carry (#472). The restored labels win, like
 * every other bootstrap option; saying so keeps the flag from looking broken
 * to an operator who added it to an existing deployment.
 */
function labelsNotAppliedNote(
  requested: Labels | undefined,
  restored: Labels | undefined,
): string {
  if (!requested) return "";
  const same =
    restored !== undefined &&
    Object.keys(requested).length === Object.keys(restored).length &&
    matchesLabelSelector(restored, requested);
  if (same) return "";
  return ` (--label not applied; it keeps its stored labels ${JSON.stringify(restored ?? {})})`;
}

/**
 * The charge points `--cp-id` (plus `--cp-count` / `--cp-id-pattern`) asks for.
 *
 * One without a count, N with one — sequential, so the log and the registry
 * events read in id order. Everything but `cpId` is shared, exactly as
 * `cp.create_many` shares it — `--label` labels included (#472).
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
    const explicit = opts.soapCallbackUrlExplicit?.trim();
    fleet.push({
      ...opts.bootstrap,
      cpId,
      // Without an explicit URL the registry derives one per station from
      // the daemon's SOAP public base at instantiation (#183).
      ...(explicit
        ? { soapCallbackUrl: expandExplicitSoapCallbackUrl(explicit, cpId, i) }
        : {}),
    });
  }
  return fleet;
}

/**
 * Open the SOAP tunnel described by `--soap-tunnel` towards the SOAP-only
 * listener bound on `localPort`, or nothing. Exported for tests; `start` is
 * the tunnel provider, injectable so the wiring can be checked without an
 * ngrok binary.
 */
export async function openSoapTunnel(
  opts: Pick<
    ServerOptions,
    "soapTunnel" | "soapCallbackUrlExplicit" | "soapPublicBaseUrl" | "httpHost"
  >,
  localPort: number,
  onExit: (code: number | null) => void,
  start: typeof startSoapTunnel = startSoapTunnel,
): Promise<SoapTunnel | null> {
  if (!opts.soapTunnel) return null;
  if (opts.soapCallbackUrlExplicit?.trim() || opts.soapPublicBaseUrl?.trim()) {
    throw new Error(
      "--soap-tunnel cannot be combined with --soap-callback-url or --soap-public-base-url",
    );
  }
  return start({
    localHost: localHostForTunnel(opts.httpHost),
    localPort,
    authToken: opts.soapTunnel.authToken,
    domain: opts.soapTunnel.domain,
    apiUrl: opts.soapTunnel.apiUrl,
    onExit,
  });
}

/**
 * Expand an explicit `--soap-callback-url` for one charge point of a fleet.
 *
 * The daemon routes inbound CS→CP calls on `<soapPath>/<cpId>/ChargePointService`
 * and advertises this URL verbatim, so a fleet sharing one address would send
 * every station's callbacks to the first station's route. The explicit URL
 * therefore carries the same `{n}` placeholder as the id pattern (the CLI
 * refuses one that does not), and its expansion is checked against the route.
 */
export function expandExplicitSoapCallbackUrl(
  explicit: string,
  cpId: string,
  index: number,
): string {
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

/** One connector's worth of what {@link installStartupScenario} loaded. */
export interface InstalledStartupScenario {
  readonly connectorId: number;
  readonly scenarioId: string;
}

/**
 * Load — and, under `--watch`, register — what the startup flags configure,
 * **without touching the network**.
 *
 * Split from starting it so the daemon can install *before* the charge point
 * dials. That ordering is the whole point, and it closes two windows at once:
 *
 * - **A restored definition must not run in the flag's place.** With
 *   `--state-db`, a charge point the flags configure comes back holding the
 *   previous boot's copy of that scenario, and the moment its boot gate opens
 *   the auto-start fires. Since #314 gave a generated instance a *stable* id,
 *   the flag's load and the restored copy are the same key — so a run started
 *   before the load leaves `startScenarioIfNotAlreadyActive` looking at an
 *   already-active id, and the stale graph keeps running while the current one
 *   never does. (While the ids differed, the flag's load installed a different
 *   key and the restored run was orphaned against a definition no longer
 *   installed, which is why this was recorded as tolerable — a judgement about
 *   the surrounding code that expired when that code changed.) Installing
 *   first means what auto-starts on the boot gate *is* the configured
 *   definition.
 * - **The captured copy must be reconciled before anything runs it.** The
 *   file is read once per boot, well before the restored fleet's connect;
 *   `registerScenarioFile` compares that copy against disk immediately, so an
 *   edit saved in the window is applied here — before the gate opens, with
 *   nothing in flight to defer it behind.
 *
 * Nothing here starts a run. `loadScenario`'s connect-auto-start is gated on
 * `chargePoint.status === Available`, which an undialled charge point is not,
 * so the installed definition sits inert until {@link startStartupScenario}
 * (for a `manual`-triggered scenario) or the boot gate's auto-start (for a
 * trigger-matching one) runs it.
 *
 * **Failure**: a per-connector failure is reported and the other connectors
 * still install; an unreadable file installs nothing and reports it.
 * **Provenance**: with a database, every row installed here is marked with
 * the flag that generated it ({@link startupProvenance}, #338), which is what
 * lets a later boot's {@link pruneStaleStartupScenarios} recognise it — except
 * a row that already existed user-authored under the same id, which stays so. Nothing
 * is removed here: the prune ran at restore, before anything dialled.
 * **Trigger**: called once per bootstrap charge point, before its dial.
 */
export function installStartupScenario(
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
  /**
   * The boot's single read of the scenario file (#314). The daemon always
   * passes the same object it gave {@link startupClaimedScenarioIds}, so the
   * claim and the load describe the same bytes; the default is for direct
   * callers that have no claim to agree with, where this read *is* the load
   * and nothing can disagree with it.
   */
  source: StartupScenarioFile | null = readStartupScenarioFile(opt),
): InstalledStartupScenario[] {
  const installed: InstalledStartupScenario[] = [];
  // Which flag is in effect is asked once, through the same resolver
  // `startupClaimedScenarioIds` and `readStartupScenarioFile` read, so the load
  // and the prediction of it cannot pick different flags (#314).
  const mode = resolveStartupScenarioMode(opt);
  if (!mode) return installed;
  const connectors = resolveConnectorIds(opt.scenarioConnector, connectorCount);
  if (connectors.length === 0) {
    process.stderr.write(
      `[server] No matching connectors for --scenario-connector "${opt.scenarioConnector}"\n`,
    );
    return installed;
  }

  // 1) Built-in template by id — instantiate per connector.
  if (mode.kind === "template") {
    for (const connectorId of connectors) {
      try {
        const scenarioId = loadWithStartupProvenance(
          database,
          svc.getInit().cpId,
          connectorId,
          startupProvenance(mode),
          () => svc.loadScenarioTemplate(mode.templateId, connectorId),
        );
        installed.push({ connectorId, scenarioId });
        process.stderr.write(
          `[server] Scenario template "${mode.templateId}" loaded (id: ${scenarioId}, connector: ${connectorId})\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[server] Failed to load scenario template on connector ${connectorId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
    }
    return installed;
  }

  // 2) Template JSON file — read once, instantiate per connector (cpId-independent).
  if (mode.kind === "templateFile") {
    if (!source?.definition || source.text === null) {
      process.stderr.write(
        `[server] Failed to read scenario template file: ${
          source?.error instanceof Error
            ? source.error.message
            : (source?.error ?? mode.path)
        }\n`,
      );
      return installed;
    }
    const template = source.definition;
    const templateText = source.text;
    warnOnScenarioSchemaMismatch(mode.path, template);
    for (const connectorId of connectors) {
      try {
        const instance = instantiateTemplate(template, connectorId);
        const scenarioId = loadWithStartupProvenance(
          database,
          svc.getInit().cpId,
          connectorId,
          startupProvenance(mode),
          () => svc.loadScenario(connectorId, instance),
        );
        // #314: `prepare` replays the same per-connector rewrite on every
        // reload, so a fan-out across connectors keeps its independent copies
        // instead of collapsing onto the file's own targetId.
        fileReload?.registerScenarioFile({
          filePath: mode.path,
          cpId: svc.getInit().cpId,
          connectorId,
          scenarioId,
          prepare: (definition) => instantiateTemplate(definition, connectorId),
          loadedText: templateText,
          // Not persisted: a row cannot carry `prepare`, and this bootstrap
          // runs again on every boot and registers again. Persisting it left the next `--state-db` start with the previous
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
        installed.push({ connectorId, scenarioId });
        process.stderr.write(
          `[server] Scenario template file "${mode.path}" applied (id: ${scenarioId}, connector: ${connectorId})\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[server] Failed to apply template file on connector ${connectorId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
    }
    return installed;
  }

  // 3) Single scenario file — for fan-out, treat it like a template (rewrite
  // ids per connector); for single-connector, behave as before.
  if (mode.kind === "file") {
    if (!source?.definition || source.text === null) {
      process.stderr.write(
        `[server] Failed to read scenario file: ${
          source?.error instanceof Error
            ? source.error.message
            : (source?.error ?? mode.path)
        }\n`,
      );
      return installed;
    }
    const definition = source.definition;
    const scenarioText = source.text;
    warnOnScenarioSchemaMismatch(mode.path, definition);
    for (const connectorId of connectors) {
      try {
        // Re-evaluated per definition, not captured once (#314). A single
        // connector whose `--scenario` already targets it is loaded as-is; edit
        // `targetId` or `targetType` in that file and the answer changes, so a
        // `prepare` that remembered the first answer left the definition
        // registered on the original connector while its executor derived
        // expectations from the edited target — waiting on a connector it was
        // not attached to, and never firing.
        const prepare = (next: ScenarioDefinition): ScenarioDefinition =>
          scenarioFileTargetsConnector(next, connectorId, connectors.length)
            ? next
            : instantiateTemplate(next, connectorId);
        const scenarioId = loadWithStartupProvenance(
          database,
          svc.getInit().cpId,
          connectorId,
          startupProvenance(mode),
          () => svc.loadScenario(connectorId, prepare(definition)),
        );
        fileReload?.registerScenarioFile({
          filePath: mode.path,
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
        installed.push({ connectorId, scenarioId });
        process.stderr.write(
          `[server] Scenario file "${mode.path}" loaded (id: ${scenarioId}, connector: ${connectorId})\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[server] Failed to load scenario file on connector ${connectorId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
    }
  }
  return installed;
}

/**
 * Start what {@link installStartupScenario} loaded, once the boot gate is open.
 *
 * Wait (bounded) for each target connector's boot gate before firing anything.
 * `svc.connect()` only waits for the WebSocket to open, not for
 * `BootNotification.conf` — a scenario with no leading delay before its first
 * transaction node (e.g. cert16-tc005-ev-side-disconnect) can otherwise send
 * `StartTransaction` while the gate is still closed. The gate silently drops
 * gated outgoing CALLs sent before Accepted (see `OCPPMessageHandler
 * .sendRequest`'s `isCallAllowed` check), so the scenario would proceed with a
 * locally fabricated transactionId the CSMS never sees. See
 * `waitForBootAccepted()` for the full rationale and the timeout policy (30s
 * bound, warn-and-proceed).
 *
 * A scenario whose trigger matches has already been started by the boot gate's
 * own auto-start by the time this runs, so `startScenarioIfNotAlreadyActive`
 * is a no-op for it; a `manual`-triggered one is started only here, because
 * `tryAutoStartForConnector` deliberately skips those. Either way exactly one
 * run of the *installed* definition happens — which is the guarantee installing
 * before the dial buys, since whatever the gate auto-starts is now the
 * configured graph rather than a restored copy of the previous boot's (#314).
 */
export async function startStartupScenario(
  svc: CLIChargePointService,
  installed: readonly InstalledStartupScenario[],
): Promise<void> {
  if (installed.length === 0) return;
  const connectors = [...new Set(installed.map((one) => one.connectorId))];
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
  for (const { connectorId, scenarioId } of installed) {
    try {
      startScenarioIfNotAlreadyActive(svc, connectorId, scenarioId);
      process.stderr.write(
        `[server] Startup scenario started (id: ${scenarioId}, connector: ${connectorId})\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[server] Failed to start startup scenario "${scenarioId}" on connector ${connectorId}: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
    }
  }
}

/**
 * Install and then start, for callers that do both back to back.
 *
 * The daemon does **not** use this: it installs before the dial and starts
 * after, which is the ordering the split exists for. Kept because a caller with
 * nothing to interleave — a test, or any path where the charge point is already
 * connected — wants one call, and because the composition is the definition of
 * what the two halves add up to.
 */
export async function runStartupScenario(
  svc: CLIChargePointService,
  opt: NonNullable<ServerOptions["startupScenario"]>,
  connectorCount: number,
  fileReload: FileReloadManager | null = null,
  database: Database | null = null,
  source: StartupScenarioFile | null = readStartupScenarioFile(opt),
): Promise<void> {
  await startStartupScenario(
    svc,
    installStartupScenario(
      svc,
      opt,
      connectorCount,
      fileReload,
      database,
      source,
    ),
  );
}

/**
 * Which restored charge points must wait for the bootstrap loop to dial them.
 *
 * A charge point whose id a startup flag will claim has a restored copy of that
 * very scenario loaded, and it auto-starts the moment its boot gate opens.
 * Dialling it during the restore leaves the entire bootstrap loop — every other
 * charge point's connect, minutes against a slow CSMS — between that start and
 * the flag's load. Held back, the two happen one after the other in the same
 * iteration.
 *
 * Only when the bootstrap loop is actually going to dial (`--auto-connect`).
 * Without it nothing else would, and `runStartupScenario`'s
 * `waitForBootAccepted` would burn its full 30s timeout per connector on a
 * charge point that was deliberately left unconnected — the boot-accepted wait
 * broken by the very hold-back meant to protect it (#314).
 */
export function restoredDialsToDefer(
  restored: readonly string[],
  startupTargets: ReadonlySet<string>,
  autoConnect: boolean,
): Set<string> {
  if (!autoConnect) return new Set();
  return new Set(restored.filter((cpId) => startupTargets.has(cpId)));
}

/**
 * The first pass's row filter: hold back exactly the rows whose scenario id a
 * startup flag will overwrite on that charge point.
 *
 * Narrow on purpose, and the counterpart of {@link startupTargetCpIds}: widen
 * this to whole charge points and the *other* restored scenarios on them go
 * unwatched until they dial, which is the failure the first pass exists to
 * prevent. The two predicates answer different questions and neither one's
 * answer is safe for the other's job (#314).
 */
export function startupClaimedRowSkip(
  claimedByCp: ReadonlyMap<string, ReadonlySet<string>>,
): (row: { readonly cp_id: string; readonly scenario_id: string }) => boolean {
  return (row) => claimedByCp.get(row.cp_id)?.has(row.scenario_id) === true;
}

/**
 * Which charge points a startup flag is about to configure.
 *
 * Answers "is startup going to reconfigure this charge point?", which is a
 * different question from "which stored scenario ids will it overwrite?" — see
 * {@link startupClaimedScenarioIds} for that one. Every bootstrap charge point
 * is a target whenever any startup flag is set, because all three modes load a
 * definition onto every one of them; only the *ids* differ by mode, and ids are
 * irrelevant here.
 *
 * Keying the dial deferral on the id set instead let three of the four startup
 * modes through: `--scenario-template` and `--scenario-template-file` minted a
 * fresh id each boot and so claimed nothing, as did a `--scenario` that had to
 * be instantiated across connectors. Their restored charge points therefore
 * dialled immediately and their persisted `triggerOn: connect` scenarios
 * auto-started from the database, well before the configured definition
 * loaded (#314).
 *
 * Everything deferred here is dialled afterwards by the bootstrap loop, which
 * iterates exactly this fleet — see the mode table in `docs/entities/daemon.md`.
 */
export function startupTargetCpIds(
  startupScenario: ServerOptions["startupScenario"],
  fleet: readonly ChargePointInitOptions[],
): Set<string> {
  if (!isExplicitStartupScenario(startupScenario)) return new Set();
  return new Set(fleet.map((init) => init.cpId));
}

/** Whether any startup flag names something to load. */
export function isExplicitStartupScenario(
  startupScenario: ServerOptions["startupScenario"],
): boolean {
  return resolveStartupScenarioMode(startupScenario) !== null;
}

/**
 * Whether a `--scenario` definition already targets the connector it is being
 * loaded onto, and therefore keeps its own id instead of an instantiated one.
 *
 * Shared, not duplicated: `runStartupScenario` uses it to build the `prepare`
 * that runs on every reload, and the boot sequence uses it to work out which
 * persisted scenario ids the startup flags are about to claim. Those two
 * answers have to agree — a skip computed from a second copy of this rule would
 * drift from the load it is meant to predict (#314).
 */
export function scenarioFileTargetsConnector(
  definition: ScenarioDefinition,
  connectorId: number,
  connectorCount: number,
): boolean {
  return (
    connectorCount === 1 &&
    definition.targetType === "connector" &&
    definition.targetId === connectorId
  );
}

/**
 * Which startup scenario option this boot is running, as one value.
 *
 * The precedence question, asked in one place. Three functions used to derive
 * something from the same three flags and each spelled out its own rule:
 * {@link installStartupScenario} took `--scenario-template` first, then
 * `--scenario-template-file`, then `--scenario`; {@link readStartupScenarioFile}
 * read `scenarioTemplateFile ?? scenario`; {@link startupClaimedScenarioIds}
 * looked only at whether either file flag was set. Pass `--scenario-template`
 * *and* `--scenario` together and the third disagreed with the first: the load
 * installed the built-in template and claimed nothing, while the prediction
 * claimed the file's ids — so the first restore pass held rows back for
 * scenarios that were never going to be loaded, and they stayed unwatched until
 * the charge point dialled.
 *
 * The combination is now refused rather than ranked (see
 * {@link startupScenarioOptionConflict}), so there is no precedence left to
 * disagree about: at most one flag is set, and every caller reads the same
 * discriminated union to find out which. A rule spelled out once cannot drift;
 * spelled out three times it already had (#314).
 */
export type StartupScenarioMode =
  | { readonly kind: "template"; readonly templateId: string }
  | { readonly kind: "templateFile"; readonly path: string }
  | { readonly kind: "file"; readonly path: string };

/** The startup scenario flags, in the order a conflict message names them. */
const STARTUP_SCENARIO_FLAGS = [
  ["scenarioTemplate", "--scenario-template"],
  ["scenarioTemplateFile", "--scenario-template-file"],
  ["scenario", "--scenario"],
] as const;

/**
 * The message for a startup that names more than one scenario option, or
 * `null` when at most one is set.
 *
 * **Refused, not ranked.** Every ranking is a silent answer to a question the
 * operator asked ambiguously, and the three derivations above ranked them
 * differently. Refusing is the smaller invariant: no doc, example, compose file
 * or test in this repository passes two of these flags, so nothing that works
 * today stops working, and a combination that would have quietly ignored a flag
 * now names the flags it cannot reconcile (#314).
 *
 * Returned rather than thrown so the CLI can refuse at parse time — see
 * `src/cli/main.ts` — while {@link resolveStartupScenarioMode} throws for
 * programmatic callers that never went through it.
 */
export function startupScenarioOptionConflict(
  opt: ServerOptions["startupScenario"],
): string | null {
  if (!opt) return null;
  const given = STARTUP_SCENARIO_FLAGS.filter(([key]) => !!opt[key]).map(
    ([, flag]) => flag,
  );
  if (given.length < 2) return null;
  return `${given.join(", ")} cannot be combined - pass exactly one startup scenario option`;
}

/**
 * The one startup mode the flags name, or `null` when they name none.
 *
 * Throws on a conflicting combination. The daemon refuses it earlier and more
 * politely (the CLI at parse time, {@link startServer} before it opens the
 * database), so this throw is the backstop for a caller that built the options
 * object itself: silently picking one flag is the behaviour this function
 * exists to remove.
 */
export function resolveStartupScenarioMode(
  opt: ServerOptions["startupScenario"],
): StartupScenarioMode | null {
  const conflict = startupScenarioOptionConflict(opt);
  if (conflict) throw new Error(conflict);
  if (!opt) return null;
  if (opt.scenarioTemplate)
    return { kind: "template", templateId: opt.scenarioTemplate };
  if (opt.scenarioTemplateFile)
    return { kind: "templateFile", path: opt.scenarioTemplateFile };
  if (opt.scenario) return { kind: "file", path: opt.scenario };
  return null;
}

/**
 * The scenario file a startup flag names, read **once** for the whole boot.
 *
 * Both `--scenario` and `--scenario-template-file` used to be read twice: once
 * early, to work out which stored scenario ids the flags were about to claim,
 * and again per charge point inside the bootstrap loop, to load. Those are two
 * different points in time with the whole restored fleet's connect between
 * them — minutes against a slow CSMS — so an edit landing in the window made
 * the prediction describe a file that was no longer being loaded: the first
 * restore pass held back a row under the old id while the bootstrap loaded and
 * deleted a different one, and the second pass then reattached the held row and
 * reloaded the current file under an abandoned id. Two live copies out of one
 * flag (#314).
 *
 * One read settles it. The claim is derived from the same bytes that are
 * loaded, so the two cannot disagree — and an edit that lands mid-boot is not
 * lost either: `registerScenarioFile` reconciles the registration against disk
 * immediately, so `--watch` applies it the moment the watch goes on.
 *
 * `null` when no file flag is set, or when the file cannot be read or parsed —
 * `runStartupScenario` reports that properly a moment later, and claiming
 * nothing is the safe answer, since every row is then restored in the first
 * pass exactly as with no flag at all.
 */
export interface StartupScenarioFile {
  readonly path: string;
  /**
   * `null` when the file could not be read or parsed — `error` says why, and
   * carrying the failure rather than collapsing it to a bare `null` is what
   * keeps `runStartupScenario`'s diagnostic as specific as it was when it did
   * its own read.
   */
  readonly text: string | null;
  readonly definition: ScenarioDefinition | null;
  readonly error: unknown;
}

export function readStartupScenarioFile(
  opt: ServerOptions["startupScenario"],
): StartupScenarioFile | null {
  const mode = resolveStartupScenarioMode(opt);
  if (!mode || mode.kind === "template") return null;
  const filePath = mode.path;
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return {
      path: filePath,
      text,
      definition: JSON.parse(text) as ScenarioDefinition,
      error: null,
    };
  } catch (err) {
    return { path: filePath, text: null, definition: null, error: err };
  }
}

/**
 * The exact (connector, scenario id) pairs the startup flags will install on a
 * charge point with `connectorCount` connectors — or `null` when this boot
 * cannot tell.
 *
 * **Exact, not narrow.** Every startup-generated id is now stable —
 * {@link scenarioInstanceId}, derived from the file's or template's own id and
 * the connector — so every id the boot will load is knowable before it loads
 * anything, and this returns exactly that set. Two readers depend on it:
 *
 * - the watch restore's first pass skips these ids (through
 *   {@link startupClaimedScenarioIds}) and nothing else, or a charge point's
 *   *other* restored scenarios go unwatched until it dials (#314);
 * - {@link pruneStaleStartupScenarios} keeps these rows and removes every
 *   other startup-generated row, before anything dials (#338).
 *
 * **`null` is not empty.** An unreadable or unparsable file, a file without a
 * string `id`, or an unknown built-in template means the boot does not know
 * what its configuration calls for. The prune then removes nothing on the
 * charge points that configuration targets: the previous boot's instance stays
 * rather than an unreadable file wiping the scenario it configured last time.
 * No flag at all is the empty list: nothing is called for, so every
 * startup-generated row goes.
 *
 * Takes the boot's single read rather than opening the file itself: a
 * prediction with its own read is a prediction of a file that may not be the
 * one loaded, which is the bug this signature exists to make unrepresentable.
 */
export function startupClaimedInstances(
  opt: ServerOptions["startupScenario"],
  connectorCount: number,
  source: StartupScenarioFile | null,
): InstalledStartupScenario[] | null {
  // Resolved first, ahead of the `source` check, so a conflicting combination
  // is refused here too rather than answered with a set that happens to look
  // harmless. Asked through the same resolver the load reads, so the
  // prediction and the load cannot disagree about which flag is in effect.
  const mode = resolveStartupScenarioMode(opt);
  // A mode implies options, but only to a reader: narrowed for the compiler.
  if (!mode || !opt) return [];
  const connectors = resolveConnectorIds(opt.scenarioConnector, connectorCount);
  if (mode.kind === "template") {
    if (!getTemplateById(mode.templateId)) return null;
    // `loadScenarioTemplate` derives its id through the same function.
    return connectors.map((connectorId) => ({
      connectorId,
      scenarioId: scenarioInstanceId(mode.templateId, connectorId),
    }));
  }
  const definition = source?.definition;
  if (!definition || source.text === null) return null;
  const baseId = definition.id;
  if (typeof baseId !== "string") return null;
  // The same branch `installStartupScenario` takes, through the same
  // predicate — a second copy of the rule would drift from the load it
  // predicts. A template file always instantiates; a `--scenario` keeps its own
  // id only when it already targets its single connector.
  return connectors.map((connectorId) => ({
    connectorId,
    scenarioId:
      mode.kind === "file" &&
      scenarioFileTargetsConnector(definition, connectorId, connectors.length)
        ? baseId
        : scenarioInstanceId(baseId, connectorId),
  }));
}

/**
 * The persisted scenario ids the startup flags will claim on this boot: the
 * ids of {@link startupClaimedInstances}, and nothing when that is unknown.
 */
export function startupClaimedScenarioIds(
  opt: ServerOptions["startupScenario"],
  connectorCount: number,
  source: StartupScenarioFile | null,
): Set<string> {
  return new Set(
    (startupClaimedInstances(opt, connectorCount, source) ?? []).map(
      (one) => one.scenarioId,
    ),
  );
}

/**
 * What a startup flag records as the provenance of the rows it installs
 * (`scenarios.startup_source`, #338): the flag and its source — the resolved
 * file path, or the built-in template id. Informational: the prune only asks
 * whether a row has one.
 */
export function startupProvenance(mode: StartupScenarioMode): string {
  switch (mode.kind) {
    case "template":
      return `--scenario-template=${mode.templateId}`;
    case "templateFile":
      return `--scenario-template-file=${path.resolve(mode.path)}`;
    case "file":
      return `--scenario=${path.resolve(mode.path)}`;
  }
}

/**
 * **The** startup prune (#338): remove every startup-generated row on this
 * charge point that the boot's flags do not call for.
 *
 * A row is startup-generated when `scenarios.startup_source` is set; a NULL row
 * is user-authored and never touched. What the flags call for is
 * `claims.get(cpId)`, the exact set {@link startupClaimedInstances} predicts
 * and {@link installStartupScenario} then loads: a charge point the flags do
 * not configure (no flag, or not in the bootstrap fleet) keeps nothing marked,
 * and one whose claim is `null` (the boot cannot tell) is left as it is.
 *
 * A `legacy:<base>` row — a clock-suffixed id an older build generated, marked
 * by the v19 migration — is called for until the flags call for its stable
 * successor instead: it goes when this boot installs `<base>-c<connector>` or
 * `<base>` on the same connector, which is when the builds that minted it
 * removed it. One nothing replaces (a seeded default, a template loaded over
 * the control plane) stays, as it did.
 *
 * This one rule covers every way a previous boot's copy can outlive its
 * configuration: a `--scenario-connector` that no longer names a connector, a
 * file whose own `id` changed, a switched or dropped flag, a charge point that
 * left the fleet, and an older build's clock-suffixed copy of what this boot
 * installs. It replaces the two narrower prunes that preceded it — the
 * `-<epoch ms>` suffix match for `--scenario` and `loadScenarioTemplate`'s
 * per-template cleanup.
 *
 * **Ordering**: at restore, before the watch restore and before the charge
 * point dials, so a stale copy is never watched and never reaches the boot
 * gate's auto-start. **Destruction**: `removeScenario` discards any run and
 * deletes the row; a row whose id memory holds on another connector is
 * deleted directly. Its watch row goes too. **Failure**: a removal that throws
 * is reported and the next row is still processed.
 */
export function pruneStaleStartupScenarios(
  svc: CLIChargePointService,
  database: Database | null,
  claims: ReadonlyMap<string, readonly InstalledStartupScenario[] | null>,
): void {
  const cpId = svc.getInit().cpId;
  const claimed = claims.has(cpId) ? claims.get(cpId) : [];
  if (claimed === null || claimed === undefined) return;
  const keep = new Set(
    claimed.map((one) => `${one.connectorId}\u0000${one.scenarioId}`),
  );
  for (const row of listStartupScenarioRows(database, cpId)) {
    if (keep.has(`${row.connector_id}\u0000${row.scenario_id}`)) continue;
    if (row.startup_source.startsWith(LEGACY_STARTUP_SOURCE_PREFIX)) {
      const base = row.startup_source.slice(
        LEGACY_STARTUP_SOURCE_PREFIX.length,
      );
      const replaced = [base, scenarioInstanceId(base, row.connector_id)].some(
        (id) => keep.has(`${row.connector_id}\u0000${id}`),
      );
      if (!replaced) continue;
    }
    try {
      if (!svc.removeScenario(row.connector_id, row.scenario_id)) {
        deleteScenarioRow(database, cpId, row.connector_id, row.scenario_id);
      }
      forgetWatchedScenarioFile(
        database,
        cpId,
        row.connector_id,
        row.scenario_id,
      );
      process.stderr.write(
        `[server] Removed startup scenario "${row.scenario_id}" on ${cpId} connector ${row.connector_id}: generated by ${row.startup_source}; this boot does not call for it (#338)\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[server] Failed to remove stale startup scenario "${row.scenario_id}" on ${cpId} connector ${row.connector_id}: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
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
    id: scenarioInstanceId(cloned.id, connectorId),
    name: cloned.name
      ? `${cloned.name} (Connector ${connectorId})`
      : `Connector ${connectorId}`,
    targetType: "connector",
    targetId: connectorId,
  };
}

export { DEFAULT_HTTP_PORT } from "./constants";
export const DEFAULT_PID_PATH = "/tmp/ocpp-server.pid";
