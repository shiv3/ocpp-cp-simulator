import { describe, expect, it } from "vitest";
import { validateScenarioSchema } from "../scenarioSchemaValidator";

// Schema 1.9: the parallel and join nodes validate; the schema stays strict
// on `mode` and permissive on unknown keys, like the rest of the contract.

const base = (nodes: unknown[], edges: unknown[] = []) => ({
  schemaVersion: "1.9",
  id: "s",
  name: "s",
  targetType: "connector",
  targetId: 1,
  nodes: [
    {
      id: "start",
      type: "start",
      position: { x: 0, y: 0 },
      data: { label: "Start" },
    },
    ...nodes,
  ],
  edges,
});
const node = (type: string, data: Record<string, unknown>) => ({
  id: "n",
  type,
  position: { x: 0, y: 0 },
  data: { label: type, ...data },
});

describe("schema 1.9 parallel / join nodes", () => {
  it.each([
    ["parallel", {}],
    ["parallel", { somethingElse: 1 }],
    ["join", {}],
    ["join", { mode: "all" }],
    ["join", { mode: "any", note: "extra keys are fine" }],
  ])("accepts %s %j", (type, data) => {
    expect(validateScenarioSchema(base([node(type, data)])).errors).toEqual([]);
  });

  it.each([
    ["join", { mode: "bogus" }],
    ["join", { mode: 1 }],
  ])("rejects %s %j", (type, data) => {
    expect(
      validateScenarioSchema(base([node(type, data)])).errors.join(" "),
    ).toContain("mode");
  });

  it("accepts a timeout edge next to them", () => {
    const def = base(
      [node("parallel", {})],
      [{ id: "e", source: "start", target: "n", kind: "timeout" }],
    );
    expect(validateScenarioSchema(def).errors).toEqual([]);
  });
});
