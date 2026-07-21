import { describe, it, expect, vi, afterEach } from "vitest";
import { parseScenarioJSON, withScenarioSchemaVersion } from "../scenarioFile";
import {
  SCENARIO_SCHEMA_VERSION,
  type ScenarioDefinition,
} from "../../cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "../../scenario/scenarioSchemaValidator";

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

  it("accepts an empty nodes array", () => {
    const scenario = createValidScenario({ nodes: [] });
    const result = parseScenarioJSON(JSON.stringify(scenario));
    expect(result.nodes).toHaveLength(0);
  });

  it("accepts an empty edges array", () => {
    const scenario = createValidScenario({ edges: [] });
    const result = parseScenarioJSON(JSON.stringify(scenario));
    expect(result.edges).toHaveLength(0);
  });

  it("rejects non-array nodes/edges (truthiness alone would accept these)", () => {
    expect(() =>
      parseScenarioJSON(
        JSON.stringify(createValidScenario({ nodes: {} as never })),
      ),
    ).toThrow("Invalid scenario file format");
    expect(() =>
      parseScenarioJSON(
        JSON.stringify(createValidScenario({ edges: "invalid" as never })),
      ),
    ).toThrow("Invalid scenario file format");
  });

  it("rejects an empty-string id", () => {
    expect(() =>
      parseScenarioJSON(JSON.stringify(createValidScenario({ id: "" }))),
    ).toThrow("Invalid scenario file format");
  });

  it("rejects non-object top-level JSON (null / array / scalar)", () => {
    expect(() => parseScenarioJSON("null")).toThrow(
      "Invalid scenario file format",
    );
    expect(() => parseScenarioJSON("[]")).toThrow(
      "Invalid scenario file format",
    );
    expect(() => parseScenarioJSON("42")).toThrow(
      "Invalid scenario file format",
    );
  });

  describe("schema validation (issue #214, advisory only)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("warns via console.warn on a schema mismatch but still returns the scenario", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // delaySeconds must be a number per schema/scenario.schema.json; this
      // scenario is structurally valid (passes the existing guard above) but
      // schema-invalid.
      const scenario = createValidScenario({
        nodes: [
          {
            id: "wait",
            type: "delay",
            position: { x: 0, y: 0 },
            data: { label: "Wait", delaySeconds: "not-a-number" as never },
          },
        ],
      });

      const result = parseScenarioJSON(JSON.stringify(scenario));

      expect(result.id).toBe("test-scenario");
      expect(result.nodes).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("schema/scenario.schema.json");
    });

    it("does not warn for a schema-valid scenario", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      parseScenarioJSON(JSON.stringify(createValidScenario()));
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe("withScenarioSchemaVersion", () => {
  const createValidScenario = (
    overrides: Partial<ScenarioDefinition> = {},
  ): ScenarioDefinition => ({
    id: "test-scenario",
    name: "Test Scenario",
    targetType: "connector" as const,
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
    edges: [{ id: "e-start-end", source: "start", target: "end" }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });

  it("stamps SCENARIO_SCHEMA_VERSION without mutating the input", () => {
    const scenario = createValidScenario();
    const stamped = withScenarioSchemaVersion(scenario);

    expect(stamped.schemaVersion).toBe(SCENARIO_SCHEMA_VERSION);
    expect(scenario.schemaVersion).toBeUndefined();
  });

  it("produces a scenario that still validates against schema/scenario.schema.json", () => {
    const stamped = withScenarioSchemaVersion(createValidScenario());
    const result = validateScenarioSchema(stamped);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
