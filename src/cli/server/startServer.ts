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

export interface ServerOptions {
  readonly httpPort: number | null;
  readonly httpHost: string;
  readonly unixSocket: string | null;
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
}

export async function startServer(opts: ServerOptions): Promise<void> {
  if (opts.unixSocket) {
    removeStaleSocket(opts.unixSocket);
  }

  const bus = new EventBus();
  const registry = new CPRegistry(bus);
  const lifecycle = createLifecycle({
    pidPath: opts.pidPath,
    registry,
  });

  const handlers = createHttpHandlers({
    registry,
    bus,
    lifecycle,
    cors: opts.cors,
  });
  const servers: AnyServer[] = [];

  if (opts.unixSocket) {
    const unixServer = Bun.serve({
      unix: opts.unixSocket,
      fetch: handlers.fetch,
      websocket: handlers.websocket,
    });
    servers.push(unixServer);
    lifecycle.attachServer(unixServer);
    process.stderr.write(`[server] Listening on unix:${opts.unixSocket}\n`);
  }

  if (opts.httpPort != null) {
    const httpServer = Bun.serve({
      port: opts.httpPort,
      hostname: opts.httpHost,
      fetch: handlers.fetch,
      websocket: handlers.websocket,
    });
    servers.push(httpServer);
    lifecycle.attachServer(httpServer);
    process.stderr.write(
      `[server] Listening on http://${opts.httpHost}:${opts.httpPort}\n`,
    );
  }

  if (servers.length === 0) {
    throw new Error("Server has no listener (httpPort or unixSocket required)");
  }

  lifecycle.installSignalHandlers();

  if (opts.bootstrap) {
    const svc = registry.create(opts.bootstrap);
    process.stderr.write(`[server] Bootstrapped CP "${opts.bootstrap.cpId}"\n`);
    if (opts.autoConnect) {
      process.stderr.write(`[server] Connecting to CSMS...\n`);
      try {
        await svc.connect();
        process.stderr.write(`[server] Connected.\n`);
      } catch (err) {
        process.stderr.write(
          `[server] Connection failed: ${
            err instanceof Error ? err.message : err
          }\n`,
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

function removeStaleSocket(socketPath: string): void {
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // not present, fine
  }
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

export const DEFAULT_UNIX_SOCKET = "/tmp/ocpp-server.sock";
export const DEFAULT_PID_PATH = "/tmp/ocpp-server.pid";
