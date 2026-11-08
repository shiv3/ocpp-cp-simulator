import { describe, expect, it } from "vitest";

import { scenarioTemplates } from "../../utils/scenarioTemplates";
import {
  connectionRule,
  validateScenarioGraph,
} from "../scenarioConnectionRules";

const node = (id: string, type = "delay") => ({ id, type });
const edge = (source: string, target: string) => ({
  id: `${source}>${target}`,
  source,
  target,
});
const codes = (def: Parameters<typeof validateScenarioGraph>[0]) =>
  validateScenarioGraph(def).map((i) => i.code);

describe("connectionRule", () => {
  it("START takes no edge in and fans out; END takes none out; the rest leave by one edge", () => {
    expect(connectionRule("start")).toEqual({ maxIn: 0, maxOut: Infinity });
    expect(connectionRule("end")).toEqual({ maxIn: Infinity, maxOut: 0 });
    expect(connectionRule("delay")).toEqual({ maxIn: Infinity, maxOut: 1 });
    expect(connectionRule(undefined)).toEqual({ maxIn: Infinity, maxOut: 1 });
  });
});

describe("validateScenarioGraph", () => {
  it("accepts a chain, a fan-out from START, a loop and a join", () => {
    const nodes = [node("s", "start"), node("a"), node("b"), node("e", "end")];
    expect(
      codes({ nodes, edges: [edge("s", "a"), edge("a", "b"), edge("b", "e")] }),
    ).toEqual([]);
    expect(
      codes({ nodes, edges: [edge("s", "a"), edge("s", "b"), edge("a", "e")] }),
    ).toEqual([]);
    expect(
      codes({ nodes, edges: [edge("s", "a"), edge("a", "b"), edge("b", "a")] }),
    ).toEqual([]);
    expect(
      codes({ nodes, edges: [edge("s", "a"), edge("s", "b"), edge("a", "b")] }),
    ).toEqual([]);
  });

  it("flags a fork anywhere but START: only the first edge runs", () => {
    const issues = validateScenarioGraph({
      nodes: [node("s", "start"), node("a"), node("b"), node("c")],
      edges: [edge("s", "a"), edge("a", "b"), edge("a", "c")],
    });
    expect(issues).toEqual([
      { code: "extraOutgoing", nodeId: "a", severity: "warning" },
    ]);
  });

  it("flags a missing START as an error, and extra STARTs", () => {
    expect(validateScenarioGraph({ nodes: [node("a")], edges: [] })).toEqual([
      { code: "missingStart", severity: "error" },
    ]);
    expect(
      codes({
        nodes: [node("s1", "start"), node("s2", "start")],
        edges: [],
      }),
    ).toEqual(["multipleStart"]);
  });

  it("flags edges into START, out of END and to missing nodes", () => {
    const nodes = [node("s", "start"), node("a"), node("e", "end")];
    expect(codes({ nodes, edges: [edge("s", "a"), edge("a", "s")] })).toEqual([
      "edgeIntoStart",
    ]);
    expect(codes({ nodes, edges: [edge("s", "a"), edge("e", "a")] })).toEqual([
      "edgeOutOfEnd",
    ]);
    expect(
      codes({ nodes, edges: [edge("s", "a"), edge("a", "gone")] }),
    ).toEqual(["danglingEdge"]);
  });

  it("flags a node no path from START reaches, but not a lone END", () => {
    expect(
      codes({
        nodes: [
          node("s", "start"),
          node("a"),
          node("orphan"),
          node("e", "end"),
        ],
        edges: [edge("s", "a")],
      }),
    ).toEqual(["unreachable"]);
  });

  it("every shipped template is clean", () => {
    for (const template of scenarioTemplates) {
      const def = template.createScenario("cp", null);
      expect(validateScenarioGraph(def), template.id).toEqual([]);
    }
  });
});
