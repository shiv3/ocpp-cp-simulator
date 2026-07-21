import { describe, expect, it, beforeEach } from "vitest";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createRuntimeDeps } from "../socketServer";
import { createMcpHandler } from "../mcp/mcpServer";
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

function getToolsList(
  response: unknown,
): Array<Record<string, unknown>> | undefined {
  if (response && typeof response === "object" && "result" in response) {
    const result = (response as Record<string, unknown>).result;
    if (result && typeof result === "object" && "tools" in result) {
      return (result as Record<string, unknown>).tools as Array<
        Record<string, unknown>
      >;
    }
  }
  return undefined;
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

describe("MCP server", () => {
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
    handler = createMcpHandler(deps);
  });

  it("handles initialize handshake", async () => {
    const response = await callMcp(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "test-client",
          version: "1.0.0",
        },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      result: {
        serverInfo: {
          name: "ocpp-cp-simulator",
        },
      },
    });
  });

  it("handles initialized notification", async () => {
    const reqObj = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });

    const response = await handler(reqObj);
    expect([200, 202]).toContain(response.status);
  });

  it("lists all curated tools", async () => {
    const response = await callMcp(handler, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const toolNames = new Set<unknown>();
    const toolsList = getToolsList(response);
    if (toolsList) {
      toolsList.forEach((tool: Record<string, unknown>) => {
        toolNames.add(tool.name);
      });
    }

    const expected = [
      "cp_list",
      "cp_create",
      "cp_delete",
      "cp_connect",
      "cp_disconnect",
      "cp_status",
      "start_transaction",
      "stop_transaction",
      "authorize",
      "set_connector_status",
      "set_meter_value",
      "send_meter_value",
      "scenario_templates",
      "run_scenario_template",
      "scenario_status",
      "get_logs",
      "list_methods",
      "call_method",
    ];

    expected.forEach((name) => {
      expect(toolNames).toContain(name);
    });

    toolNames.forEach((name) => {
      const toolsList2 = getToolsList(response);
      if (toolsList2) {
        const tool = toolsList2.find(
          (t: Record<string, unknown>) => t.name === name,
        );
        expect(tool?.inputSchema).toEqual(
          expect.objectContaining({ type: "object" }),
        );
      }
    });
  });

  it("tools/call cp_list returns empty array", async () => {
    const response = await callMcp(handler, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "cp_list",
        arguments: {},
      },
    });

    const text = getToolContent(response);
    expect(text).toBeDefined();
    if (text) {
      const parsed = JSON.parse(text);
      expect(parsed).toEqual([]);
    }
  });

  it("call_method with cp.list returns empty array", async () => {
    const response = await callMcp(handler, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "call_method",
        arguments: {
          method: "cp.list",
        },
      },
    });

    const text = getToolContent(response);
    expect(text).toBeDefined();
    if (text) {
      const parsed = JSON.parse(text);
      expect(parsed).toEqual([]);
    }
  });

  it("call_method with unknown method returns error", async () => {
    const response = await callMcp(handler, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "call_method",
        arguments: {
          method: "nope",
        },
      },
    });

    expect(isToolError(response)).toBe(true);
    const text = getToolContent(response);
    expect(text).toBeDefined();
    if (text) {
      expect(text).toMatch(/not_found/);
    }
  });

  it("call_method with events.subscribe returns error", async () => {
    const response = await callMcp(handler, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "call_method",
        arguments: {
          method: "events.subscribe",
          params: {
            scope: "*",
          },
        },
      },
    });

    expect(isToolError(response)).toBe(true);
    const text = getToolContent(response);
    expect(text).toBeDefined();
    if (text) {
      expect(text).toMatch(/socket/);
    }
  });

  it("list_methods without arguments returns catalog", async () => {
    const response = await callMcp(handler, {
      jsonrpc: "2.0",
      id: 7,
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

      const cpCreateEntry = catalog.find((m) => m.method === "cp.create");
      expect(cpCreateEntry).toBeDefined();

      const startTransactionEntry = catalog.find(
        (m) => m.method === "start_transaction",
      );
      expect(startTransactionEntry).toBeDefined();

      const subscribeEntry = catalog.find(
        (m) => m.method === "events.subscribe",
      );
      expect(subscribeEntry).toBeUndefined();
    }
  });

  it("list_methods with specific method returns paramsSchema", async () => {
    const response = await callMcp(handler, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "list_methods",
        arguments: {
          method: "start_transaction",
        },
      },
    });

    const text = getToolContent(response);
    expect(text).toBeDefined();
    if (text) {
      const info = JSON.parse(text) as Record<string, unknown>;

      expect(info.method).toBe("start_transaction");
      expect(info.paramsSchema).toBeDefined();
      const paramsSchema = info.paramsSchema as Record<string, unknown>;
      const properties = paramsSchema.properties as Record<string, unknown>;
      expect(properties.connector).toBeDefined();
    }
  });

  it("cp_status for unknown CP returns error", async () => {
    const response = await callMcp(handler, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "cp_status",
        arguments: {
          cpId: "unknown-cp",
        },
      },
    });

    expect(isToolError(response)).toBe(true);
    const text = getToolContent(response);
    expect(text).toBeDefined();
    if (text) {
      expect(text).toMatch(/not_found/);
    }
  });
});
