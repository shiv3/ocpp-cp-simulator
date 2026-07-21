import { describe, it, expect } from "vitest";
import { validateScenarioSchema } from "../scenarioSchemaValidator";

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
});
