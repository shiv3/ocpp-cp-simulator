import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createMcpHandler } from "../mcp/mcpServer";
import { createRuntimeDeps } from "../socketServer";
import { createParamsSchema } from "../../../protocol";

/**
 * #284 — the typed tool must not be narrower than the method it wraps.
 *
 * `cp_create` declared its own eight-field copy of `cp.create`'s parameters.
 * Unknown properties are stripped rather than refused, so the drift was
 * quiet in both directions: a SOAP charge point could not be created at all,
 * and `securityProfile` / `authorizationKey` were dropped while the call
 * answered success — the station came up authenticating differently from
 * what was asked for.
 *
 * The tool now derives its schema from `createParamsSchema`, and this is the
 * guard that keeps it derived: a field added to `cp.create` and not reachable
 * through the tool fails here rather than in someone's campaign.
 */

async function toolProperties(name: string): Promise<string[]> {
  const deps = createRuntimeDeps({
    registry: new CPRegistry(),
    eventBus: new EventBus(),
  });
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
        method: "tools/list",
        params: {},
      }),
    }),
  );
  const text = await response.text();
  // The transport answers as SSE; the payload is the `data:` line.
  const line = text.match(/^data: (.*)$/m)?.[1] ?? text;
  const tools = (
    JSON.parse(line) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: { properties?: Record<string, unknown> };
        }>;
      };
    }
  ).result.tools;
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`no MCP tool named ${name}`);
  return Object.keys(tool.inputSchema.properties ?? {}).sort();
}

describe("MCP cp_create schema parity (#284)", () => {
  it("exposes every parameter cp.create accepts", async () => {
    const canonical = Object.keys(
      (createParamsSchema as unknown as z.ZodObject<z.ZodRawShape>).shape,
    ).sort();
    const exposed = await toolProperties("cp_create");

    const missing = canonical.filter((key) => !exposed.includes(key));
    expect(missing).toEqual([]);
  });

  it("exposes the SOAP and security-profile fields by name", async () => {
    const exposed = await toolProperties("cp_create");

    // The two groups the issue was opened about: without these an agent can
    // drive OCPP-J only, which is not what this endpoint exists for.
    for (const field of ["centralSystemUrl", "soapPath", "soapCallbackUrl"]) {
      expect(exposed).toContain(field);
    }
    for (const field of [
      "securityProfile",
      "authorizationKey",
      "tlsCaPath",
      "tlsCertPath",
      "tlsKeyPath",
      "tls",
    ]) {
      expect(exposed).toContain(field);
    }
  });

  it("adds only autoConnect, which is the tool's own", async () => {
    const canonical = new Set(
      Object.keys(
        (createParamsSchema as unknown as z.ZodObject<z.ZodRawShape>).shape,
      ),
    );
    const extra = (await toolProperties("cp_create")).filter(
      (key) => !canonical.has(key),
    );

    // A field the tool invents is a field `cp.create` will ignore, so the
    // list is worth pinning rather than leaving open.
    expect(extra).toEqual(["autoConnect"]);
  });
});
