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
    readonly scenarioConnector: number;
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
      runStartupScenario(svc, opts.startupScenario);
    }
  }
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
): void {
  const connectorId = opt.scenarioConnector;

  if (opt.scenarioTemplate) {
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
        `[server] Failed to start scenario template: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
    }
    return;
  }

  if (opt.scenario) {
    try {
      const content = fs.readFileSync(opt.scenario, "utf-8");
      const definition = JSON.parse(content) as ScenarioDefinition;
      const scenarioId = svc.loadScenario(connectorId, definition);
      svc.runScenario(connectorId, scenarioId);
      process.stderr.write(
        `[server] Scenario file "${opt.scenario}" started (id: ${scenarioId}, connector: ${connectorId})\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[server] Failed to start scenario file: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
    }
  }
}

export const DEFAULT_UNIX_SOCKET = "/tmp/ocpp-server.sock";
export const DEFAULT_PID_PATH = "/tmp/ocpp-server.pid";
