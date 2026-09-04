import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createMcpHandler } from "../mcp/mcpServer";
import { createRuntimeDeps } from "../socketServer";
import {
  createManyToolSchema,
  createParamsSchema,
  METHODS,
} from "../../../protocol";
import type { RpcMethod } from "../../../protocol";

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

type ListedTool = {
  name: string;
  inputSchema: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

/** `tools/list` against a freshly-registered, empty registry. */
async function fetchToolsList(): Promise<ListedTool[]> {
  const bus = new EventBus();
  const deps = createRuntimeDeps({ registry: new CPRegistry(bus), bus });
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
  return (JSON.parse(line) as { result: { tools: ListedTool[] } }).result.tools;
}

async function toolInputSchema(name: string): Promise<{
  properties: Record<string, unknown>;
  required: string[];
}> {
  const tools = await fetchToolsList();
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

/** Every curated tool name the MCP endpoint currently advertises. */
async function listToolNames(): Promise<string[]> {
  return (await fetchToolsList()).map((t) => t.name);
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
      (createManyToolSchema as unknown as z.ZodObject<z.ZodRawShape>).shape,
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
    for (const field of ["count", "idPattern", "startIndex", "blueprintId"]) {
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

/**
 * General guard against #284/#299-class drift: a curated tool that hand-
 * copies a subset of its method's fields (rather than deriving its schema,
 * like `cp_create` does) silently gets left behind when the method gains an
 * optional field, or over-tightens a field the method later made optional.
 * Either failure mode is silent to a human reading `tools.ts` alone — an
 * omitted optional field is stripped from the call by zod, and an
 * over-required field is rejected by mcp-lite before the handler (and the
 * RPC method underneath) ever sees it.
 *
 * This does NOT compare full JSON Schema shape (as the cp_create tests
 * above do): the curated tools intentionally write friendlier `.describe()`
 * text than the bare `STR_64K` / `CONN_POS` primitives in `methods.ts`, and
 * several deliberately drop the method's DoS-bound `maxLength` (harmless,
 * since `runRpc` re-validates every call against `METHODS[method].params`
 * regardless of what the tool's own schema let through — see
 * docs/entities/mcp-endpoint.md). What must never drift is (a) which fields
 * exist, and (b) which of them are required — that's the class of bug both
 * issues were about, and what mutating either back reproduces here.
 */
function methodInputSchema(name: RpcMethod): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const json = z.toJSONSchema(METHODS[name].params) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    properties: json.properties ?? {},
    required: (json.required ?? []).slice().sort(),
  };
}

/** Fields the tool exposes that the method doesn't (cpId is always fine here: every tool declares it, and it is either forwarded as the top-level `cpId` the RPC dispatcher routes on, or -- for the explicit methods below -- is part of the method's own params too, in which case it is already covered by the presence check.) */
const ALWAYS_IGNORED_EXTRA_TOOL_FIELDS = new Set(["cpId"]);

async function assertToolNotNarrowerThanMethod(
  tool: string,
  method: RpcMethod,
) {
  const canonical = methodInputSchema(method);
  const advertised = await toolInputSchema(tool);

  // Every field the method accepts must be reachable through the tool, or
  // an agent's value for it is silently stripped before the call is made.
  const missingFields = Object.keys(canonical.properties).filter(
    (field) => !(field in advertised.properties),
  );
  expect(missingFields).toEqual([]);

  // A field the method requires must stay required in the tool (a tool that
  // quietly defaults it would mask a mistake the method wants surfaced).
  const advertisedRequired = new Set(advertised.required);
  const droppedRequired = canonical.required.filter(
    (field) => !advertisedRequired.has(field),
  );
  expect(droppedRequired).toEqual([]);

  // A field the method leaves optional must not be required by the tool --
  // this is exactly the #299 bug: `tagId` was optional on the method and
  // required on the tool, so the tool rejected the call before the method's
  // idTagPool fallback was ever consulted.
  const canonicalRequired = new Set(canonical.required);
  const overRequired = advertised.required.filter(
    (field) =>
      field in canonical.properties &&
      !canonicalRequired.has(field) &&
      !ALWAYS_IGNORED_EXTRA_TOOL_FIELDS.has(field),
  );
  expect(overRequired).toEqual([]);
}

describe("MCP curated tool schema parity (general, #299)", () => {
  // One-to-one tools: the tool wraps exactly one method and (cpId aside)
  // shares its field names. Covers every curated tool except:
  //   - cp_create / cp_create_many: field-level parity tested above.
  //   - network_sim_get / network_sim_set: each dispatches to one of TWO
  //     methods depending on whether `cpId` is given; targeted assertions
  //     follow this block instead.
  //   - call_method / list_methods: generic by design -- accepting any
  //     method/params is the point, so there is no fixed method to drift
  //     from.
  const oneToOneCases: ReadonlyArray<{ tool: string; method: RpcMethod }> = [
    { tool: "cp_list", method: "cp.list" },
    { tool: "blueprint_list", method: "blueprint.list" },
    { tool: "blueprint_save", method: "blueprint.save" },
    { tool: "cp_delete", method: "cp.delete" },
    { tool: "cp_connect", method: "connect" },
    { tool: "cp_disconnect", method: "disconnect" },
    { tool: "cp_status", method: "status" },
    { tool: "start_transaction", method: "start_transaction" },
    { tool: "stop_transaction", method: "stop_transaction" },
    { tool: "authorize", method: "authorize" },
    { tool: "set_connector_status", method: "update_connector_status" },
    { tool: "set_meter_value", method: "set_meter_value" },
    { tool: "send_meter_value", method: "send_meter_value" },
    { tool: "scenario_templates", method: "scenario.templates" },
    { tool: "run_scenario_template", method: "run_scenario_template" },
    { tool: "scenario_status", method: "scenario_status" },
    { tool: "get_logs", method: "logs.get" },
    {
      tool: "network_sim_trigger_disconnect",
      method: "network_sim.disconnect.trigger",
    },
  ];

  for (const { tool, method } of oneToOneCases) {
    it(`${tool} is not narrower than ${method}`, async () => {
      await assertToolNotNarrowerThanMethod(tool, method);
    });
  }

  // The list above is what makes this "general": a new hand-written curated
  // tool that isn't added to it (or to one of the other exemptions) would
  // otherwise drift in total silence, the same way `tools.ts` itself did
  // before this file existed. This is the check that closes that gap.
  it("covers every curated tool with either a parity case or a named exemption", async () => {
    const exempt = new Set([
      "cp_create",
      "cp_create_many",
      "network_sim_get",
      "network_sim_set",
      "call_method",
      "list_methods",
    ]);
    const covered = new Set([...oneToOneCases.map((c) => c.tool), ...exempt]);

    const allTools = await listToolNames();
    const uncovered = allTools.filter((name) => !covered.has(name));
    expect(uncovered).toEqual([]);
  });

  // network_sim_get / network_sim_set pick between a global and a per-CP
  // method depending on whether `cpId` is given, so no single `method`
  // applies -- assert against both by name instead of the generic helper.
  it("network_sim_get is not narrower than either network_sim method it dispatches to", async () => {
    const advertised = await toolInputSchema("network_sim_get");
    for (const method of [
      "network_sim.global.get",
      "network_sim.cp.get",
    ] as const) {
      const canonical = methodInputSchema(method);
      for (const field of Object.keys(canonical.properties)) {
        expect(advertised.properties).toHaveProperty(field);
      }
    }
  });

  it("network_sim_set is not narrower than either network_sim method it dispatches to", async () => {
    const advertised = await toolInputSchema("network_sim_set");
    for (const method of [
      "network_sim.global.save",
      "network_sim.cp.save",
    ] as const) {
      const canonical = methodInputSchema(method);
      for (const field of Object.keys(canonical.properties)) {
        expect(advertised.properties).toHaveProperty(field);
      }
    }
    // `cpId?` is what picks between the global and per-CP method (present ->
    // `network_sim.cp.save`, absent -> `network_sim.global.save`), so it
    // must stay optional on the tool -- the #299-style drift this would
    // catch is the tool quietly requiring it and losing the global case.
    expect(advertised.required).not.toContain("cpId");
  });

  // `cp_create_many`'s inputSchema is `createManyToolSchema`, not the
  // method's own `createManyFromBlueprintSchema` -- a deliberate difference,
  // not drift. The method wraps the tool's exact object shape in `.refine()`
  // to require "wsUrl or blueprintId", a cross-field rule the tool leaves to
  // `runRpc`'s re-validation rather than duplicating; the object's fields are
  // otherwise identical (see `createManyFromBlueprintSchema`'s definition).
  it("cp_create_many intentionally omits cp.create_many's cross-field refinement, not any field", () => {
    // In zod v4, `.refine()` on an object schema adds a check in place
    // rather than wrapping it in `ZodEffects` -- `createManyFromBlueprintSchema`
    // is still a `ZodObject` and shares `createManyToolSchema`'s `.shape`
    // directly, so this compares the same field set the JSON-Schema-based
    // checks above already exercise.
    expect(
      Object.keys(
        (createManyToolSchema as unknown as z.ZodObject<z.ZodRawShape>).shape,
      ).sort(),
    ).toEqual(
      Object.keys(
        (
          METHODS["cp.create_many"]
            .params as unknown as z.ZodObject<z.ZodRawShape>
        ).shape,
      ).sort(),
    );
  });
});
