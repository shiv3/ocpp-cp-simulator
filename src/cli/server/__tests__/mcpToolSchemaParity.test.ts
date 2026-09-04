import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createMcpHandler } from "../mcp/mcpServer";
import { createRuntimeDeps } from "../socketServer";
import { createManyParamsSchema, createParamsSchema } from "../../../protocol";

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

async function toolInputSchema(name: string): Promise<{
  properties: Record<string, unknown>;
  required: string[];
}> {
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
          inputSchema: {
            properties?: Record<string, unknown>;
            required?: string[];
          };
        }>;
      };
    }
  ).result.tools;
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`no MCP tool named ${name}`);
  return {
    properties: tool.inputSchema.properties ?? {},
    required: (tool.inputSchema.required ?? []).slice().sort(),
  };
}

async function toolProperties(name: string): Promise<string[]> {
  return Object.keys((await toolInputSchema(name)).properties).sort();
}

/** The JSON Schema the tool WOULD advertise for the canonical parameters. */
function canonicalInputSchema(): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const json = z.toJSONSchema(createParamsSchema) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    properties: json.properties ?? {},
    required: (json.required ?? []).slice().sort(),
  };
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

  it("invents nothing of its own", async () => {
    const canonical = new Set(
      Object.keys(
        (createParamsSchema as unknown as z.ZodObject<z.ZodRawShape>).shape,
      ),
    );
    const extra = (await toolProperties("cp_create")).filter(
      (key) => !canonical.has(key),
    );

    // A field the tool invents is a field `cp.create` will ignore, so the
    // list is worth pinning rather than leaving open. It used to hold
    // `autoConnect`, which the handler honoured while no schema declared it;
    // that field now lives on `createParamsSchema`, so the tool adds nothing.
    expect(extra).toEqual([]);
  });

  it("declares autoConnect on the method, not just the tool", () => {
    // The handler has always read `autoConnect` off the raw params. Declaring
    // it means socket.io callers and `list_methods` see it too, instead of
    // it existing only in a hand-written tool schema.
    const shape = (createParamsSchema as unknown as z.ZodObject<z.ZodRawShape>)
      .shape;
    expect(Object.keys(shape)).toContain("autoConnect");
  });
});

describe("MCP cp_create_many schema parity (#295)", () => {
  it("exposes every parameter cp.create_many accepts", async () => {
    const canonical = Object.keys(
      (createManyParamsSchema as unknown as z.ZodObject<z.ZodRawShape>).shape,
    ).sort();
    const exposed = await toolProperties("cp_create_many");

    const missing = canonical.filter((key) => !exposed.includes(key));
    expect(missing).toEqual([]);
  });

  it("shares cp.create's fields but not its cpId", async () => {
    const exposed = await toolProperties("cp_create_many");

    // The batch shares everything but the id, so the SOAP and security
    // fields have to survive the .omit() — the same failure #284 was about,
    // one method along.
    for (const field of [
      "wsUrl",
      "centralSystemUrl",
      "soapPath",
      "securityProfile",
      "authorizationKey",
      "basicAuth",
      "autoConnect",
    ]) {
      expect(exposed).toContain(field);
    }
    for (const field of ["count", "idPattern", "startIndex"]) {
      expect(exposed).toContain(field);
    }
    // `cpId` is generated from `idPattern`; accepting one would be ambiguous.
    expect(exposed).not.toContain("cpId");
  });
});

describe("MCP cp_create field-level parity (#284)", () => {
  // Names alone would pass a field that kept its name and changed type,
  // requiredness or nested shape — which is the drift that produced the
  // silent security-profile drop in the first place, one level down.
  it("advertises each parameter with the schema cp.create declares", async () => {
    const canonical = canonicalInputSchema();
    const advertised = await toolInputSchema("cp_create");

    for (const [field, schema] of Object.entries(canonical.properties)) {
      expect(advertised.properties[field]).toEqual(schema);
    }
  });

  it("keeps the same fields mandatory", async () => {
    const canonical = canonicalInputSchema();
    const advertised = await toolInputSchema("cp_create");

    // autoConnect is optional, so the required sets should be identical.
    expect(advertised.required).toEqual(canonical.required);
  });
});
