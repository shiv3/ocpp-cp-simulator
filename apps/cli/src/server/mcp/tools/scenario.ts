import { z } from "zod";
import type { McpServer } from "mcp-lite";
import { runRpc } from "../../socketServer";
import type { RuntimeSocketIoDeps } from "../../socketServer";
import { scenarioWaitExtensionSecondsSchema } from "@ocpp-cp-simulator/contracts/index";
import { successResult, errorResult } from "./result";

export function registerScenarioTools(
  mcp: McpServer,
  deps: RuntimeSocketIoDeps,
): void {
  mcp.tool("scenario_templates", {
    description:
      "List available scenario templates with their OCPP versions, what the CSMS must do for the intended path (csmsExpectations: calls to send with example payloads, answers to give, simulator steps) and the assertions each run is judged by",
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
}
