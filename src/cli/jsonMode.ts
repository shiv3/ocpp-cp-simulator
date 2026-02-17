import * as readline from "readline";
import * as fs from "fs";
import { CLIChargePointService } from "./service";
import { OCPPStatus } from "../cp/domain/types/OcppTypes";
import { toJsonResponse, toJsonEvent } from "./output";
import type { JsonCommand } from "./types";
import type { ScenarioDefinition } from "../cp/application/scenario/ScenarioTypes";

const VALID_STATUSES = new Set(Object.values(OCPPStatus));

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export async function startJsonMode(
  service: CLIChargePointService,
): Promise<void> {
  service.onEvent((evt) => {
    if (evt.event === "log") return;
    writeLine(toJsonEvent(evt.event, evt.data));
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: JsonCommand;
    try {
      parsed = JSON.parse(trimmed) as JsonCommand;
    } catch {
      writeLine(toJsonResponse(null, false, "Invalid JSON"));
      return;
    }

    const id = parsed.id ?? null;

    try {
      const result = await handleJsonCommand(service, parsed);
      writeLine(toJsonResponse(id, true, result));
    } catch (err) {
      writeLine(
        toJsonResponse(
          id,
          false,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  });

  rl.on("close", () => {
    service.cleanup();
    process.exit(0);
  });
}

export async function handleJsonCommand(
  service: CLIChargePointService,
  cmd: JsonCommand,
): Promise<unknown> {
  const params = cmd.params ?? {};

  switch (cmd.command) {
    case "connect": {
      await service.connect();
      return undefined;
    }

    case "disconnect": {
      service.disconnect();
      return undefined;
    }

    case "status": {
      return service.getStatus();
    }

    case "start_transaction": {
      const connectorId = requirePositiveInt(params, "connector");
      const tagId = requireString(params, "tagId");
      service.startTransaction(connectorId, tagId);
      return undefined;
    }

    case "stop_transaction": {
      const connectorId = requirePositiveInt(params, "connector");
      service.stopTransaction(connectorId);
      return undefined;
    }

    case "set_meter_value": {
      const connectorId = requirePositiveInt(params, "connector");
      const value = requireNumber(params, "value");
      if (value < 0 || !Number.isInteger(value)) {
        throw new Error("value must be a non-negative integer (Wh)");
      }
      service.setMeterValue(connectorId, value);
      return undefined;
    }

    case "send_meter_value": {
      const connectorId = requirePositiveInt(params, "connector");
      service.sendMeterValue(connectorId);
      return undefined;
    }

    case "heartbeat": {
      service.sendHeartbeat();
      return undefined;
    }

    case "start_heartbeat": {
      const interval = requireNumber(params, "interval");
      if (interval <= 0) {
        throw new Error("interval must be a positive number");
      }
      service.startHeartbeat(interval);
      return undefined;
    }

    case "stop_heartbeat": {
      service.stopHeartbeat();
      return undefined;
    }

    case "authorize": {
      const tagId = requireString(params, "tagId");
      service.authorize(tagId);
      return undefined;
    }

    case "update_connector_status": {
      const connectorId = requirePositiveInt(params, "connector");
      const status = requireString(params, "status");
      if (!VALID_STATUSES.has(status as OCPPStatus)) {
        throw new Error(
          `Invalid status: ${status}. Valid: ${[...VALID_STATUSES].join(", ")}`,
        );
      }
      service.updateConnectorStatus(connectorId, status as OCPPStatus);
      return undefined;
    }

    case "list_scenario_templates": {
      return service.getScenarioTemplates();
    }

    case "load_scenario_template": {
      const templateId = requireString(params, "templateId");
      const connectorId = requirePositiveInt(params, "connector");
      const scenarioId = service.loadScenarioTemplate(templateId, connectorId);
      return { scenarioId };
    }

    case "load_scenario": {
      const connectorId = requirePositiveInt(params, "connector");
      if (typeof params.file === "string") {
        const content = fs.readFileSync(params.file, "utf-8");
        const definition = JSON.parse(content) as ScenarioDefinition;
        const scenarioId = service.loadScenario(connectorId, definition);
        return { scenarioId };
      }
      if (params.scenario) {
        const definition = params.scenario as ScenarioDefinition;
        const scenarioId = service.loadScenario(connectorId, definition);
        return { scenarioId };
      }
      throw new Error("Either 'file' or 'scenario' parameter is required");
    }

    case "list_scenarios": {
      const connectorId = requirePositiveInt(params, "connector");
      return service.listScenarios(connectorId);
    }

    case "run_scenario": {
      const connectorId = requirePositiveInt(params, "connector");
      const scenarioId = requireString(params, "scenarioId");
      service.runScenario(connectorId, scenarioId);
      return undefined;
    }

    case "scenario_status": {
      const connectorId = requirePositiveInt(params, "connector");
      const scenarioId = requireString(params, "scenarioId");
      return service.getScenarioStatus(connectorId, scenarioId);
    }

    case "stop_scenario": {
      const connectorId = requirePositiveInt(params, "connector");
      const scenarioId = requireString(params, "scenarioId");
      service.stopScenario(connectorId, scenarioId);
      return undefined;
    }

    case "stop_all_scenarios": {
      const connectorId = requirePositiveInt(params, "connector");
      service.stopAllScenarios(connectorId);
      return undefined;
    }

    case "run_scenario_file": {
      const connectorId = requirePositiveInt(params, "connector");
      const filePath = requireString(params, "file");
      const content = fs.readFileSync(filePath, "utf-8");
      const definition = JSON.parse(content) as ScenarioDefinition;
      const scenarioId = service.loadScenario(connectorId, definition);
      service.runScenario(connectorId, scenarioId);
      return { scenarioId };
    }

    case "run_scenario_template": {
      const connectorId = requirePositiveInt(params, "connector");
      const templateId = requireString(params, "templateId");
      const scenarioId = service.loadScenarioTemplate(templateId, connectorId);
      service.runScenario(connectorId, scenarioId);
      return { scenarioId };
    }

    default:
      throw new Error(`Unknown command: ${cmd.command}`);
  }
}

export function requirePositiveInt(
  params: Record<string, unknown>,
  key: string,
): number {
  const val = params[key];
  if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
    throw new Error(
      `Missing or invalid parameter: ${key} (expected positive integer)`,
    );
  }
  return val;
}

export function requireNumber(
  params: Record<string, unknown>,
  key: string,
): number {
  const val = params[key];
  if (typeof val !== "number" || isNaN(val)) {
    throw new Error(`Missing or invalid parameter: ${key} (expected number)`);
  }
  return val;
}

export function requireString(
  params: Record<string, unknown>,
  key: string,
): string {
  const val = params[key];
  if (typeof val !== "string" || val.length === 0) {
    throw new Error(`Missing or invalid parameter: ${key} (expected string)`);
  }
  return val;
}
