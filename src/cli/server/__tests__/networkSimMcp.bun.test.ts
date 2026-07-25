import { describe, expect, it, beforeEach } from "vitest";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createRuntimeDeps } from "../socketServer";
import { createMcpHandler } from "../mcp/mcpServer";
import { NetworkSimManager } from "../NetworkSimManager";
import type { RuntimeSocketIoDeps } from "../socketServer";

function parseJsonRpcMessage(text: string): unknown {
  return JSON.parse(text);
}

async function callMcp(
  handler: (req: Request) => Promise<Response>,
  request: unknown,
): Promise<unknown> {
  const reqObj = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(request),
  });

  const response = await handler(reqObj);
  const responseText = await response.text();
  const contentType = response.headers.get("content-type");

  if (contentType?.includes("application/json")) {
    return parseJsonRpcMessage(responseText);
  }

  if (contentType?.includes("text/event-stream")) {
    const lines = responseText.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        return parseJsonRpcMessage(line.slice(6));
      }
    }
  }

  throw new Error(`Unexpected content type: ${contentType}`);
}

function getToolContent(response: unknown): string | undefined {
  if (response && typeof response === "object" && "result" in response) {
    const result = (response as Record<string, unknown>).result;
    if (result && typeof result === "object" && "content" in result) {
      const content = (result as Record<string, unknown>).content;
      if (Array.isArray(content) && content.length > 0) {
        const item = content[0] as Record<string, unknown>;
        if (typeof item.text === "string") {
          return item.text;
        }
      }
    }
  }
  return undefined;
}

function isToolError(response: unknown): boolean {
  if (response && typeof response === "object" && "result" in response) {
    const result = (response as Record<string, unknown>).result;
    if (result && typeof result === "object" && "isError" in result) {
      return (result as Record<string, unknown>).isError === true;
    }
  }
  return false;
}

