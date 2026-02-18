import * as readline from "readline";
import { CLIChargePointService } from "./service";
import { OCPPStatus } from "../cp/domain/types/OcppTypes";
import { formatStatus, formatEvent } from "./output";

const HELP_TEXT = `
Commands:
  connect                      Connect to CSMS (sends BootNotification)
  disconnect                   Disconnect from CSMS
  status                       Show charge point and connector status
  start <connector> <tagId>    Start transaction
  stop <connector>             Stop transaction
  meter <connector> <value>    Set meter value (Wh)
  send-meter <connector>       Send meter value to CSMS
  heartbeat                    Send heartbeat
  heartbeat start <seconds>    Start periodic heartbeat
  heartbeat stop               Stop periodic heartbeat
  authorize <tagId>            Send authorization request
  connector-status <c> <st>    Update connector status
  help                         Show this help
  exit                         Exit
`.trim();

const VALID_STATUSES = new Set(Object.values(OCPPStatus));

export async function startRepl(service: CLIChargePointService): Promise<void> {
  service.onEvent((evt) => {
    if (evt.event === "log") return;
    const line = formatEvent(evt.event, evt.data);
    process.stdout.write(`${line}\n`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "ocpp> ",
  });

  rl.prompt();

  rl.on("line", async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];

    try {
      await handleCommand(service, cmd, parts.slice(1));
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : err}\n`,
      );
    }

    rl.prompt();
  });

  rl.on("close", () => {
    service.cleanup();
    process.exit(0);
  });
}

async function handleCommand(
  service: CLIChargePointService,
  cmd: string,
  args: string[],
): Promise<void> {
  switch (cmd) {
    case "connect": {
      process.stdout.write("Connecting...\n");
      await service.connect();
      process.stdout.write("Connected.\n");
      break;
    }

    case "disconnect": {
      service.disconnect();
      process.stdout.write("Disconnected.\n");
      break;
    }

    case "status": {
      const status = service.getStatus();
      process.stdout.write(`${formatStatus(status)}\n`);
      break;
    }

    case "start": {
      const connectorId = parseConnectorId(args[0]);
      const tagId = args[1];
      if (!tagId) {
        process.stderr.write("Usage: start <connector> <tagId>\n");
        return;
      }
      service.startTransaction(connectorId, tagId);
      process.stdout.write(
        `Transaction start requested on connector ${connectorId}\n`,
      );
      break;
    }

    case "stop": {
      const connectorId = parseConnectorId(args[0]);
      service.stopTransaction(connectorId);
      process.stdout.write(
        `Transaction stop requested on connector ${connectorId}\n`,
      );
      break;
    }

    case "meter": {
      const connectorId = parseConnectorId(args[0]);
      const value = parseInt(args[1], 10);
      if (isNaN(value)) {
        process.stderr.write("Usage: meter <connector> <value>\n");
        return;
      }
      service.setMeterValue(connectorId, value);
      process.stdout.write(
        `Meter value set to ${value} Wh on connector ${connectorId}\n`,
      );
      break;
    }

    case "send-meter": {
      const connectorId = parseConnectorId(args[0]);
      service.sendMeterValue(connectorId);
      process.stdout.write(`Meter value sent for connector ${connectorId}\n`);
      break;
    }

    case "heartbeat": {
      if (args[0] === "start") {
        const seconds = parseInt(args[1], 10);
        if (isNaN(seconds) || seconds <= 0) {
          process.stderr.write("Usage: heartbeat start <seconds>\n");
          return;
        }
        service.startHeartbeat(seconds);
        process.stdout.write(
          `Periodic heartbeat started (every ${seconds}s)\n`,
        );
      } else if (args[0] === "stop") {
        service.stopHeartbeat();
        process.stdout.write("Periodic heartbeat stopped\n");
      } else {
        service.sendHeartbeat();
        process.stdout.write("Heartbeat sent\n");
      }
      break;
    }

    case "authorize": {
      const tagId = args[0];
      if (!tagId) {
        process.stderr.write("Usage: authorize <tagId>\n");
        return;
      }
      service.authorize(tagId);
      process.stdout.write(`Authorization requested for ${tagId}\n`);
      break;
    }

    case "connector-status": {
      const connectorId = parseConnectorId(args[0]);
      const status = args[1];
      if (!status || !VALID_STATUSES.has(status as OCPPStatus)) {
        process.stderr.write(
          `Usage: connector-status <connector> <status>\nValid statuses: ${[...VALID_STATUSES].join(", ")}\n`,
        );
        return;
      }
      service.updateConnectorStatus(connectorId, status as OCPPStatus);
      process.stdout.write(
        `Connector ${connectorId} status updated to ${status}\n`,
      );
      break;
    }

    case "help": {
      process.stdout.write(`${HELP_TEXT}\n`);
      break;
    }

    case "exit":
    case "quit": {
      service.cleanup();
      process.exit(0);
      break;
    }

    default: {
      process.stderr.write(
        `Unknown command: ${cmd}. Type "help" for available commands.\n`,
      );
    }
  }
}

function parseConnectorId(value: string | undefined): number {
  if (!value) {
    throw new Error("Connector ID is required");
  }
  const id = parseInt(value, 10);
  if (isNaN(id) || id < 1) {
    throw new Error(`Invalid connector ID: ${value}`);
  }
  return id;
}
