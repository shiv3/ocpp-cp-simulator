import { describe, it, expect } from "vitest";
import { validateScenarioSchema } from "../scenarioSchemaValidator";

/** Minimal valid scenario wrapper for #240 wait-node cases; if the file
 *  already has an equivalent builder, reuse that instead. */
function waitNodeScenario(nodes: unknown[]): unknown {
  return {
    schemaVersion: "1.1",
    id: "schema-240",
    name: "schema 240",
    targetType: "connector",
    targetId: 1,
    nodes: [
      {
        id: "start-1",
        type: "start",
        position: { x: 0, y: 0 },
        data: { label: "S" },
      },
      ...nodes,
      {
        id: "end-1",
        type: "end",
        position: { x: 0, y: 9 },
        data: { label: "E" },
      },
    ],
    edges: [],
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:00:00Z",
  };
}

function minimalScenario(): Record<string, unknown> {
  return {
    id: "s1",
    name: "Minimal",
    targetType: "connector",
    nodes: [
      {
        id: "start",
        type: "start",
        position: { x: 0, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "end",
        type: "end",
        position: { x: 0, y: 100 },
        data: { label: "End" },
      },
    ],
    edges: [{ id: "e1", source: "start", target: "end" }],
  };
}

describe("validateScenarioSchema", () => {
  it("accepts a known-good minimal scenario", () => {
    const result = validateScenarioSchema(minimalScenario());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a wrong-typed node data field with an informative error", () => {
    const scenario = minimalScenario();
    (scenario.nodes as Array<{ type: string; data: unknown }>).push({
      type: "delay",
      data: { label: "Wait", delaySeconds: "x" },
    });
    // Give the pushed node the required id/position too.
    const nodes = scenario.nodes as Array<Record<string, unknown>>;
    nodes[2] = {
      id: "wait",
      type: "delay",
      position: { x: 0, y: 200 },
      data: { label: "Wait", delaySeconds: "x" },
    };

    const result = validateScenarioSchema(scenario);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("delaySeconds"))).toBe(true);
  });

  it("accepts an unknown top-level field (additionalProperties: true)", () => {
    const scenario = { ...minimalScenario(), someEditorOnlyField: "xyflow" };
    const result = validateScenarioSchema(scenario);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a scenario missing id", () => {
    const scenario = minimalScenario();
    delete scenario.id;
    const result = validateScenarioSchema(scenario);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("accepts a well-formed assertions array", () => {
    const scenario = {
      ...minimalScenario(),
      assertions: [
        {
          id: "a1",
          type: "ocpp_sent",
          action: "BootNotification",
          direction: "sent",
          occurrence: 1,
        },
        {
          id: "a2",
          type: "message_after",
          before: { action: "Authorize", direction: "sent" },
          after: { action: "StartTransaction" },
        },
      ],
    };
    const result = validateScenarioSchema(scenario);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects an assertion with an unknown type and a wrong-typed field", () => {
    const scenario = {
      ...minimalScenario(),
      assertions: [
        { id: "a1", type: "not_a_real_assertion", occurrence: "many" },
      ],
    };
    const result = validateScenarioSchema(scenario);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("is permissive about unknown fields on nodes, node data, and edges", () => {
    // Real editor exports carry xyflow UI fields (width/selected/style/…) and
    // sometimes un-stripped runtime keys on data — none must trip validation.
    const scenario = minimalScenario();
    const nodes = scenario.nodes as Array<Record<string, unknown>>;
    nodes[0] = {
      ...nodes[0],
      width: 160,
      selected: true,
      data: { label: "Start", progress: 0.5, style: { color: "red" } },
    };
    const edges = scenario.edges as Array<Record<string, unknown>>;
    edges[0] = { ...edges[0], selected: false, animated: true };

    const result = validateScenarioSchema(scenario);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a connectionTrigger node and a csmsCallTrigger payload condition (schema 1.1)", () => {
    const result = validateScenarioSchema(
      waitNodeScenario([
        {
          id: "n1",
          type: "connectionTrigger",
          position: { x: 0, y: 1 },
          data: { label: "w", event: "disconnected", timeout: 0 },
        },
        {
          id: "n2",
          type: "csmsCallTrigger",
          position: { x: 0, y: 2 },
          data: { label: "w2", action: "Reset", payload: { type: "Hard" } },
        },
      ]),
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a connectionTrigger with an unknown event", () => {
    const result = validateScenarioSchema(
      waitNodeScenario([
        {
          id: "n1",
          type: "connectionTrigger",
          position: { x: 0, y: 1 },
          data: { label: "w", event: "rebooted" },
        },
      ]),
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a non-object csmsCallTrigger payload condition", () => {
    const result = validateScenarioSchema(
      waitNodeScenario([
        {
          id: "n1",
          type: "csmsCallTrigger",
          position: { x: 0, y: 1 },
          data: { label: "w", action: "Reset", payload: "Hard" },
        },
      ]),
    );
    expect(result.valid).toBe(false);
  });
});
