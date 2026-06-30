import * as readline from "readline";
import * as fs from "fs";
import {
  hasStatusNotificationOptions,
  OCPPStatus,
  type StatusNotificationOptions,
} from "../cp/domain/types/OcppTypes";
import { toJsonResponse, toJsonEvent } from "./output";
import type { JsonCommand } from "./types";
import type {
  ScenarioDefinition,
  ScenarioMode,
} from "../cp/application/scenario/ScenarioTypes";
import type { EVSettings } from "../cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";
import type { HistoryOptions } from "../cp/application/services/types/StateSnapshot";
import {
  cleanupSingleCpTarget,
  getSingleCpCommandOps,
  getSingleCpEventSource,
  type SingleCpCommandTarget,
  type SingleCpProcessTarget,
} from "./singleCpTarget";

const VALID_SCENARIO_MODES: ReadonlyArray<ScenarioMode> = [
  "manual",
  "scenario",
];

const VALID_STATUSES = new Set(Object.values(OCPPStatus));

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export async function startJsonMode(
  service: SingleCpProcessTarget,
): Promise<void> {
  getSingleCpEventSource(service).onEvent((evt) => {
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
    cleanupSingleCpTarget(service);
    process.exit(0);
  });
}

export async function handleJsonCommand(
  service: SingleCpCommandTarget,
  cmd: JsonCommand,
): Promise<unknown> {
  const params = cmd.params ?? {};
  const ops = getSingleCpCommandOps(service);

  switch (cmd.command) {
    case "connect": {
      await ops.connect();
      return undefined;
    }

    case "disconnect": {
      await ops.disconnect();
      return undefined;
    }

    case "status": {
      return ops.getStatus();
    }

    case "start_transaction": {
      const connectorId = requirePositiveInt(params, "connector");
      const tagId = requireString(params, "tagId");
      await ops.startTransaction(connectorId, tagId);
      return undefined;
    }

    case "stop_transaction": {
      const connectorId = requirePositiveInt(params, "connector");
      await ops.stopTransaction(connectorId);
      return undefined;
    }

    case "set_meter_value": {
      const connectorId = requirePositiveInt(params, "connector");
      const value = requireNumber(params, "value");
      if (value < 0 || !Number.isInteger(value)) {
        throw new Error("value must be a non-negative integer (Wh)");
      }
      await ops.setMeterValue(connectorId, value);
      return undefined;
    }

    case "send_meter_value": {
      const connectorId = requirePositiveInt(params, "connector");
      await ops.sendMeterValue(connectorId);
      return undefined;
    }

    case "heartbeat": {
      await ops.sendHeartbeat();
      return undefined;
    }

    case "diagnostics_status_notification": {
      const status = requireString(params, "status");
      await ops.sendDiagnosticsStatusNotification(status);
      return undefined;
    }

    case "firmware_status_notification": {
      const status = requireString(params, "status");
      await ops.sendFirmwareStatusNotification(status);
      return undefined;
    }

    case "security_event_notification": {
      const type = requireString(params, "type");
      const techInfo =
        params.techInfo === undefined
          ? undefined
          : requireString(params, "techInfo");
      await ops.sendSecurityEventNotification(type, techInfo);
      return undefined;
    }

    case "sign_certificate": {
      const csr =
        params.csr === undefined ? undefined : requireString(params, "csr");
      await ops.sendSignCertificate(csr);
      return undefined;
    }

    case "start_heartbeat": {
      const interval = requireNumber(params, "interval");
      if (interval <= 0) {
        throw new Error("interval must be a positive number");
      }
      await ops.startHeartbeat(interval);
      return undefined;
    }

    case "stop_heartbeat": {
      await ops.stopHeartbeat();
      return undefined;
    }

    case "authorize": {
      const tagId = requireString(params, "tagId");
      await ops.authorize(tagId);
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
      const opts = readStatusNotificationOptions(params);
      await ops.updateConnectorStatus(connectorId, status as OCPPStatus, opts);
      return undefined;
    }

    case "list_scenario_templates": {
      return ops.getScenarioTemplates();
    }

    case "load_scenario_template": {
      const templateId = requireString(params, "templateId");
      const connectorId = requirePositiveInt(params, "connector");
      const evSettings = params.evSettings as Partial<EVSettings> | undefined;
      const scenarioId = await ops.loadScenarioTemplate(
        templateId,
        connectorId,
        evSettings,
      );
      return { scenarioId };
    }

    case "load_scenario": {
      const connectorId = requirePositiveInt(params, "connector");
      if (typeof params.file === "string") {
        const content = fs.readFileSync(params.file, "utf-8");
        const definition = JSON.parse(content) as ScenarioDefinition;
        const scenarioId = await ops.loadScenario(connectorId, definition);
        return { scenarioId };
      }
      if (params.scenario) {
        const definition = params.scenario as ScenarioDefinition;
        const scenarioId = await ops.loadScenario(connectorId, definition);
        return { scenarioId };
      }
      throw new Error("Either 'file' or 'scenario' parameter is required");
    }

    case "list_scenarios": {
      const connectorId = requirePositiveInt(params, "connector");
      return ops.listScenarios(connectorId);
    }

    case "run_scenario": {
      const connectorId = requirePositiveInt(params, "connector");
      const scenarioId = requireString(params, "scenarioId");
      // Legacy "mode" param is silently ignored — scenarios always run
      // one-shot now. Kept tolerant so old clients don't break.
      await ops.runScenario(connectorId, scenarioId);
      return undefined;
    }

    case "scenario_status": {
      const connectorId = requirePositiveInt(params, "connector");
      const scenarioId = requireString(params, "scenarioId");
      return ops.getScenarioStatus(connectorId, scenarioId);
    }

    case "get_scenario": {
      const connectorId = requirePositiveInt(params, "connector");
      const scenarioId = requireString(params, "scenarioId");
      return ops.getScenario(connectorId, scenarioId);
    }

    case "stop_scenario": {
      const connectorId = requirePositiveInt(params, "connector");
      const scenarioId = requireString(params, "scenarioId");
      await ops.stopScenario(connectorId, scenarioId);
      return undefined;
    }

    case "step_scenario": {
      const connectorId = requirePositiveInt(params, "connector");
      const scenarioId = requireString(params, "scenarioId");
      const force = params.force === true;
      await ops.stepScenario(connectorId, scenarioId, force);
      return undefined;
    }

    case "stop_all_scenarios": {
      const connectorId = requirePositiveInt(params, "connector");
      await ops.stopAllScenarios(connectorId);
      return undefined;
    }

    case "remove_scenario": {
      const connectorId = requirePositiveInt(params, "connector");
      const scenarioId = requireString(params, "scenarioId");
      const removed = await ops.removeScenario(connectorId, scenarioId);
      return { removed };
    }

    case "run_scenario_file": {
      const connectorId = requirePositiveInt(params, "connector");
      const filePath = requireString(params, "file");
      return ops.runScenarioFile(connectorId, filePath);
    }

    case "run_scenario_template": {
      const connectorId = requirePositiveInt(params, "connector");
      const templateId = requireString(params, "templateId");
      const evSettings = params.evSettings as Partial<EVSettings> | undefined;
      return ops.runScenarioTemplate(connectorId, templateId, evSettings);
    }

    case "set_ev_settings": {
      const connectorId = requirePositiveInt(params, "connector");
      const settings = requireObject(
        params,
        "settings",
      ) as unknown as EVSettings;
      await ops.setEVSettings(connectorId, settings);
      return undefined;
    }

    case "get_ev_settings": {
      const connectorId = requirePositiveInt(params, "connector");
      return ops.getEVSettings(connectorId);
    }

    case "set_auto_meter_config": {
      const connectorId = requirePositiveInt(params, "connector");
      const config = requireObject(
        params,
        "config",
      ) as unknown as AutoMeterValueConfig;
      await ops.setAutoMeterValueConfig(connectorId, config);
      return undefined;
    }

    case "get_auto_meter_config": {
      const connectorId = requirePositiveInt(params, "connector");
      return ops.getAutoMeterValueConfig(connectorId);
    }

    case "set_auto_reset_to_available": {
      const connectorId = requirePositiveInt(params, "connector");
      const enabled = requireBoolean(params, "enabled");
      await ops.setAutoResetToAvailable(connectorId, enabled);
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
      await ops.setConnectorMode(connectorId, mode as ScenarioMode);
      return undefined;
    }

    case "set_soc": {
      const connectorId = requirePositiveInt(params, "connector");
      const raw = params?.soc;
      const soc: number | null =
        raw === null || raw === undefined
          ? null
          : typeof raw === "number"
            ? raw
            : (() => {
                throw new Error("'soc' must be a number or null");
              })();
      await ops.setConnectorSoc(connectorId, soc);
      return undefined;
    }

    case "set_soc_meter_sync": {
      const connectorId = requirePositiveInt(params, "connector");
      const enabled = requireBoolean(params, "enabled");
      await ops.setConnectorSocMeterSync(connectorId, enabled);
      return undefined;
    }

    case "get_charging_profiles": {
      const connectorId = requirePositiveInt(params, "connector");
      return ops.getChargingProfiles(connectorId);
    }

    case "remove_connector": {
      const connectorId = requirePositiveInt(params, "connector");
      const removed = await ops.removeConnector(connectorId);
      return { removed };
    }

    case "get_state_history": {
      const options = parseHistoryOptions(params.options);
      return ops.getStateHistory(options);
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

function readStatusNotificationOptions(
  params: Record<string, unknown>,
): StatusNotificationOptions | undefined {
  const opts: StatusNotificationOptions = {};
  readOptionalString(params, "errorCode", opts);
  readOptionalString(params, "info", opts);
  readOptionalString(params, "vendorErrorCode", opts);
  readOptionalString(params, "vendorId", opts);
  readOptionalTimestamp(params, "timestamp", opts);
  readOptionalBoolean(params, "suppressChargingStateTransactionEvent", opts);
  return hasStatusNotificationOptions(opts) ? opts : undefined;
}

function readOptionalString(
  params: Record<string, unknown>,
  key: "errorCode" | "info" | "vendorErrorCode" | "vendorId",
  target: StatusNotificationOptions,
): void {
  const val = params[key];
  if (val === undefined) return;
  if (typeof val !== "string") {
    throw new Error(`Missing or invalid parameter: ${key} (expected string)`);
  }
  target[key] = val;
}

function readOptionalTimestamp(
  params: Record<string, unknown>,
  key: "timestamp",
  target: StatusNotificationOptions,
): void {
  const val = params[key];
  if (val === undefined) return;
  const date =
    val instanceof Date ? val : typeof val === "string" ? new Date(val) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(
      `Missing or invalid parameter: ${key} (expected ISO timestamp)`,
    );
  }
  target[key] = date;
}

function readOptionalBoolean(
  params: Record<string, unknown>,
  key: "suppressChargingStateTransactionEvent",
  target: StatusNotificationOptions,
): void {
  const val = params[key];
  if (val === undefined) return;
  if (typeof val !== "boolean") {
    throw new Error(`Missing or invalid parameter: ${key} (expected boolean)`);
  }
  target[key] = val;
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
