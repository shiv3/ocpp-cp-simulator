import { runtime, type RuntimeServer } from "../runtime";

type AnyServer = RuntimeServer;
import type { ChargePointInitOptions } from "../types";
import { BehaviorLibrary } from "../behavior/BehaviorLibrary";
import { CPRegistry } from "./CPRegistry";
import { NetworkSimManager } from "./NetworkSimManager";
import { EventBus } from "./eventBus";
import { createLifecycle } from "./lifecycle";
import { createHttpHandlers, createSoapCallbackHandlers } from "./httpServer";
import {
  attachSocketIo,
  createSocketConfigRepository,
  createRuntimeDeps,
  isSocketIoPath,
} from "./socketServer";
import { createMcpHandler } from "./mcp/mcpServer";
import { RegistryChargePointService } from "./RegistryChargePointService";
import { openSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/openSqliteDatabase";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { SqliteConnectorSettingsRepository } from "@ocpp-cp-simulator/client/sqlite/SqliteConnectorSettingsRepository";
import {
  createAccessGuard,
  DEFAULT_RATE_LIMIT_MAX_IPS,
  isAccessGuardActive,
} from "./accessGuard";
import type { ServerOptions, RunningServer } from "./serverOptions";
import {
  expandBootstrap,
  expandExplicitSoapCallbackUrl,
  finishWatchSetup,
  labelsNotAppliedNote,
  openSoapTunnel,
  serverLog,
} from "./startServerHelpers";
import { stopTransactionsAndWait } from "./gracefulShutdown";
import { soapTunnelStartupLines, type SoapTunnel } from "../soapTunnel";
import { buildServerInfo } from "./socketServer";
import {
  MetricsRecorder,
  setGlobalMetricsRecorder,
} from "./metrics/MetricsRecorder";
import { renderMetrics } from "./metrics/render";
import { VehicleProfileRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/VehicleProfileRepository";
import { OpenEvDirectoryClient } from "@ocpp-cp-simulator/core/cp/infrastructure/vehicle-catalog/open-ev-directory/OpenEvDirectoryClient";
import { FleetTemplateRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/FleetTemplateRepository";
import { BlueprintRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BlueprintRepository";
import { FileReloadManager } from "./FileReloadManager";
import {
  installStartupScenario,
  isExplicitStartupScenario,
  pruneStaleStartupScenarios,
  readStartupScenarioFile,
  restoredDialsToDefer,
  startStartupScenario,
  startupClaimedInstances,
  startupClaimedRowSkip,
  startupScenarioOptionConflict,
  startupTargetCpIds,
} from "./startupScenario";
import { DEFAULT_BOOTSTRAP_PACING, forEachPaced } from "./bootstrapPacing";

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
  const behaviorCount =
    inputOpts.behaviors instanceof BehaviorLibrary
      ? inputOpts.behaviors.size
      : (inputOpts.behaviors?.length ?? 0);
  if (behaviorCount > 0 && !inputOpts.allowBehaviorCode) {
    throw new Error(
      "Behavior code is loaded only with allowBehaviorCode (--allow-behavior-code)",
    );
  }

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
    ? await runtime.serve({
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
    database = await openSqliteDatabase(opts.stateDb);
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
  // #445: the same for fleet templates; `--fleet-template` files are held by
  // the repository, read-only.
  const fleetTemplates = new FleetTemplateRepository(
    database,
    opts.fleetTemplates ?? [],
  );
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
      behaviors: opts.behaviors ?? [],
    },
    connectorSettingsRepository,
  );
  // --watch-behaviors: the registry's library re-reads the files given at
  // start when one changes; the registry applies the new version to every
  // charge point running it.
  registry.library.rpcReloadAllowed =
    opts.allowBehaviorReload === true || opts.watchBehaviors === true;
  const stopBehaviorWatch =
    opts.watchBehaviors && registry.library.size > 0
      ? registry.library.watch()
      : () => undefined;
  // Create network simulation manager and wire it to the registry BEFORE
  // restoring CPs so they get their config attached before connect().
  const networkSimManager = new NetworkSimManager(database, {
    listLiveWsCpIds: () => registry.liveWsCpIds(),
    applyToCp: (cpId, resolved) => {
      registry.get(cpId)?.setNetworkSimConfig(resolved);
    },
    listCpIds: () => [...registry.list()],
    applyCellularPolicies: (cpId, policies) => {
      registry.get(cpId)?.setCellularPolicies(policies);
    },
    getCellularLink: (cpId) => registry.get(cpId)?.modemState()?.link ?? null,
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
    stopTransactionsWaitMs: opts.shutdownWaitMs,
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
  // #622 `--no-connect-restored`: the fleet comes back as it was stored and
  // stays offline until `cp.connect` / `cp.bulk` says otherwise. A charge point
  // `--cp-id` names is still dialled by the bootstrap loop below.
  if (opts.connectRestored === false) {
    if (restored.length > 0) {
      serverLog(
        `--no-connect-restored: ${restored.length} restored CP(s) stay disconnected`,
      );
    }
  } else {
    registry.connectRestored(restored.filter((cpId) => !dialLater.has(cpId)));
  }
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
    fleetTemplates,
    vehicleProfiles,
    vehicleCatalog,
    chargePointService,
    fileReload,
    webConsoleBasicAuth: opts.webConsoleBasicAuth,
    cpBulkWaitMs: opts.cpBulkWaitMs,
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
    beforeShutdown: opts.shutdownStopTransactions
      ? async (skip) => {
          await stopTransactionsAndWait(
            registry,
            opts.shutdownStopTransactions?.waitMs ?? 0,
            serverLog,
            skip,
          );
        }
      : undefined,
    onShutdownStart: () => {
      stopBehaviorWatch();
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
    fleetTemplates,
    vehicleProfiles,
    vehicleCatalog,
    chargePointService,
    fileReload,
    cpBulkWaitMs: opts.cpBulkWaitMs,
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

  const accessGuard =
    opts.access && isAccessGuardActive(opts.access)
      ? createAccessGuard({ ...opts.access, healthPath: opts.healthPath })
      : null;
  if (accessGuard) {
    serverLog(
      "Access guard: " +
        [
          (opts.access?.allowedHosts?.length ?? 0) > 0 &&
            `allowed hosts ${opts.access?.allowedHosts?.join(", ")}`,
          accessGuard.restrictsForwardedHeaders &&
            `trusted proxies ${opts.access?.trustedProxies?.join(", ")}`,
          opts.access?.requireTls && "TLS required for non-loopback clients",
          (opts.access?.rateLimitPerIp ?? 0) > 0 &&
            `${opts.access?.rateLimitPerIp} req/s per IP (max ${opts.access?.rateLimitMaxIps ?? DEFAULT_RATE_LIMIT_MAX_IPS} IPs tracked)`,
        ]
          .filter(Boolean)
          .join("; "),
    );
  }
  const apiHandlers = createHttpHandlers({
    accessGuard,
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
        accessGuard,
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
    const httpServer = await runtime.serve({
      port: opts.httpPort,
      hostname: opts.httpHost,
      fetch: handlers.fetch,
      socketIo: socketIo.engine,
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
    const consoleServer = await runtime.serve({
      port: opts.webConsolePort,
      hostname: opts.httpHost,
      fetch: consoleHandlers.fetch,
      socketIo: socketIo.engine,
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
  // The daemon is now SERVING. The listeners are bound above, so socket.io and
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
      // `--use-behavior` names the selection of this run: it replaces the
      // stored one, the way `cp.behaviors.set` would.
      const wanted = init.behaviors;
      if (
        wanted &&
        JSON.stringify([...wanted].sort()) !==
          JSON.stringify([...existing.behaviorIds()].sort())
      ) {
        try {
          registry.setBehaviors(init.cpId, wanted);
          serverLog(
            `CP "${init.cpId}": --use-behavior ${wanted.join(", ")} replaces its stored behavior selection`,
          );
        } catch (error) {
          serverLog(
            `CP "${init.cpId}" keeps its behaviors; --use-behavior ${wanted.join(", ")} was not applied: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
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
      stopBehaviorWatch();
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
  const pacing = opts.bootstrapPacing ?? DEFAULT_BOOTSTRAP_PACING;
  if (opts.bootstrapPacing) {
    serverLog(
      `Startup pacing: ${pacing.concurrency} at a time, ${pacing.startDelayMs} ms between starts, ` +
        `jitter 0-${pacing.startJitterMs} ms (seed ${pacing.startSeed}) (#610)`,
    );
  }
  await forEachPaced(started, pacing, async ({ svc, init }) => {
    // The service captured at registration may be gone by now: the item waited
    // for a concurrency slot and, with `--start-delay`, for its scheduled
    // offset (minutes, not milliseconds). A `cp.delete` has already torn it
    // down, and a `cp.update` registered a replacement under the same id, so
    // dialling this one would connect a charge point nobody owns or leave two
    // connections for one cpId (#610).
    if (registry.get(init.cpId) !== svc) {
      serverLog(
        `Skipping startup of ${init.cpId}: it was deleted or replaced before its turn`,
      );
      return;
    }
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
  });

  finishWatchSetup(fileReload, serverLog);
  return running;
}

export type { ServerOptions, RunningServer } from "./serverOptions";
export { expandExplicitSoapCallbackUrl, openSoapTunnel };
export { DEFAULT_HTTP_PORT } from "./constants";
export const DEFAULT_PID_PATH = "/tmp/ocpp-server.pid";

export {
  installStartupScenario,
  isExplicitStartupScenario,
  pruneStaleStartupScenarios,
  readStartupScenarioFile,
  resolveStartupScenarioMode,
  restoredDialsToDefer,
  runStartupScenario,
  scenarioFileTargetsConnector,
  startStartupScenario,
  startupClaimedInstances,
  startupClaimedRowSkip,
  startupClaimedScenarioIds,
  startupProvenance,
  startupScenarioOptionConflict,
  startupTargetCpIds,
  type InstalledStartupScenario,
  type StartupScenarioFile,
  type StartupScenarioMode,
} from "./startupScenario";
