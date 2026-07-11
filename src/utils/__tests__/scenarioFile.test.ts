import { describe, it, expect } from "vitest";
import { parseScenarioJSON } from "../scenarioFile";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";

describe("parseScenarioJSON", () => {
  const createValidScenario = (
    overrides: Partial<ScenarioDefinition> = {},
  ): ScenarioDefinition => ({
    id: "test-scenario",
    name: "Test Scenario",
    description: "A test scenario",
    targetType: "connector" as const,
    targetId: 1,
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
    edges: [
      {
        id: "e-start-end",
        source: "start",
        target: "end",
      },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    trigger: { type: "manual" as const },
    defaultExecutionMode: "oneshot" as const,
    enabled: true,
    ...overrides,
  });

  it("parses a valid scenario JSON", () => {
    const scenario = createValidScenario();
    const json = JSON.stringify(scenario);
    const result = parseScenarioJSON(json);
    expect(result.id).toBe("test-scenario");
    expect(result.name).toBe("Test Scenario");
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
  });

  it("throws on missing id", () => {
    const scenario = createValidScenario({ id: undefined });
    const json = JSON.stringify(scenario);
    expect(() => parseScenarioJSON(json)).toThrow(
      "Invalid scenario file format",
    );
  });

  it("throws on missing nodes", () => {
    const scenario = createValidScenario({ nodes: undefined });
    const json = JSON.stringify(scenario);
    expect(() => parseScenarioJSON(json)).toThrow(
      "Invalid scenario file format",
    );
  });

  it("throws on missing edges", () => {
    const scenario = createValidScenario({ edges: undefined });
    const json = JSON.stringify(scenario);
    expect(() => parseScenarioJSON(json)).toThrow(
      "Invalid scenario file format",
    );
  });

  it("throws on invalid JSON", () => {
    const invalidJson = "{ invalid json }";
    expect(() => parseScenarioJSON(invalidJson)).toThrow();
  });

  it("throws on empty nodes array", () => {
    const scenario = createValidScenario({ nodes: [] });
    // Note: empty array is truthy, so this should NOT throw
    const json = JSON.stringify(scenario);
    const result = parseScenarioJSON(json);
    expect(result.nodes).toHaveLength(0);
  });

  it("throws on empty edges array", () => {
    const scenario = createValidScenario({ edges: [] });
    // Note: empty array is truthy, so this should NOT throw
    const json = JSON.stringify(scenario);
    const result = parseScenarioJSON(json);
    expect(result.edges).toHaveLength(0);
  });
});
