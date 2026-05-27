#!/usr/bin/env bun
import type { CLIOptions, ChargePointInitOptions } from "./types";
import { CLIChargePointService } from "./service";
import { startRepl } from "./repl";
import { startJsonMode } from "./jsonMode";
import {
  startServer,
  DEFAULT_UNIX_SOCKET,
  DEFAULT_PID_PATH,
} from "./server/startServer";
import { sendCommand, subscribeEvents, stopDaemon } from "./client";

function parseArgs(argv: string[]): CLIOptions {
  let wsUrl = "";
  let cpId: string | null = null;
  let connectors = 1;
  let jsonMode = false;
  let daemon = false;
  let send: string | null = null;
  let events = false;
  let stop = false;
  let basicAuthUser = "";
  let basicAuthPass = "";
  let vendor = "CLI-Vendor";
  let model = "CLI-Model";
  let scenario: string | null = null;
  let scenarioTemplate: string | null = null;
  let scenarioTemplateFile: string | null = null;
  let scenarioConnector = "1";
  let httpPort: number | null = null;
  let httpHost = "127.0.0.1";
  let unixSocket: string | null = null;
  let unixSocketExplicit = false;
  let httpUrl: string | null = null;
  let allEvents = false;
  const corsOrigins: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "--ws-url":
        wsUrl = next ?? "";
        i++;
        break;
      case "--cp-id":
        cpId = next ?? "";
        i++;
        break;
      case "--connectors":
        connectors = parseInt(next ?? "1", 10);
        i++;
        break;
      case "--json":
        jsonMode = true;
        break;
      case "--daemon":
        daemon = true;
        break;
      case "--send":
        send = next ?? "";
        i++;
        break;
      case "--events":
        events = true;
        break;
      case "--stop":
        stop = true;
        break;
      case "--basic-auth-user":
        basicAuthUser = next ?? "";
        i++;
        break;
      case "--basic-auth-pass":
        basicAuthPass = next ?? "";
        i++;
        break;
      case "--vendor":
        vendor = next ?? "";
        i++;
        break;
      case "--model":
        model = next ?? "";
        i++;
        break;
      case "--scenario":
        scenario = next ?? "";
        i++;
        break;
      case "--scenario-template":
        scenarioTemplate = next ?? "";
        i++;
        break;
      case "--scenario-template-file":
        scenarioTemplateFile = next ?? "";
        i++;
        break;
      case "--scenario-connector":
        scenarioConnector = next ?? "1";
        i++;
        break;
      case "--http-port":
        httpPort = parseInt(next ?? "", 10);
        i++;
        break;
      case "--http-host":
        httpHost = next ?? "";
        i++;
        break;
      case "--unix-socket":
        unixSocketExplicit = true;
        unixSocket = next === "none" ? null : (next ?? "");
        i++;
        break;
      case "--http-url":
        httpUrl = next ?? "";
        i++;
        break;
      case "--all":
        allEvents = true;
        break;
      case "--cors-origin":
        if (!next || next.startsWith("--")) {
          process.stderr.write(
            "Error: --cors-origin requires a value (refusing to fall back to open CORS)\n",
          );
          process.exit(1);
        }
        corsOrigins.push(next);
        i++;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          process.stderr.write(`Unknown option: ${arg}\n`);
          printUsage();
          process.exit(1);
        }
    }
  }

  const isClientMode = send !== null || events || stop;
  const isServerMode = daemon || httpPort != null;

  if (isClientMode) {
    if ((send !== null || events) && !cpId && !allEvents) {
      process.stderr.write(
        "Error: --cp-id is required (or --all for --events)\n",
      );
      printUsage();
      process.exit(1);
    }
  } else if (!isServerMode) {
    // REPL / JSON mode requires a single bootstrapped CP
    if (!cpId) {
      process.stderr.write("Error: --cp-id is required\n");
      printUsage();
      process.exit(1);
    }
    if (!wsUrl) {
      process.stderr.write("Error: --ws-url is required\n");
      printUsage();
      process.exit(1);
    }
  } else {
    // Server mode: cpId is bootstrap-only. If given, ws-url is also required.
    if (cpId && !wsUrl) {
      process.stderr.write(
        "Error: --ws-url is required when bootstrapping a CP with --cp-id\n",
      );
      printUsage();
      process.exit(1);
    }
  }

  if (isNaN(connectors) || connectors < 1) {
    process.stderr.write("Error: --connectors must be a positive integer\n");
    process.exit(1);
  }

  if (httpPort != null && (isNaN(httpPort) || httpPort < 1)) {
    process.stderr.write("Error: --http-port must be a positive integer\n");
    process.exit(1);
  }

  // Server defaults for unixSocket:
  //  - daemon mode: enabled by default at DEFAULT_UNIX_SOCKET
  //  - foreground server mode (--http-port without --daemon): opt-in only
  if (isServerMode && !unixSocketExplicit) {
    unixSocket = daemon ? DEFAULT_UNIX_SOCKET : null;
  }

  const basicAuth =
    basicAuthUser && basicAuthPass
      ? { username: basicAuthUser, password: basicAuthPass }
      : null;

  return {
    wsUrl,
    cpId,
    connectors,
    jsonMode,
    daemon,
    send,
    events,
    stop,
    basicAuth,
    vendor,
    model,
    scenario,
    scenarioTemplate,
    scenarioTemplateFile,
    scenarioConnector,
    httpPort,
    httpHost,
    unixSocket,
    httpUrl,
    allEvents,
    corsOrigins,
  };
}