describe("network_sim MCP tools", () => {
  let deps: RuntimeSocketIoDeps;
  let handler: (req: Request) => Promise<Response>;

  beforeEach(() => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    deps = createRuntimeDeps({
      registry,
      bus,
      database: null,
    });
    const manager = new NetworkSimManager(null, {
      listLiveWsCpIds: () => registry.liveWsCpIds(),
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "sim_disabled" }),
    });
    registry.setNetworkSimManager(manager);
    handler = createMcpHandler(deps);
  });

  describe("network_sim_get", () => {
    it("with no cpId invokes network_sim.global.get", async () => {
      const response = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "network_sim_get",
          arguments: {},
        },
      });

      const text = getToolContent(response);
      expect(text).toBeDefined();
      if (text) {
        const result = JSON.parse(text) as Record<string, unknown>;
        expect(result.config).toBe(null);
      }
    });

    it("with cpId invokes network_sim.cp.get and returns config and resolved", async () => {
      const response = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "network_sim_get",
          arguments: {
            cpId: "unknown-cp",
          },
        },
      });

      // network_sim.cp.get returns result even for unknown CP; it returns config: null and resolved config
      expect(isToolError(response)).toBe(false);
      const text = getToolContent(response);
      expect(text).toBeDefined();
      if (text) {
        const result = JSON.parse(text) as Record<string, unknown>;
        expect(result.config).toBeDefined();
        expect(result.resolved).toBeDefined();
      }
    });
  });

  describe("network_sim_set", () => {
    it("with no cpId saves global config", async () => {
      const config = {
        enabled: true,
        seed: 12345,
        rules: {
          "latency-rule": {
            type: "latency",
            delayMs: 100,
          },
        },
      };

      const saveResponse = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "network_sim_set",
          arguments: {
            config,
          },
        },
      });

      const saveText = getToolContent(saveResponse);
      expect(saveText).toBeDefined();

      // Verify the config was saved by calling get
      const getResponse = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "network_sim_get",
          arguments: {},
        },
      });

      const getText = getToolContent(getResponse);
      expect(getText).toBeDefined();
      if (getText) {
        const result = JSON.parse(getText) as Record<string, unknown>;
        expect(result.config).toEqual(config);
      }
    });

    it("with null config clears/deletes", async () => {
      // First save a config
      await callMcp(handler, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "network_sim_set",
          arguments: {
            config: {
              enabled: true,
              seed: 54321,
              rules: {},
            },
          },
        },
      });

      // Then delete it with null
      const deleteResponse = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "network_sim_set",
          arguments: {
            config: null,
          },
        },
      });

      expect(isToolError(deleteResponse)).toBe(false);

      // Verify it was cleared
      const getResponse = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "network_sim_get",
          arguments: {},
        },
      });

      const getText = getToolContent(getResponse);
      expect(getText).toBeDefined();
      if (getText) {
        const result = JSON.parse(getText) as Record<string, unknown>;
        expect(result.config).toBe(null);
      }
    });
  });

  describe("network_sim_trigger_disconnect", () => {
    it("with unknown CP returns cp_not_found error", async () => {
      const response = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "network_sim_trigger_disconnect",
          arguments: {
            cpId: "unknown-cp",
            ruleId: "rule1",
          },
        },
      });

      const text = getToolContent(response);
      expect(text).toBeDefined();
      if (text) {
        const result = JSON.parse(text) as Record<string, unknown>;
        expect(result.ok).toBe(false);
        expect(result.error).toBe("cp_not_found");
      }
    });
  });

  describe("generic RPC reachability via list_methods and call_method", () => {
    it("list_methods includes all five network_sim.* methods", async () => {
      const response = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "list_methods",
          arguments: {},
        },
      });

      const text = getToolContent(response);
      expect(text).toBeDefined();
      if (text) {
        const catalog = JSON.parse(text) as Array<Record<string, unknown>>;

        const expected = [
          "network_sim.global.get",
          "network_sim.global.save",
          "network_sim.cp.get",
          "network_sim.cp.save",
          "network_sim.disconnect.trigger",
        ];

        expected.forEach((method) => {
          const entry = catalog.find((m) => m.method === method);
          expect(entry).toBeDefined();
        });
      }
    });

    it("call_method can invoke network_sim.global.get", async () => {
      const response = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "call_method",
          arguments: {
            method: "network_sim.global.get",
          },
        },
      });

      expect(isToolError(response)).toBe(false);
      const text = getToolContent(response);
      expect(text).toBeDefined();
      if (text) {
        const result = JSON.parse(text) as Record<string, unknown>;
        expect(result.config).toBe(null);
      }
    });

    it("call_method can invoke network_sim.global.save with valid config", async () => {
      const config = {
        enabled: true,
        seed: 11111,
        rules: {},
      };

      const response = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "call_method",
          arguments: {
            method: "network_sim.global.save",
            params: { config },
          },
        },
      });

      expect(isToolError(response)).toBe(false);
      const text = getToolContent(response);
      expect(text).toBeDefined();
    });

    it("call_method can invoke network_sim.cp.get with cpId and returns config and resolved", async () => {
      const response = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "call_method",
          arguments: {
            method: "network_sim.cp.get",
            params: { cpId: "unknown-cp" },
          },
        },
      });

      // network_sim.cp.get returns result even for unknown CP
      expect(isToolError(response)).toBe(false);
      const text = getToolContent(response);
      expect(text).toBeDefined();
      if (text) {
        const result = JSON.parse(text) as Record<string, unknown>;
        expect(result.config).toBeDefined();
        expect(result.resolved).toBeDefined();
      }
    });

    it("call_method can invoke network_sim.cp.save with cpId and valid config", async () => {
      const config = {
        enabled: true,
        seed: 22222,
        rules: {},
      };

      const response = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "call_method",
          arguments: {
            method: "network_sim.cp.save",
            params: { cpId: "unknown-cp", config },
          },
        },
      });

      expect(isToolError(response)).toBe(false);
      const text = getToolContent(response);
      expect(text).toBeDefined();
    });

    it("call_method can invoke network_sim.disconnect.trigger", async () => {
      const response = await callMcp(handler, {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: {
          name: "call_method",
          arguments: {
            method: "network_sim.disconnect.trigger",
            params: { cpId: "unknown-cp", ruleId: "rule1" },
          },
        },
      });

      const text = getToolContent(response);
      expect(text).toBeDefined();
      if (text) {
        const result = JSON.parse(text) as Record<string, unknown>;
        expect(result.ok).toBe(false);
        expect(result.error).toBe("cp_not_found");
      }
    });
  });
});
