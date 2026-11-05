import { describe, expect, it } from "bun:test";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createRuntimeDeps, runRpc } from "../socketServer";
import { createMcpHandler } from "../mcp/mcpServer";
import { parkingScenario } from "../../__tests__/parkingScenario";

/**
 * #240: the curated control_scenario_wait tool routes `action` to the
 * matching wait-control method on a real daemon runtime.
 */
const CP_ID = "CPMCPWAIT";

const scenario = parkingScenario("mcp-wait-controls", { timeout: 60 });

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

async function callTool(
  handler: (req: Request) => Promise<Response>,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const response = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "control_scenario_wait", arguments: args },
      }),
    }),
  );
  const text = await response.text();
  const line = text.match(/^data: (.*)$/m)?.[1] ?? text;
  return (JSON.parse(line) as { result: ToolResult }).result;
}

describe("control_scenario_wait MCP tool (#240)", () => {
  it("extends and then continues a parked run, and reports a stale control", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const deps = createRuntimeDeps({ registry, bus });
    const handler = createMcpHandler(deps);
    registry.create(
      {
        cpId: CP_ID,
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 1,
        vendor: "test",
        model: "test",
        basicAuth: null,
      },
      { seedDefault: false },
    );
    const target = { connector: 1, scenarioId: scenario.id };
    await runRpc(deps, {
      cpId: CP_ID,
      method: "load_scenario",
      params: { connector: 1, scenario },
    });
    await runRpc(deps, {
      cpId: CP_ID,
      method: "run_scenario",
      params: { ...target, awaitArmed: true },
    });

    try {
      const extended = await callTool(handler, {
        cpId: CP_ID,
        ...target,
        action: "extend",
        seconds: 30,
      });
      expect(extended.isError).toBeFalsy();

      const missingSeconds = await callTool(handler, {
        cpId: CP_ID,
        ...target,
        action: "extend",
      });
      expect(missingSeconds.isError).toBe(true);
      expect(missingSeconds.content[0]!.text).toStartWith("invalid_params");

      const continued = await callTool(handler, {
        cpId: CP_ID,
        ...target,
        action: "continue",
      });
      expect(continued.isError).toBeFalsy();
      await new Promise((r) => setTimeout(r, 50));

      const report = (await runRpc(deps, {
        cpId: CP_ID,
        method: "scenario_report",
        params: target,
      })) as { interventions: Array<{ kind: string }> };
      expect(report.interventions.map((i) => i.kind)).toEqual([
        "extend",
        "continue",
      ]);

      const stale = await callTool(handler, {
        cpId: CP_ID,
        ...target,
        action: "retry",
      });
      expect(stale.isError).toBe(true);
      expect(stale.content[0]!.text).toBe(
        `invalid_params: Scenario ${scenario.id} is not running`,
      );
    } finally {
      registry.remove(CP_ID);
    }
  }, 20_000);
});
