import { z } from "zod";
import type { McpServer } from "mcp-lite";
import {
  EXPLICIT_METHODS,
  METHODS,
  RpcFailure,
} from "@ocpp-cp-simulator/contracts/index";
import { runRpc } from "../socketServer";
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
import { registerConnectorTools } from "./tools/connector";
import { registerScenarioTools } from "./tools/scenario";
import { registerLogTools } from "./tools/logs";
import { registerConfigTools } from "./tools/config";
import { registerNetworkTools } from "./tools/network";
import { registerPowerTools } from "./tools/power";

export {
  TAIL_LOGS_DEFAULT_LINES,
  TAIL_LOGS_MAX_LINES,
  tailLogEntries,
} from "./tools/logs";

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
  registerConnectorTools(mcp, deps);
  registerScenarioTools(mcp, deps);
  registerLogTools(mcp, deps);
  registerConfigTools(mcp, deps);
  registerNetworkTools(mcp, deps);
  registerPowerTools(mcp, deps);
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
