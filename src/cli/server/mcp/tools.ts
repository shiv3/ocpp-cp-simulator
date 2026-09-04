import { z } from "zod";
import type { McpServer, ToolCallResult } from "mcp-lite";
import {
  createManyParamsSchema,
  createParamsSchema,
  EXPLICIT_METHODS,
  METHODS,
  RpcFailure,
} from "../../../protocol";
import { errorCodeFrom, rpcFailureMessage, runRpc } from "../socketServer";
import type { RuntimeSocketIoDeps } from "../socketServer";

function successResult(data: unknown): ToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data ?? null, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown): ToolCallResult {
  if (err instanceof RpcFailure) {
    const code = errorCodeFrom(err);
    const message = rpcFailureMessage(err);
    const text = message ? `${code}: ${message}` : code;
    return {
      content: [{ type: "text", text }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: "internal" }],
    isError: true,
  };
}

export function registerTools(mcp: McpServer, deps: RuntimeSocketIoDeps): void {
  registerCuratedTools(mcp, deps);
  registerListMethods(mcp, deps);
  registerCallMethod(mcp, deps);
}

function registerCuratedTools(mcp: McpServer, deps: RuntimeSocketIoDeps): void {
  mcp.tool("cp_list", {
    description: "List all registered charge points",
    inputSchema: z.object({}),
    handler: async () => {
      try {
        const result = await runRpc(deps, {
          method: "cp.list",
          params: {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  // #284: derived from `cp.create`'s own schema rather than restating a
  // subset of it. The hand-written copy declared eight of the eighteen
  // fields, and because unknown properties are stripped rather than refused,
  // the two failure modes were both silent-ish: a SOAP charge point could not
  // be created at all (its companions vanished and the create then failed
  // `invalid_params`), and `securityProfile` / `authorizationKey` were
  // dropped while the tool answered success -- the station came up
  // authenticating differently from what the agent asked for.
  //
  // `autoConnect` used to be re-added here because the handler honoured it
  // while no schema declared it; it now lives on `createParamsSchema`, so
  // there is nothing left for this tool to add.
  mcp.tool("cp_create", {
    description:
      "Create and register a new charge point. Accepts every parameter the cp.create RPC method does, including the SOAP fields (centralSystemUrl, soapPath, soapCallbackUrl) and the OCPP 1.6 security profile fields (securityProfile, authorizationKey, tls*). It stays disconnected until cp_connect is called (or pass autoConnect: true).",
    inputSchema: createParamsSchema,
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.create",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  // Curated tools are registered by hand, so a method added to `METHODS`
  // alone would only be reachable through the generic `call_method` escape
  // hatch. Fleet creation is exactly the operation an agent should find by
  // name, so it gets a tool -- with its schema derived, per #284.
  mcp.tool("cp_create_many", {
    description:
      "Create and register many charge points at once. Every parameter except the id is shared by the batch; ids come from idPattern ({n}, or {n:03} to zero-pad), starting at startIndex (default 1). Returns the ids created and, separately, the ones that failed with the reason -- a partial batch is a normal result, not an error.",
    inputSchema: createManyParamsSchema,
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.create_many",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("cp_delete", {
    description: "Delete a charge point",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier to delete"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          method: "cp.delete",
          params: args,
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("cp_connect", {
    description: "Connect a charge point to the central system",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "connect",
          params: {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("cp_disconnect", {
    description: "Disconnect a charge point from the central system",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "disconnect",
          params: {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("cp_status", {
    description: "Get the status of a charge point",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "status",
          params: {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("start_transaction", {
    description: "Start a transaction on a connector",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z.number().int().min(1).describe("Connector identifier"),
      tagId: z.string().describe("RFID tag or user ID for authorization"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "start_transaction",
          params: {
            connector: args.connector,
            tagId: args.tagId,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("stop_transaction", {
    description: "Stop a transaction on a connector",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z.number().int().min(1).describe("Connector identifier"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "stop_transaction",
          params: {
            connector: args.connector,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("authorize", {
    description: "Authorize a tag or user",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      tagId: z.string().describe("RFID tag or user ID to authorize"),
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "authorize",
          params: {
            tagId: args.tagId,
          },
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("set_connector_status", {
    description: "Update the status of a connector",
    inputSchema: z.object({
      cpId: z.string().describe("Charge point identifier"),
      connector: z
        .number()
        .int()
        .min(0)
        .describe("Connector identifier (0 for all)"),
      status: z
        .string()
        .describe("Connector status (e.g., Available, Occupied, Faulted)"),
      errorCode: z
        .string()
        .optional()
        .describe("Optional error code if status is Faulted"),
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
          },
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
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "send_meter_value",
          params: {
            connector: args.connector,
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
    }),
    handler: async (args) => {
      try {
        const result = await runRpc(deps, {
          cpId: args.cpId,
          method: "run_scenario_template",
          params: {
            connector: args.connector,
            templateId: args.templateId,
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
