import { describe, expect, it } from "bun:test";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createRuntimeDeps, runRpc } from "../socketServer";
import { createMcpHandler } from "../mcp/mcpServer";

/** #455: power.loss / power.restore on a real daemon runtime, over RPC and MCP. */
const CP_ID = "CPPOWER";

function setup() {
  const bus = new EventBus();
  const registry = new CPRegistry(bus, null);
  const deps = createRuntimeDeps({ registry, bus });
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
  return { deps, registry };
}

describe("power.loss / power.restore (#455)", () => {
  it("answers the state errors and records both ends on the timeline", async () => {
    const { deps, registry } = setup();
    try {
      expect(
        await runRpc(deps, {
          method: "power.restore",
          params: { cpId: CP_ID },
        }),
      ).toEqual({ ok: false, error: "not_powered_off" });
      expect(
        await runRpc(deps, { method: "power.loss", params: { cpId: "nope" } }),
      ).toEqual({ ok: false, error: "cp_not_found" });

      expect(
        await runRpc(deps, { method: "power.loss", params: { cpId: CP_ID } }),
      ).toEqual({ ok: true, transactions: 0 });
      expect(
        await runRpc(deps, { method: "power.loss", params: { cpId: CP_ID } }),
      ).toEqual({ ok: false, error: "already_powered_off" });

      const restored = await runRpc(deps, {
        method: "power.restore",
        params: { cpId: CP_ID },
      });
      expect(restored).toMatchObject({
        ok: true,
        recovery: "none",
        transactions: 0,
      });

      const timeline = (await runRpc(deps, {
        method: "timeline.get",
        params: { cpId: CP_ID, kinds: ["power_lost", "power_restored"] },
      })) as { entries: { kind: string }[] };
      expect(timeline.entries.map((e) => e.kind)).toEqual([
        "power_lost",
        "power_restored",
      ]);
    } finally {
      registry.remove(CP_ID);
    }
  });

  it("restoreAfterMs brings the power back by itself", async () => {
    const { deps, registry } = setup();
    try {
      await runRpc(deps, {
        method: "power.loss",
        params: { cpId: CP_ID, restoreAfterMs: 30 },
      });
      expect(registry.get(CP_ID)?.poweredOff).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(registry.get(CP_ID)?.poweredOff).toBe(false);
    } finally {
      registry.remove(CP_ID);
    }
  });

  it("is available as MCP tools", async () => {
    const { deps, registry } = setup();
    try {
      const handler = createMcpHandler(deps);
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
            params: { name: "power_loss", arguments: { cpId: CP_ID } },
          }),
        }),
      );
      const text = await response.text();
      expect(text).toContain("transactions");
    } finally {
      registry.remove(CP_ID);
    }
  });
});