function printUsage(): void {
  process.stderr.write(`
Usage: cp-sim [options]    (or "bun src/cli/main.ts [options]" from a checkout)

Local modes (single CP, no server):
  --cp-id <id> --ws-url <url>                Interactive REPL (default)
  --cp-id <id> --ws-url <url> --json         JSON Lines mode

Server modes (HTTP/WebSocket, multi-CP):
  --daemon [--cp-id X --ws-url Y]                  Background server (Unix socket default ON)
  --daemon --http-port P [--cp-id ...]             Background server + TCP HTTP
  --http-port P [--cp-id ...]                      Foreground HTTP server (TCP only)
  --http-port P --unix-socket /path                Foreground HTTP + Unix socket
  --daemon --unix-socket none --http-port P        Background TCP-only daemon

Client modes (talk to a running server):
  --send <json> --cp-id <id> [target]        Send command to a CP
  --events --cp-id <id> [target]             Subscribe per-CP events (TCP only)
  --events --all [target]                    Subscribe all-CP events (TCP only)
  --stop [target]                            Shut down the server

  [target] = --http-url http://host:port  (TCP)
           | --unix-socket /path           (Unix HTTP, default ${DEFAULT_UNIX_SOCKET})

Options:
  --cp-id <id>             Charge Point ID
  --ws-url <url>           WebSocket URL of CSMS
  --connectors <n>         Number of connectors (default: 1)
  --basic-auth-user <u>    Basic auth username
  --basic-auth-pass <p>    Basic auth password
  --vendor <vendor>        Charge point vendor (default: CLI-Vendor)
  --model <model>          Charge point model (default: CLI-Model)
  --scenario <file>            Run scenario from JSON file on startup
  --scenario-template <id>     Run built-in scenario template on startup
  --scenario-template-file <p> Load a cpId-independent template JSON and apply it
                               to every connector listed in --scenario-connector
  --scenario-connector <list>  Target connectors: "all", a single id ("1"),
                               or a comma-separated list ("1,2,3"). Default: 1
  --http-port <port>       Enable HTTP/WebSocket server on this TCP port
  --http-host <addr>       Bind address for HTTP (default: 127.0.0.1)
  --unix-socket <path|none> Unix socket path; "none" disables it
  --http-url <url>         Client target: TCP HTTP base URL
  --all                    Use the global event stream (--events only)
  --cors-origin <origin>   Restrict CORS to this origin (repeatable). Default: any origin (*)
  -h, --help               Show this help

HTTP API (see docs/server.md):
  GET    /healthz
  GET    /v1/cp
  POST   /v1/cp
  GET    /v1/cp/:cpId
  DELETE /v1/cp/:cpId
  POST   /v1/cp/:cpId/command
  WS     /v1/cp/:cpId/events
  WS     /v1/events
  POST   /v1/shutdown
`);
}

function buildBootstrap(options: CLIOptions): ChargePointInitOptions | null {
  if (!options.cpId) return null;
  return {
    cpId: options.cpId,
    wsUrl: options.wsUrl,
    connectors: options.connectors,
    vendor: options.vendor,
    model: options.model,
    basicAuth: options.basicAuth,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);

  const clientLoc = {
    httpUrl: options.httpUrl,
    unixSocket: options.unixSocket,
  };

  if (options.stop) {
    await stopDaemon(clientLoc);
    return;
  }

  if (options.send !== null) {
    if (!options.cpId) {
      process.stderr.write("Error: --cp-id is required for --send\n");
      process.exit(1);
    }
    await sendCommand(clientLoc, options.cpId, options.send);
    return;
  }

  if (options.events) {
    await subscribeEvents(clientLoc, options.allEvents ? null : options.cpId);
    return;
  }

  const isServerMode = options.daemon || options.httpPort != null;

  if (isServerMode) {
    await startServer({
      httpPort: options.httpPort,
      httpHost: options.httpHost,
      unixSocket: options.unixSocket,
      pidPath: options.daemon ? DEFAULT_PID_PATH : null,
      bootstrap: buildBootstrap(options),
      autoConnect: !!options.cpId,
      startupScenario: options.cpId
        ? {
            scenario: options.scenario,
            scenarioTemplate: options.scenarioTemplate,
            scenarioTemplateFile: options.scenarioTemplateFile,
            scenarioConnector: options.scenarioConnector,
          }
        : null,
      cors:
        options.corsOrigins.length === 0
          ? { kind: "any" }
          : { kind: "allowlist", origins: options.corsOrigins },
    });
    return;
  }

  const service = CLIChargePointService.fromOptions(options);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    service.cleanup();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (!options.jsonMode) {
    process.stdout.write(
      `OCPP CP Simulator CLI - ${options.cpId} (${options.connectors} connector(s))\n`,
    );
    process.stdout.write(`Target: ${options.wsUrl}\n`);
    process.stdout.write('Type "help" for available commands.\n\n');
  }

  if (options.jsonMode) {
    await startJsonMode(service);
  } else {
    await startRepl(service);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
