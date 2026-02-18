import * as net from "net";
import * as fs from "fs";
import { CLIChargePointService } from "./service";
import { handleJsonCommand } from "./jsonMode";
import { toJsonResponse, toJsonEvent } from "./output";
import type { JsonCommand, CLIOptions } from "./types";
import type { ScenarioDefinition } from "../cp/application/scenario/ScenarioTypes";

function sanitizeCpId(cpId: string): string {
  return cpId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getSocketPath(cpId: string): string {
  return `/tmp/ocpp-${sanitizeCpId(cpId)}.sock`;
}

function getPidPath(cpId: string): string {
  return `/tmp/ocpp-${sanitizeCpId(cpId)}.pid`;
}

function getLogPath(cpId: string): string {
  return `/tmp/ocpp-${sanitizeCpId(cpId)}.jsonl`;
}

export async function startDaemon(
  service: CLIChargePointService,
  cpId: string,
  options?: CLIOptions,
): Promise<void> {
  const socketPath = getSocketPath(cpId);
  const pidPath = getPidPath(cpId);
  const logPath = getLogPath(cpId);

  removeStaleSocket(socketPath, pidPath);

  fs.writeFileSync(pidPath, String(process.pid), "utf-8");

  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const subscribers = new Set<net.Socket>();

  service.onEvent((evt) => {
    if (evt.event === "log") return;
    const jsonLine = JSON.stringify(toJsonEvent(evt.event, evt.data));
    logStream.write(`${jsonLine}\n`);
    for (const sock of subscribers) {
      try {
        sock.write(`${jsonLine}\n`);
      } catch {
        subscribers.delete(sock);
      }
    }
  });

  process.stderr.write(`[daemon] Connecting to CSMS...\n`);
  try {
    await service.connect();
    process.stderr.write(`[daemon] Connected.\n`);
  } catch (err) {
    process.stderr.write(
      `[daemon] Connection failed: ${err instanceof Error ? err.message : err}\n`,
    );
  }

  if (options) {
    runStartupScenario(service, options);
  }

  const server = net.createServer((conn) => {
    let buffer = "";
    let handled = false;

    const processLine = (line: string) => {
      if (handled) return;
      handled = true;

      const trimmed = line.trim();
      if (!trimmed) {
        conn.end(
          JSON.stringify(toJsonResponse(null, false, "Empty request")) + "\n",
        );
        return;
      }

      let parsed: JsonCommand;
      try {
        parsed = JSON.parse(trimmed) as JsonCommand;
      } catch {
        conn.end(
          JSON.stringify(toJsonResponse(null, false, "Invalid JSON")) + "\n",
        );
        return;
      }

      const id = parsed.id ?? null;

      if (parsed.command === "subscribe") {
        subscribers.add(conn);
        conn.on("close", () => subscribers.delete(conn));
        return;
      }

      if (parsed.command === "shutdown") {
        conn.end(
          JSON.stringify(
            toJsonResponse(id, true, { message: "shutting down" }),
          ) + "\n",
        );
        requestShutdown(
          server,
          service,
          subscribers,
          logStream,
          socketPath,
          pidPath,
        );
        return;
      }

      handleJsonCommand(service, parsed)
        .then((result) => {
          conn.end(JSON.stringify(toJsonResponse(id, true, result)) + "\n");
        })
        .catch((err) => {
          conn.end(
            JSON.stringify(
              toJsonResponse(
                id,
                false,
                err instanceof Error ? err.message : String(err),
              ),
            ) + "\n",
          );
        });
    };

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx);
      processLine(line);
    });

    conn.on("end", () => {
      if (!handled && buffer.trim()) {
        processLine(buffer);
      }
    });

    conn.on("error", () => {
      subscribers.delete(conn);
    });
  });

  server.listen(socketPath, () => {
    process.stderr.write(`[daemon] Listening on ${socketPath}\n`);
    process.stderr.write(`[daemon] PID: ${process.pid}\n`);
  });

  const onSignal = () => {
    requestShutdown(
      server,
      service,
      subscribers,
      logStream,
      socketPath,
      pidPath,
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

function removeStaleSocket(socketPath: string, pidPath: string): void {
  try {
    const pidStr = fs.readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        process.stderr.write(
          `Error: Another daemon is already running (PID ${pid})\n`,
        );
        process.exit(1);
      } catch {
        // Process not running, safe to clean up
      }
    }
  } catch {
    // No pid file, fine
  }

  try {
    fs.unlinkSync(socketPath);
  } catch {
    // does not exist, fine
  }
}

let shuttingDown = false;

function requestShutdown(
  server: net.Server,
  service: CLIChargePointService,
  subscribers: Set<net.Socket>,
  logStream: fs.WriteStream,
  socketPath: string,
  pidPath: string,
): void {
  if (shuttingDown) return;
  shuttingDown = true;

  process.stderr.write("[daemon] Shutting down...\n");

  for (const sock of subscribers) {
    try {
      sock.end();
    } catch {
      // ignore
    }
  }
  subscribers.clear();

  server.close();
  service.cleanup();
  logStream.end();

  try {
    fs.unlinkSync(socketPath);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(pidPath);
  } catch {
    // ignore
  }

  process.exit(0);
}

function runStartupScenario(
  service: CLIChargePointService,
  options: CLIOptions,
): void {
  const connectorId = options.scenarioConnector;

  if (options.scenarioTemplate) {
    try {
      const scenarioId = service.loadScenarioTemplate(
        options.scenarioTemplate,
        connectorId,
      );
      service.runScenario(connectorId, scenarioId);
      process.stderr.write(
        `[daemon] Scenario template "${options.scenarioTemplate}" started (id: ${scenarioId}, connector: ${connectorId})\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[daemon] Failed to start scenario template: ${err instanceof Error ? err.message : err}\n`,
      );
    }
    return;
  }

  if (options.scenario) {
    try {
      const content = fs.readFileSync(options.scenario, "utf-8");
      const definition = JSON.parse(content) as ScenarioDefinition;
      const scenarioId = service.loadScenario(connectorId, definition);
      service.runScenario(connectorId, scenarioId);
      process.stderr.write(
        `[daemon] Scenario file "${options.scenario}" started (id: ${scenarioId}, connector: ${connectorId})\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[daemon] Failed to start scenario file: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }
}

export { getSocketPath, getPidPath, getLogPath };
