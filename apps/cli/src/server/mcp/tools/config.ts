import { z } from "zod";
import type { McpServer } from "mcp-lite";
import { METHODS } from "@ocpp-cp-simulator/contracts/index";
import { runRpc } from "../../socketServer";
import type { RuntimeSocketIoDeps } from "../../socketServer";
import { successResult, errorResult } from "./result";

export function registerConfigTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
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
}
