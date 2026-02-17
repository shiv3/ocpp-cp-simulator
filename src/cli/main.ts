import type { CLIOptions } from "./types";
import { CLIChargePointService } from "./service";
import { startRepl } from "./repl";
import { startJsonMode } from "./jsonMode";
import { startDaemon } from "./daemon";
import { sendCommand, subscribeEvents } from "./client";

function parseArgs(argv: string[]): CLIOptions {
  let wsUrl = "";
  let cpId = "";
  let connectors = 1;
  let jsonMode = false;
  let daemon = false;
  let send: string | null = null;
  let events = false;
  let basicAuthUser = "";
  let basicAuthPass = "";
  let vendor = "CLI-Vendor";
  let model = "CLI-Model";
  let scenario: string | null = null;
  let scenarioTemplate: string | null = null;
  let scenarioConnector = 1;

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
      case "--scenario-connector":
        scenarioConnector = parseInt(next ?? "1", 10);
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

  if (!cpId) {
    process.stderr.write("Error: --cp-id is required\n");
    printUsage();
    process.exit(1);
  }

  const isClientMode = send !== null || events;
  if (!isClientMode && !wsUrl) {
    process.stderr.write("Error: --ws-url is required\n");
    printUsage();
    process.exit(1);
  }

  if (isNaN(connectors) || connectors < 1) {
    process.stderr.write("Error: --connectors must be a positive integer\n");
    process.exit(1);
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
    basicAuth,
    vendor,
    model,
    scenario,
    scenarioTemplate,
    scenarioConnector,
  };
}

function printUsage(): void {
  process.stderr.write(`
Usage: bun src/cli/main.ts [options]

Required:
  --cp-id <id>             Charge Point ID

Connection (required for --daemon, --json, REPL):
  --ws-url <url>           WebSocket URL of CSMS (e.g. ws://localhost:9000/ocpp)

Modes:
  --json                   JSON Lines mode (stdin/stdout, for AI/automation)
  --daemon                 Start as daemon (auto-connect, listen on Unix socket)
  --send <json>            Send command to running daemon
  --events                 Subscribe to events from running daemon

Optional:
  --connectors <n>         Number of connectors (default: 1)
  --basic-auth-user <u>    Basic auth username
  --basic-auth-pass <p>    Basic auth password
  --vendor <vendor>        Charge point vendor (default: CLI-Vendor)
  --model <model>          Charge point model (default: CLI-Model)
  --scenario <file>        Run scenario from JSON file on startup (daemon mode)
  --scenario-template <id> Run built-in scenario template on startup (daemon mode)
  --scenario-connector <n> Connector for startup scenario (default: 1)
  -h, --help               Show this help

Examples:
  # Interactive REPL
  bun src/cli/main.ts --ws-url ws://localhost:9000/ocpp --cp-id CP001

  # JSON Lines mode
  bun src/cli/main.ts --ws-url ws://localhost:9000/ocpp --cp-id CP001 --json

  # Daemon mode
  bun src/cli/main.ts --ws-url ws://localhost:9000/ocpp --cp-id CP001 --daemon &

  # Send command to daemon
  bun src/cli/main.ts --cp-id CP001 --send '{"command":"status"}'

  # Subscribe to events
  bun src/cli/main.ts --cp-id CP001 --events

  # Shutdown daemon
  bun src/cli/main.ts --cp-id CP001 --send '{"command":"shutdown"}'
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);

  if (options.send !== null) {
    await sendCommand(options.cpId, options.send);
    return;
  }

  if (options.events) {
    await subscribeEvents(options.cpId);
    return;
  }

  const service = new CLIChargePointService(options);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    service.cleanup();
    process.exit(0);
  };

  if (options.daemon) {
    await startDaemon(service, options.cpId, options);
    return;
  }

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
