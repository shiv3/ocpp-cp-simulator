import { describe, expect, it } from "vitest";

import { SCENARIO_ID_MAX } from "@ocpp-cp-simulator/contracts/limits";
import {
  assertLoadableScenario,
  checkLoadableScenario,
  validateLoadableScenario,
} from "../loadableScenario";

const complete = () => ({
  id: "s1",
  name: "One",
  targetType: "connector",
  nodes: [],
  edges: [],
});

/** What the browser's import accepted before the gates were unified. */
const browserAccepted = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    Array.isArray(v.nodes) &&
    Array.isArray(v.edges)
  );
};

describe("checkLoadableScenario", () => {
  it("passes a complete definition through untouched", () => {
    const def = complete();
    const check = checkLoadableScenario(def);
    expect(check).toEqual({ definition: def, errors: [], diagnostics: [] });
    expect(check.definition).toBe(def);
  });

  it("fills in a missing or wrong name and targetType, reported as info", () => {
    const def = {
      id: "s1",
      name: 42,
      targetType: "station",
      nodes: [],
      edges: [],
    };
    const check = checkLoadableScenario(def);
    expect(check.errors).toEqual([]);
    expect(check.definition).toMatchObject({
      id: "s1",
      name: "s1",
      targetType: "connector",
    });
    expect(check.diagnostics).toEqual([
      { code: "defaultName", severity: "info", data: { was: 42 } },
      { code: "defaultTargetType", severity: "info", data: { was: "station" } },
    ]);
    // The input is not mutated.
    expect(def.name).toBe(42);
    expect(
      checkLoadableScenario({ id: "s1", nodes: [], edges: [] }).definition,
    ).toMatchObject({ name: "s1", targetType: "connector" });
  });

  it("rejects what nothing can load", () => {
    expect(checkLoadableScenario(null).errors).toEqual([
      "scenario must be an object",
    ]);
    expect(checkLoadableScenario({ nodes: {}, id: "" }).errors).toEqual([
      'scenario is missing required field "edges"',
      'scenario "id" must be a non-empty string',
      'scenario "nodes" must be an array',
    ]);
  });

  it("accepts every value the browser accepted, and only those", () => {
    const values: unknown[] = [
      null,
      [],
      "x",
      complete(),
      { id: "  ", nodes: [], edges: [] },
      { id: "x".repeat(SCENARIO_ID_MAX + 1), nodes: [], edges: [] },
      { id: "", nodes: [], edges: [] },
      { id: 5, nodes: [], edges: [] },
      { id: "a", nodes: {}, edges: [] },
      { id: "a", nodes: [] },
      { id: "a", nodes: [], edges: [], targetType: null, name: null },
    ];
    for (const value of values) {
      expect(
        checkLoadableScenario(value).definition !== null,
        JSON.stringify(value),
      ).toBe(browserAccepted(value));
    }
  });
});

describe("validateLoadableScenario / assertLoadableScenario (the daemon's gate)", () => {
  it("accepts what it accepted before, now also without name / targetType", () => {
    expect(validateLoadableScenario(complete()).valid).toBe(true);
    const advisories: string[] = [];
    const def = assertLoadableScenario(
      { id: "s1", nodes: [], edges: [] },
      (m) => advisories.push(m),
    );
    expect(def).toMatchObject({ name: "s1", targetType: "connector" });
    expect(advisories).toEqual([
      'scenario has no "name"; using the id',
      'scenario has no "targetType"; using "connector"',
    ]);
  });

  it("still refuses an id the control plane cannot address", () => {
    expect(validateLoadableScenario({ ...complete(), id: "  " })).toEqual({
      valid: false,
      errors: ['scenario "id" must be a non-empty string'],
      definition: null,
      diagnostics: [],
    });
    expect(() =>
      assertLoadableScenario({
        id: "x".repeat(SCENARIO_ID_MAX + 1),
        nodes: [],
        edges: [],
      }),
    ).toThrow(
      `Invalid scenario: scenario "id" must be at most ${SCENARIO_ID_MAX} characters`,
    );
  });

  it("describes a wrong value it replaced", () => {
    const advisories: string[] = [];
    assertLoadableScenario(
      { ...complete(), name: 42, targetType: "station" },
      (m) => advisories.push(m),
    );
    expect(advisories).toEqual([
      'scenario "name" 42 is not a string; using the id',
      'scenario "targetType" "station" is not one of "chargePoint" | "connector"; using "connector"',
    ]);
  });

  it("keeps its messages for unloadable input", () => {
    expect(() => assertLoadableScenario({})).toThrow(
      'Invalid scenario: scenario is missing required field "id"; scenario is missing required field "nodes"; scenario is missing required field "edges"',
    );
    expect(() => assertLoadableScenario(42)).toThrow(
      "Invalid scenario: scenario must be an object",
    );
  });
});
