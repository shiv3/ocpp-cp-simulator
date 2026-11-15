import { z } from "zod";
import type { McpServer } from "mcp-lite";
import { behaviorReloadParamsSchema } from "@ocpp-cp-simulator/contracts/index";
import { runRpc } from "../../socketServer";
import type { RuntimeSocketIoDeps } from "../../socketServer";
import { successResult, errorResult } from "./result";

export function registerBehaviorTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
  mcp.tool("behavior_list", {
    description:
      "List the behaviors the daemon loaded at start (--behavior) with the file each came from, whether --watch-behaviors is on, and the built-in default behaviors with the CSMS actions each answers (the actions that mode extend works for). A behavior that has params also reports its params schema and defaults.",
    inputSchema: z.object({}).strict(),
    handler: async () => {
      try {
        const result = await runRpc(deps, {
          method: "behavior.list",
          params: {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  mcp.tool("behavior_reload", {
    description:
      "Re-read the behavior files the daemon was started with and apply the changed ones: new calls use the new code, exchanges in flight finish on the old one, ctx.state stays; a file that does not build keeps the old version. Takes no parameters: no path and no code can be supplied.",
    inputSchema: behaviorReloadParamsSchema,
    handler: async () => {
      try {
        const result = await runRpc(deps, {
          method: "behavior.reload",
          params: {},
        });
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
