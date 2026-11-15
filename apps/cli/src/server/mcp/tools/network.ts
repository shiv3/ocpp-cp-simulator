import { z } from "zod";
import type { McpServer } from "mcp-lite";
import { METHODS } from "@ocpp-cp-simulator/contracts/index";
import { runRpc } from "../../socketServer";
import type { RuntimeSocketIoDeps } from "../../socketServer";
import { modemCommandSchema } from "@ocpp-cp-simulator/contracts/modem";
import { successResult, errorResult } from "./result";

export function registerNetworkTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
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
}
