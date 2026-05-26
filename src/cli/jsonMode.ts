import * as readline from "readline";
import * as fs from "fs";
import { CLIChargePointService } from "./service";
import { OCPPStatus } from "../cp/domain/types/OcppTypes";
import { toJsonResponse, toJsonEvent } from "./output";
import type { JsonCommand } from "./types";
import type {
  ScenarioDefinition,
  ScenarioExecutionMode,
  ScenarioMode,
} from "../cp/application/scenario/ScenarioTypes";

const VALID_EXECUTION_MODES: ReadonlyArray<ScenarioExecutionMode> = [
  "oneshot",
  "step",
];
import type { EVSettings } from "../cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";
import type { HistoryOptions } from "../cp/application/services/types/StateSnapshot";

const VALID_SCENARIO_MODES: ReadonlyArray<ScenarioMode> = [
  "manual",
  "scenario",
];

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
      // Connector 0 represents the charge point itself (OCPP 1.6J), so accept
      // any non-negative integer here, not just positive ones.
      const connectorId = requireNonNegativeInt(params, "connector");
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
      const modeRaw = typeof params.mode === "string" ? params.mode : "oneshot";
      if (!VALID_EXECUTION_MODES.includes(modeRaw as ScenarioExecutionMode)) {
        throw new Error(
          `Invalid mode: ${modeRaw}. Valid: ${VALID_EXECUTION_MODES.join(", ")}`,
        );
      }
      service.runScenario(
        connectorId,
        scenarioId,
        modeRaw as ScenarioExecutionMode,
      );
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

    case "set_ev_settings": {
      const connectorId = requirePositiveInt(params, "connector");
      const settings = requireObject(
        params,
        "settings",
      ) as unknown as EVSettings;
      service.setEVSettings(connectorId, settings);
      return undefined;
    }

    case "get_ev_settings": {
      const connectorId = requirePositiveInt(params, "connector");
      return service.getEVSettings(connectorId);
    }

    case "set_auto_meter_config": {
      const connectorId = requirePositiveInt(params, "connector");
      const config = requireObject(
        params,
        "config",
      ) as unknown as AutoMeterValueConfig;
      service.setAutoMeterValueConfig(connectorId, config);
      return undefined;
    }

    case "get_auto_meter_config": {
      const connectorId = requirePositiveInt(params, "connector");
      return service.getAutoMeterValueConfig(connectorId);
    }

    case "set_auto_reset_to_available": {
      const connectorId = requirePositiveInt(params, "connector");
      const enabled = requireBoolean(params, "enabled");
      service.setAutoResetToAvailable(connectorId, enabled);
      return undefined;
    }

    case "set_mode": {
      const connectorId = requirePositiveInt(params, "connector");
      const mode = requireString(params, "mode");
      if (!VALID_SCENARIO_MODES.includes(mode as ScenarioMode)) {
        throw new Error(
          `Invalid mode: ${mode}. Valid: ${VALID_SCENARIO_MODES.join(", ")}`,
        );
      }
      service.setConnectorMode(connectorId, mode as ScenarioMode);
      return undefined;
    }

    case "get_charging_profiles": {
      const connectorId = requirePositiveInt(params, "connector");
      return service.getChargingProfiles(connectorId);
    }

    case "remove_connector": {
      const connectorId = requirePositiveInt(params, "connector");
      const removed = service.removeConnector(connectorId);
      return { removed };
    }

    case "get_state_history": {
      const options = parseHistoryOptions(params.options);
      return service.getStateHistory(options);
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

export function requireNonNegativeInt(
  params: Record<string, unknown>,
  key: string,
): number {
  const val = params[key];
  if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
    throw new Error(
      `Missing or invalid parameter: ${key} (expected non-negative integer)`,
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

export function requireBoolean(
  params: Record<string, unknown>,
  key: string,
): boolean {
  const val = params[key];
  if (typeof val !== "boolean") {
    throw new Error(`Missing or invalid parameter: ${key} (expected boolean)`);
  }
  return val;
}

export function requireObject(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const val = params[key];
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    throw new Error(`Missing or invalid parameter: ${key} (expected object)`);
  }
  return val as Record<string, unknown>;
}

/**
 * Convert a HistoryOptions object that arrived over JSON into the in-memory
 * shape `StateHistory.getHistory` expects. fromTimestamp / toTimestamp are
 * ISO strings on the wire but the comparator needs Date instances.
 */
function parseHistoryOptions(raw: unknown): HistoryOptions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: HistoryOptions = {};
  if (typeof src.entity === "string") {
    out.entity = src.entity as HistoryOptions["entity"];
  }
  if (typeof src.entityId === "number") {
    out.entityId = src.entityId;
  }
  if (typeof src.transitionType === "string") {
    out.transitionType = src.transitionType as HistoryOptions["transitionType"];
  }
  if (typeof src.limit === "number") {
    out.limit = src.limit;
  }
  if (typeof src.fromTimestamp === "string") {
    out.fromTimestamp = new Date(src.fromTimestamp);
  } else if (src.fromTimestamp instanceof Date) {
    out.fromTimestamp = src.fromTimestamp;
  }
  if (typeof src.toTimestamp === "string") {
    out.toTimestamp = new Date(src.toTimestamp);
  } else if (src.toTimestamp instanceof Date) {
    out.toTimestamp = src.toTimestamp;
  }
  return out;
}
