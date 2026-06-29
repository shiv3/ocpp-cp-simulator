import * as fs from "fs";
import type { Server } from "bun";
import { CLIChargePointService } from "../service";

type AnyServer = Server<unknown>;
import type { ChargePointInitOptions } from "../types";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { CPRegistry } from "./CPRegistry";
import { EventBus } from "./eventBus";
import { createLifecycle } from "./lifecycle";
import { createHttpHandlers, type CorsPolicy } from "./httpServer";
import { attachSocketIo, isSocketIoPath } from "./socketServer";
import { BunSqliteDatabase } from "../../cp/domain/persistence/BunSqliteDatabase";
import type { Database } from "../../cp/domain/persistence/Database";
import { getGlobalLogFormat } from "../../cp/shared/Logger";

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

  const bus = new EventBus();
  const registry = new CPRegistry(bus, database);
  // Re-create CPs that were registered before the previous daemon shut
  // down. Has to happen BEFORE the CLI bootstrap (`opts.bootstrap`) so a
  // re-run with the same --cp-id is treated as "update wsUrl/connectors"
  // rather than "create + collide".
  const restored = await Promise.resolve(registry.restoreFromDatabase());
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
    webConsoleBasicAuth: opts.webConsoleBasicAuth,
    requestShutdown: () => {
      lifecycle?.requestShutdown();
    },
  });
  lifecycle = createLifecycle({
    pidPath: opts.pidPath,
    registry,
    onShutdownStart: () => {
      void socketIo.close();
    },
  });
  const socketIoRoute = {
    matches: isSocketIoPath,
    handleRequest: socketIo.handleRequest,
  };

  // Two listener configurations:
  //   * "api"  — health + socket.io, no static fallback.
  //   * "console" — health + socket.io + static files (UI); used by the
  //     --web-console port so the browser talks to the daemon at the same
  //     origin without CORS.
  const apiHandlers = createHttpHandlers({
    registry,
    bus,
    lifecycle,
    cors: opts.cors,
    database,
    healthPath: opts.healthPath,
    webConsoleBasicAuth: opts.webConsoleBasicAuth,
    socketIo: socketIoRoute,
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
      })
    : apiHandlers;
  if (opts.staticDir) {
    serverLog(`Web console: ${opts.staticDir}`);
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
  }

  if (servers.length === 0) {
    throw new Error("Server has no listener (httpPort required)");
  }

  lifecycle.installSignalHandlers();

  if (opts.bootstrap) {
    // The same cpId can already exist when --state-db restored it above.
    // Reuse the restored instance in that case — re-creating would throw
    // and we'd lose all of its persisted state. Skip the auto-seed for
    // bootstrap CPs that arrive together with an explicit startup
    // scenario; otherwise both would land on the connector and race for
    // the auto-start slot.
    const existing = registry.get(opts.bootstrap.cpId);
    const hasExplicitStartupScenario =
      !!opts.startupScenario &&
      (!!opts.startupScenario.scenario ||
        !!opts.startupScenario.scenarioTemplate ||
        !!opts.startupScenario.scenarioTemplateFile);
    const seedDefault = !hasExplicitStartupScenario;
    const svc = existing ?? registry.create(opts.bootstrap, { seedDefault });
    if (existing) {
      serverLog(
        `Bootstrap matches restored CP "${opts.bootstrap.cpId}"; reusing`,
      );
    } else {
      serverLog(`Bootstrapped CP "${opts.bootstrap.cpId}"`);
    }
    if (opts.autoConnect) {
      serverLog("Connecting to CSMS...");
      try {
        await svc.connect();
        serverLog("Connected.");
      } catch (err) {
        serverLog(
          `Connection failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (opts.startupScenario) {
      runStartupScenario(svc, opts.startupScenario, opts.bootstrap.connectors);
    }
  }
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

function runStartupScenario(
  svc: CLIChargePointService,
  opt: NonNullable<ServerOptions["startupScenario"]>,
  connectorCount: number,
): void {
  const connectors = resolveConnectorIds(opt.scenarioConnector, connectorCount);
  if (connectors.length === 0) {
    process.stderr.write(
      `[server] No matching connectors for --scenario-connector "${opt.scenarioConnector}"\n`,
    );
    return;
  }

  // 1) Built-in template by id — instantiate per connector.
  if (opt.scenarioTemplate) {
    for (const connectorId of connectors) {
      try {
        const scenarioId = svc.loadScenarioTemplate(
          opt.scenarioTemplate,
          connectorId,
        );
        svc.runScenario(connectorId, scenarioId);
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
    try {
      template = JSON.parse(
        fs.readFileSync(opt.scenarioTemplateFile, "utf-8"),
      ) as ScenarioDefinition;
    } catch (err) {
      process.stderr.write(
        `[server] Failed to read scenario template file: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
      return;
    }
    for (const connectorId of connectors) {
      try {
        const instance = instantiateTemplate(template, connectorId);
        const scenarioId = svc.loadScenario(connectorId, instance);
        svc.runScenario(connectorId, scenarioId);
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
    try {
      definition = JSON.parse(
        fs.readFileSync(opt.scenario, "utf-8"),
      ) as ScenarioDefinition;
    } catch (err) {
      process.stderr.write(
        `[server] Failed to read scenario file: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
      return;
    }
    for (const connectorId of connectors) {
      try {
        const instance =
          connectors.length === 1 && connectorId === definition.targetId
            ? definition
            : instantiateTemplate(definition, connectorId);
        const scenarioId = svc.loadScenario(connectorId, instance);
        svc.runScenario(connectorId, scenarioId);
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
