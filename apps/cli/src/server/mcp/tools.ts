import { modemCommandSchema } from "@ocpp-cp-simulator/contracts/modem";
import { z } from "zod";
import { LogType } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import type { McpServer } from "mcp-lite";
import {
  EXPLICIT_METHODS,
  METHODS,
  RpcFailure,
  scenarioWaitExtensionSecondsSchema,
} from "@ocpp-cp-simulator/contracts/index";
import { runRpc } from "../socketServer";
import { METER_READING_CONTEXTS } from "@ocpp-cp-simulator/core/cp/domain/connector/Transaction";
import type { RuntimeSocketIoDeps } from "../socketServer";
import { successResult, errorResult } from "./tools/result";
import {
  registerCpTools,
  registerCpBulkTools,
  registerCpLifecycleTools,
} from "./tools/cp";
import { registerBehaviorTools } from "./tools/behavior";
import { registerFleetTools } from "./tools/fleet";
import { registerTransactionTools } from "./tools/transactions";

export const TAIL_LOGS_DEFAULT_LINES = 50;
export const TAIL_LOGS_MAX_LINES = 1000;

const LOG_LEVEL_RANK: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

/** The last `lines` entries that pass the filters, oldest first. */
export function tailLogEntries(
  entries: unknown,
  opts: { lines?: number; level?: string; type?: string; contains?: string },
): unknown[] {
  const all = Array.isArray(entries) ? entries : [];
  const minRank = opts.level ? LOG_LEVEL_RANK[opts.level] : undefined;
  const needle = opts.contains?.toLowerCase();
  const kept = all.filter((e) => {
    const entry = (e ?? {}) as Record<string, unknown>;
    if (minRank !== undefined) {
      // Stored entries carry the LogLevel number; accept the name as well.
      const rank =
        typeof entry.level === "number"
          ? entry.level
          : LOG_LEVEL_RANK[String(entry.level).toUpperCase()];
      if (rank === undefined || rank < minRank) return false;
    }
    if (opts.type !== undefined && entry.type !== opts.type) return false;
    if (needle !== undefined) {
      if (
        !String(entry.message ?? "")
          .toLowerCase()
          .includes(needle)
      ) {
        return false;
      }
    }
    return true;
  });
  return kept.slice(-(opts.lines ?? TAIL_LOGS_DEFAULT_LINES));
}

export function registerTools(mcp: McpServer, deps: RuntimeSocketIoDeps): void {
  registerCuratedTools(mcp, deps);
  registerListMethods(mcp, deps);
  registerCallMethod(mcp, deps);
}

