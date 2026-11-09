import { describe, it, expect, vi, afterEach } from "vitest";
import { parseScenarioJSON, withScenarioSchemaVersion } from "../scenarioFile";
import {
  SCENARIO_SCHEMA_VERSION,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "@ocpp-cp-simulator/core/scenario/scenarioSchemaValidator";

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

  it("fills in a missing name / targetType like the daemon, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = parseScenarioJSON(
        JSON.stringify(
          createValidScenario({ name: undefined, targetType: undefined }),
        ),
      );
      expect(result.name).toBe("test-scenario");
      expect(result.targetType).toBe("connector");
      const messages = warn.mock.calls.map(([m]) => String(m));
      expect(messages).toContain(
        '[scenarioFile] Imported scenario "test-scenario": scenario has no "name"; using the id',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a present but unknown targetType / non-string name as written, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = parseScenarioJSON(
        JSON.stringify({
          ...createValidScenario(),
          name: 42,
          targetType: "station",
        }),
      );
      expect(result.targetType).toBe("station");
      expect(result.name).toBe(42);
      const messages = warn.mock.calls.map(([m]) => String(m));
      expect(messages).toContain(
        '[scenarioFile] Imported scenario "test-scenario": scenario "targetType" must be one of "chargePoint" | "connector"',
      );
      expect(messages).toContain(
        '[scenarioFile] Imported scenario "test-scenario": scenario "name" must be a string',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("still loads an id the daemon would refuse, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        parseScenarioJSON(JSON.stringify(createValidScenario({ id: "  " }))).id,
      ).toBe("  ");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
      // delaySeconds must be a number per packages/core/schema/scenario.schema.json; this
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
      expect(warnSpy.mock.calls[0][0]).toContain(
        "packages/core/schema/scenario.schema.json",
      );
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

  it("keeps a newer schemaVersion and raises an older one", () => {
    expect(
      withScenarioSchemaVersion(createValidScenario({ schemaVersion: "1.7" }))
        .schemaVersion,
    ).toBe("1.7");
    expect(
      withScenarioSchemaVersion(createValidScenario({ schemaVersion: "2.0" }))
        .schemaVersion,
    ).toBe("2.0");
    for (const old of ["1.0", "1.5", SCENARIO_SCHEMA_VERSION, "garbage"]) {
      expect(
        withScenarioSchemaVersion(createValidScenario({ schemaVersion: old }))
          .schemaVersion,
      ).toBe(SCENARIO_SCHEMA_VERSION);
    }
  });

  it("is at the current v1.7 schema version", () => {
    // Each additive schema version bumps the stamp: the v1.2 evSettings
    // fields (#301) once shipped with the stamp left at "1.1", and a browser
    // export could not be told apart from one written before them. v1.3
    // adds the ocppCall node type (#389), v1.4 the optional libraryId, v1.5 the
    // callResponse and useBehavior nodes and csmsCallTrigger behavior (#566).
    expect(SCENARIO_SCHEMA_VERSION).toBe("1.7");
  });

  it("produces a scenario that still validates against packages/core/schema/scenario.schema.json", () => {
    const stamped = withScenarioSchemaVersion(createValidScenario());
    const result = validateScenarioSchema(stamped);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
