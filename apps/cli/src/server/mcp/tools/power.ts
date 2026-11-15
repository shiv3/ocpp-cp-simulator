import { z } from "zod";
import type { McpServer } from "mcp-lite";
import { METHODS } from "@ocpp-cp-simulator/contracts/index";
import { runRpc } from "../../socketServer";
import type { RuntimeSocketIoDeps } from "../../socketServer";
import { successResult, errorResult } from "./result";

export function registerPowerTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
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