function registerCuratedTools(mcp: McpServer, deps: RuntimeSocketIoDeps): void {
  registerCpTools(mcp, deps);
  registerBehaviorTools(mcp, deps);
  registerCpBulkTools(mcp, deps);
  registerFleetTools(mcp, deps);
  registerCpLifecycleTools(mcp, deps);
  registerTransactionTools(mcp, deps);

  mcp.tool("set_connector_status", {
    description: "Update the status of a connector",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      // Taken from the method so the tool advertises what it enforces (#383).
      connector:
        METHODS.update_connector_status.params.shape.connector.describe(
          "Connector identifier (0 for all)",
        ),
      status: METHODS.update_connector_status.params.shape.status.describe(
        "Connector status (e.g. Available, Charging, Faulted)",
      ),
      errorCode: z
        .string()
        .optional()
        .describe("Optional error code if status is Faulted"),
      info: z.string().optional().describe("Optional free-form status info"),
      vendorErrorCode: z
        .string()
        .optional()
        .describe("Optional vendor-specific error code"),
      vendorId: z
        .string()
        .optional()
        .describe("Optional vendor id for vendorErrorCode"),
      timestamp:
        METHODS.update_connector_status.params.shape.timestamp.describe(
          "Optional ISO 8601 timestamp for the status change",
        ),
      suppressChargingStateTransactionEvent: z
        .boolean()
        .optional()
        .describe(
          "OCPP 2.x only: suppress the TransactionEvent a charging-state change would otherwise send",
        ),
      allowInvalidTransition: z
        .boolean()
        .optional()
        .describe(
          "Send the StatusNotification even when the charge point's capabilityProfile sets statusTransitions enforce and this change is not in the OCPP 1.6 section 4.9 transition table",
        ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "update_connector_status",
          params: {
            connector: args.connector,
            status: args.status,
            errorCode: args.errorCode,
            info: args.info,
            vendorErrorCode: args.vendorErrorCode,
            vendorId: args.vendorId,
            timestamp: args.timestamp,
            suppressChargingStateTransactionEvent:
              args.suppressChargingStateTransactionEvent,
            allowInvalidTransition: args.allowInvalidTransition,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("ev_disconnected", {
    description:
      "Unplug the cable on the EV side of a connector. With a running transaction, StopTransactionOnEVSideDisconnect stops it (EVDisconnected) or suspends it (SuspendedEV); without one a Preparing, Finishing or suspended connector goes Available (a Reserved, Faulted or Unavailable one keeps its status)",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: METHODS.ev_disconnected.params.shape.connector.describe(
        "Connector identifier",
      ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "ev_disconnected",
          params: { connector: args.connector },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("set_meter_value", {
    description: "Set the meter value for a connector",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z.number().int().min(1).describe("Connector identifier"),
      value: z.number().int().min(0).describe("Meter value in Wh"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "set_meter_value",
          params: {
            connector: args.connector,
            value: args.value,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("send_meter_value", {
    description: "Send the current meter value for a connector",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z.number().int().min(1).describe("Connector identifier"),
      context: z
        .enum(METER_READING_CONTEXTS)
        .optional()
        .describe(
          "sampledValue.context the readings carry (#335); default Sample.Periodic",
        ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "send_meter_value",
          params: {
            connector: args.connector,
            context: args.context,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("scenario_templates", {
    description: "List available scenario templates",
    inputSchema: z.object({}),
    handler: async () => {
      try {
        const result = await runRpc(deps, {
          method: "scenario.templates",
          params: {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("run_scenario_template", {
    description: "Run a scenario template on a connector",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z.number().int().min(1).describe("Connector identifier"),
      templateId: z.string().describe("Scenario template identifier"),
      evSettings: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Overrides for the template's EV settings"),
      strict: z
        .boolean()
        .optional()
        .describe(
          "Promote warning-severity assertions to failures (see docs/concepts/scenario-format.md#severity-conformance-vs-compatibility)",
        ),
      once: z
        .boolean()
        .optional()
        .describe(
          "Run the template once: the instance is loaded disabled, so it does not re-arm on the next reconnect. Default: re-arms on every connect.",
        ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "run_scenario_template",
          params: {
            connector: args.connector,
            templateId: args.templateId,
            evSettings: args.evSettings,
            strict: args.strict,
            once: args.once,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("scenario_status", {
    description: "Get the status of a running scenario",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z.number().int().min(1).describe("Connector identifier"),
      scenarioId: z.string().describe("Scenario identifier"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "scenario_status",
          params: {
            connector: args.connector,
            scenarioId: args.scenarioId,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  // #240: one tool for the three controls on a parked wait; `action` picks
  // the method, and the method's own schema rejects an extend without
  // `seconds`.
  mcp.tool("control_scenario_wait", {
    description:
      "Act on the wait a running scenario is parked on (for example a " +
      "RemoteStart or CSMS-call trigger): 'extend' pushes its timeout back " +
      "by `seconds`, 'retry' re-arms the wait with its full timeout, " +
      "'continue' moves on to the next node without the awaited event. " +
      "Each action is recorded in the run report's `interventions`.",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z.number().int().min(1).describe("Connector identifier"),
      scenarioId: z.string().min(1).describe("Scenario identifier"),
      action: z
        .enum(["extend", "retry", "continue"])
        .describe("What to do with the parked wait"),
      seconds: scenarioWaitExtensionSecondsSchema
        .optional()
        .describe("Seconds to add to the timeout (required for 'extend')"),
    }),
    handler: async ({ cpId, action, ...params }) => {
      try {
        const result = await runRpc(deps, {
          cpId,
          method: `${action}_scenario_wait`,
          params,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("get_logs", {
    description:
      "Retrieve logs for a charge point. Returns the MOST RECENT entries: " +
      "`limit` takes the newest N, and `offset` pages backwards from the " +
      "newest, so {limit:100} is the last 100 and {limit:100, offset:100} the " +
      "100 before those. Entries come back oldest-first unless order is 'desc'.",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of most-recent log entries to return"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Skip this many of the newest entries before taking `limit`"),
      order: z
        .enum(["asc", "desc"])
        .optional()
        .describe(
          "Order of the returned window: 'asc' (oldest first, default) or 'desc' (newest first)",
        ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "logs.get",
          params: {
            cpId: args.cpId,
            limit: args.limit,
            offset: args.offset,
            order: args.order,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("tail_logs", {
    description:
      "Read the end of a charge point's log: the last `lines` entries " +
      "(default 50, at most 1000), oldest first, so the final element is the " +
      "newest. Optional filters are applied before the tail is taken: " +
      "`level` keeps entries at that level or more severe, `type` keeps " +
      "entries of one log type (e.g. OCPP, WebSocket), `contains` keeps " +
      "entries whose message contains the text (case-insensitive). Use " +
      "get_logs to page further back.",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      lines: z
        .number()
        .int()
        .min(1)
        .max(TAIL_LOGS_MAX_LINES)
        .optional()
        .describe(
          `Number of entries to return (default ${TAIL_LOGS_DEFAULT_LINES})`,
        ),
      level: z
        .enum(["DEBUG", "INFO", "WARN", "ERROR"])
        .optional()
        .describe("Keep entries at this level or more severe"),
      type: z
        .enum(Object.values(LogType) as [LogType, ...LogType[]])
        .optional()
        .describe("Keep entries of this log type"),
      contains: z
        .string()
        .min(1)
        .optional()
        .describe("Keep entries whose message contains this text"),
    }),
    handler: async (args) => {
      try {
        const entries = await runRpc(deps, {
          method: "logs.get",
          params: { cpId: args.cpId },
        });
        return successResult(tailLogEntries(entries, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  const timeline = METHODS["timeline.get"].params.shape;
  mcp.tool("get_timeline", {
    description:
      "Retrieve a charge point's operational timeline (#448): normalized, " +
      "ordered events — connection loss and reconnect, injected network " +
      "faults and the recovery they caused, CP/connector status changes, " +
      "transactions and their rejected or discarded 2.x TransactionEvents, " +
      "authorization rejections, scenario runs and " +
      "smart-charging profiles applied, cleared or expired. Entries " +
      "are ordered by `seq`; entries of one fault share an `incidentId` and " +
      "`recovery_completed` reports `durationMs`. Windowed like get_logs: " +
      "`limit` takes the newest N, `offset` pages backwards.",
    // The method's own fields, so the tool advertises what it enforces.
    inputSchema: z.object({
      cpId: timeline.cpId.describe("Charge point identifier"),
      connectorId: timeline.connectorId.describe(
        "Only entries about this connector",
      ),
      runId: timeline.runId.describe(
        "Only entries attributed to this scenario run",
      ),
      incidentId: timeline.incidentId.describe(
        "Only entries of this network-fault incident",
      ),
      kinds: timeline.kinds.describe("Only these entry kinds"),
      limit: timeline.limit.describe(
        "Number of most-recent matching entries to return",
      ),
      offset: timeline.offset.describe(
        "Skip this many of the newest entries before taking `limit`",
      ),
      order: timeline.order.describe(
        "'asc' (oldest first, default) or 'desc' (newest first)",
      ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "timeline.get",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  const sessions = METHODS["sessions.list"].params.shape;
  mcp.tool("list_charging_sessions", {
    description:
      "List charging sessions (#447): one charge point's with cpId, or every " +
      "charge point's when cpId is omitted (#489; labels narrows the fleet " +
      "to a selector, startedFrom/startedTo bound the start time). One normalized record " +
      "per transaction, the same shape for OCPP 1.6 and 2.x — connector, " +
      "transaction id, idTag, start/end, duration, meter start/stop, energy " +
      "(Wh), stop reason and an outcome (active, completed, interrupted, " +
      "failed). Unknown values are null, never guessed. Newest first; no " +
      "billing or tariff data.",
    inputSchema: z.object({
      cpId: sessions.cpId.describe(
        "Charge point identifier; omit to list across the fleet",
      ),
      labels: sessions.labels.describe(
        "Fleet-wide only (not with cpId): the charge points carrying every one of these label pairs (exact match); {} or omitted = all",
      ),
      startedFrom: sessions.startedFrom.describe(
        "Only sessions that started at or after this instant (ISO 8601 with a zone)",
      ),
      startedTo: sessions.startedTo.describe(
        "Only sessions that started before this instant (ISO 8601 with a zone)",
      ),
      connectorId: sessions.connectorId.describe(
        "Only sessions on this connector",
      ),
      outcomes: sessions.outcomes.describe("Only sessions with these outcomes"),
      limit: sessions.limit.describe(
        "How many of the newest matching sessions to return (default 50)",
      ),
      offset: sessions.offset.describe(
        "Skip this many of the newest matching sessions (pages back in time)",
      ),
      order: sessions.order.describe(
        "Order of the returned page by start time: 'desc' (newest first, default) or 'asc'; it does not change which sessions are selected",
      ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "sessions.list",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  const configKeysGet = METHODS["cp.config_keys.get"].params.shape;
  mcp.tool("get_config_keys", {
    description:
      "Read a charge point's OCPP configuration keys (#612). OCPP 1.6: the " +
      "GetConfiguration keys; 2.x: the keys the Device Model registers, each " +
      "with its component, variable and mutability. Omit `keys` to list all. " +
      "A write-only value (AuthorizationKey) is returned empty. Names the " +
      "charge point does not have come back in `unknown`.",
    inputSchema: z.object({
      cpId: configKeysGet.cpId.describe("Charge point identifier"),
      keys: configKeysGet.keys.describe(
        "Key names to read; omit or leave empty for every key",
      ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.config_keys.get",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  const configKeysSet = METHODS["cp.config_keys.set"].params.shape;
  mcp.tool("set_config_key", {
    description:
      "Write one OCPP configuration key on a running charge point (#612), " +
      "through the same validation, persistence and live effect as a CSMS " +
      "ChangeConfiguration / SetVariables. Fails with not_found for a key the " +
      "charge point does not have and invalid_params for a read-only key or a " +
      "value the key refuses (type, bounds, allowed values). Answers " +
      "Accepted or RebootRequired.",
    inputSchema: z.object({
      cpId: configKeysSet.cpId.describe("Charge point identifier"),
      key: configKeysSet.key.describe("Configuration key name"),
      value: configKeysSet.value.describe(
        "New value as ChangeConfiguration carries it; a list is comma-separated",
      ),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.config_keys.set",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("network_sim_get", {
    description:
      "Get the network-simulation config: the global layer (omit cpId) or a charge point's layer + resolved config (with cpId).",
    inputSchema: z.object({
      cpId: z
        .string()
        .optional()
        .describe("Charge point id; omit for the global config"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: args.cpId ? "network_sim.cp.get" : "network_sim.global.get",
          params: args.cpId ? { cpId: args.cpId } : {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("network_sim_set", {
    description:
      "Set the network-simulation layer config. Rules apply to WebSocket CPs only. Passing null for config clears/deletes it.",
    inputSchema: z.object({
      cpId: z
        .string()
        .optional()
        .describe("Charge point id; omit to set the global config"),
      config: z
        .record(z.string(), z.unknown())
        .nullable()
        .describe("Network-sim layer config, or null to delete/clear"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: args.cpId ? "network_sim.cp.save" : "network_sim.global.save",
          params: args.cpId
            ? { cpId: args.cpId, config: args.config }
            : { config: args.config },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("network_sim_trigger_disconnect", {
    description:
      "Trigger a manual-disconnect rule's forced disconnection on a charge point.",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point id"),
      ruleId: z
        .string()
        .describe("Id of a manual-disconnect rule in the CP's resolved config"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "network_sim.disconnect.trigger",
          params: {
            cpId: args.cpId,
            ruleId: args.ruleId,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("cellular_policy_get", {
    description:
      "SIM-scoped cellular policies (#930) and their effect: the policy set, how many stations are out of service or throttled, and each governed station's link (available, reasons, effective byte caps, which policies select it).",
    inputSchema: z.object({}),
    handler: async () => {
      try {
        const [policies, status] = await Promise.all([
          runRpc(deps, { method: "network_sim.cellular.get", params: {} }),
          runRpc(deps, { method: "network_sim.cellular.status", params: {} }),
        ]);
        return successResult({ ...(policies as object), status });
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("cellular_policy_set", {
    description:
      "Replace the SIM-scoped cellular policies (#930); null clears them. A policy selects cards by simId, iccid or operator and sets service online|blocked and/or upstream/downstream bytes-per-second caps. A blocked SIM keeps a cellular-only station offline until restored, whatever connect/reset/reconnect is tried. Applies to stations that acquire a matching SIM later.",
    inputSchema: z.object({
      ...METHODS["network_sim.cellular.save"].params.shape,
    }),
    handler: async (args) => {
      try {
        return successResult(
          await runRpc(deps, {
            method: "network_sim.cellular.save",
            params: args,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("modem_get", {
    description:
      "Read a charge point's cellular modem and SIM (#928): slot state (no_modem, empty, inserted), selected network interface and the card with its identifiers masked to the last four characters. Answers no_modem_model when the station has no modem model.",
    inputSchema: z.object({ cpId: z.string().describe("Charge point id") }),
    handler: async (args) => {
      try {
        return successResult(
          await runRpc(deps, { method: "modem.get", params: args }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("modem_command", {
    description:
      "Change a charge point's SIM (#928): insert_sim, remove_sim, replace_sim, suspend_subscription, activate_subscription, set_network_interface (networkInterface) or set_reporting_policy (reporting, #929). A refused command answers its typed error (slot_occupied, slot_empty, already_suspended, already_active, modem_absent, invalid_sim, invalid_network_interface, invalid_reporting_policy) or no_modem_model when the charge point has no modem model. The card keeps its iccid/imsi while suspended.",
    inputSchema: modemCommandSchema,
    handler: async (args) => {
      try {
        return successResult(
          await runRpc(deps, { method: "modem.command", params: args }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("power_loss", {
    description:
      "Simulate a power loss on a charge point (#455): the socket vanishes with its transactions kept. Give restoreAfterMs for an outage that ends by itself, or call power_restore.",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point id"),
      ...METHODS["power.loss"].params.omit({ cpId: true }).shape,
    }),
    handler: async (args) => {
      try {
        return successResult(
          await runRpc(deps, { method: "power.loss", params: args }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("power_restore", {
    description:
      "Restore power to a charge point after power_loss: it boots, then resumes or ends the interrupted transactions (1.6 PowerLoss stop; 2.x E17).",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point id"),
      ...METHODS["power.restore"].params.omit({ cpId: true }).shape,
    }),
    handler: async (args) => {
      try {
        return successResult(
          await runRpc(deps, { method: "power.restore", params: args }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}

function registerListMethods(mcp: McpServer, _deps: RuntimeSocketIoDeps): void {
  mcp.tool("list_methods", {
    description:
      "List all available RPC methods or get details for a specific method",
    inputSchema: z.object({
      method: z
        .string()
        .optional()
        .describe(
          "Optional method name to get details; if omitted, returns catalog of all methods",
        ),
    }),
    handler: async (args) => {
      try {
        if (args.method) {
          if (!(args.method in METHODS)) {
            return errorResult(new RpcFailure("not_found", "Method not found"));
          }
          const methodSchema = METHODS[args.method as keyof typeof METHODS];
          const paramsSchema = methodSchema.params;
          return successResult({
            method: args.method,
            paramsSchema: z.toJSONSchema(paramsSchema),
          });
        }

        const methodSet = new Set(Object.keys(METHODS));
        methodSet.delete("events.subscribe");
        methodSet.delete("events.unsubscribe");

        const catalog = Array.from(methodSet).map((name) => {
          const isExplicit = (EXPLICIT_METHODS as readonly string[]).includes(
            name,
          );
          const cpIdRequired =
            !isExplicit && !["cp.list", "scenario.templates"].includes(name);
          return {
            method: name,
            cpIdRequired,
          };
        });

        return successResult(catalog);
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}

function registerCallMethod(mcp: McpServer, deps: RuntimeSocketIoDeps): void {
  mcp.tool("call_method", {
    description:
      "Call any RPC method directly. WARNING: methods like server.shutdown and state.reset are destructive and irreversible.",
    inputSchema: z.object({
      method: z.string().describe("RPC method name"),
      cpId: z
        .string()
        .optional()
        .describe(
          "Charge point identifier (required for CP-specific methods, omitted for daemon-level methods)",
        ),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Method parameters as a key-value object"),
    }),
    handler: async (args) => {
      try {
        if (
          args.method === "events.subscribe" ||
          args.method === "events.unsubscribe"
        ) {
          return errorResult(
            new RpcFailure(
              "not_found",
              "events.subscribe/unsubscribe are only available over socket.io",
            ),
          );
        }

        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: args.method,
          params: args.params,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
