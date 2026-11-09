import { describe, expect, it } from "vitest";

import { validateScenarioGraph } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  duplicateHandleScenario,
  forkScenario,
  messyScenario,
} from "../test/scenarioFixtures";
import { issueMarks, worstSeverity } from "./graphIssueMarks";
import { deriveStepLayout, drawnEdgeIds } from "./stepLayout";

const describeIssue = (issue: { code: string }) => `msg:${issue.code}`;

/** The marks as the Graph view (drawn edges) or the Steps view (none) sees
 *  them. */
function marksOf(
  def: Pick<ScenarioDefinition, "nodes" | "edges">,
  view: "graph" | "steps",
) {
  const layout = deriveStepLayout(def);
  return issueMarks(
    validateScenarioGraph(def),
    def,
    view === "graph" ? drawnEdgeIds(layout) : new Set<string>(),
    describeIssue,
  );
}

const codes = (
  marks: ReturnType<typeof marksOf>,
  kind: "nodes" | "edges",
  id: string,
) => marks[kind].get(id)?.entries.map((e) => e.code) ?? [];

describe("drawnEdgeIds", () => {
  it("names the edge into every card, into END, and every fork edge", () => {
    const layout = deriveStepLayout(messyScenario());
    expect([...drawnEdgeIds(layout)].sort()).toEqual(
      [
        "e-start",
        "e-case0",
        "e-default",
        "e-nohandle",
        "e-notify-end",
        "e-store-end",
        "e-late-end",
      ].sort(),
    );
    // A lane straight into END (an empty branch) is drawn by its fork edge.
    const dup = deriveStepLayout(duplicateHandleScenario());
    expect(dup.fork?.branches[2]).toMatchObject({
      edgeId: "e-default",
      endEdgeId: "e-default",
    });
  });
});

describe("issueMarks", () => {
  it("marks each diagnostic of the messy scenario on its step", () => {
    const marks = marksOf(messyScenario(), "graph");
    expect(codes(marks, "nodes", "route")).toEqual(["unpickableHandle"]);
    expect(codes(marks, "nodes", "late")).toEqual(["unreachable"]);
    expect(codes(marks, "nodes", "notify")).toEqual(["noCallHeld"]);
    expect(marks.nodes.get("notify")?.severity).toBe("error");
    expect(marks.nodes.has("store")).toBe(false);
    // The Graph view draws the unpickable edge (the third lane's fork edge).
    expect(codes(marks, "edges", "e-nohandle")).toEqual(["unpickableHandle"]);
    expect(marks.targets[0]).toEqual({
      nodeIds: ["route"],
      edgeIds: ["e-nohandle"],
      stepId: "route",
    });
    expect(marks.start).toBeNull();
    expect(marks.end).toBeNull();
  });

  it("marks an edge the view does not draw nowhere but on its node", () => {
    const marks = marksOf(messyScenario(), "steps");
    expect(marks.edges.size).toBe(0);
    expect(codes(marks, "nodes", "route")).toEqual(["unpickableHandle"]);
  });

  it("strokes a drawn duplicate-handle edge", () => {
    const marks = marksOf(duplicateHandleScenario(), "graph");
    expect(codes(marks, "edges", "e-dup")).toEqual(["duplicateHandle"]);
    expect(codes(marks, "nodes", "route")).toEqual(["duplicateHandle"]);
    expect(codes(marks, "nodes", "second")).toEqual(["unreachable"]);
    expect(marks.edges.has("e-first")).toBe(false);
  });

  it("marks the forking step of extraOutgoing", () => {
    const marks = marksOf(forkScenario(), "graph");
    expect(codes(marks, "nodes", "status")).toEqual(["extraOutgoing"]);
    expect(marks.nodes.size).toBe(1);
    expect(marks.edges.size).toBe(0);
  });

  it("puts an undrawn edge's diagnostic on its source step as an edge issue", () => {
    const def = forkScenario();
    def.edges = [
      ...def.edges.filter((e) => e.source !== "status" || e.target !== "wait"),
      { id: "gone", source: "meter", target: "nowhere" },
    ];
    const marks = issueMarks(
      validateScenarioGraph(def),
      def,
      drawnEdgeIds(deriveStepLayout(def)),
      describeIssue,
    );
    const entry = marks.nodes.get("meter")?.entries[0];
    expect(entry).toMatchObject({ code: "danglingEdge", viaEdge: true });
    expect(marks.targets.find((t) => t.stepId === "meter")).toBeDefined();
  });

  it("keeps an issue about no node (missingStart) in the box only", () => {
    const def = forkScenario();
    def.nodes = def.nodes.filter((n) => n.id !== "start");
    def.edges = def.edges.filter((e) => e.source !== "start");
    const issues = validateScenarioGraph(def);
    const marks = issueMarks(issues, def, new Set(), describeIssue);
    const i = issues.findIndex((issue) => issue.code === "missingStart");
    expect(i).not.toBe(-1);
    expect(marks.targets[i]).toEqual({
      nodeIds: [],
      edgeIds: [],
      stepId: null,
    });
  });

  it("marks END for an edge out of END, never a step", () => {
    const def = forkScenario();
    def.edges = [...def.edges, { id: "out", source: "end", target: "wait" }];
    const issues = validateScenarioGraph(def);
    const marks = issueMarks(issues, def, new Set(), describeIssue);
    expect(marks.end?.entries.map((e) => e.code)).toContain("edgeOutOfEnd");
    const i = issues.findIndex((issue) => issue.code === "edgeOutOfEnd");
    // No step to select: the line stays plain text.
    expect(marks.targets[i].stepId).toBeNull();
  });

  it("marks nothing for a clean scenario", () => {
    const def = forkScenario();
    def.edges = def.edges.filter(
      (e) => e.target !== "wait" && e.source !== "wait",
    );
    def.nodes = def.nodes.filter((n) => n.id !== "wait");
    const marks = marksOf(def, "graph");
    expect(marks.nodes.size).toBe(0);
    expect(marks.edges.size).toBe(0);
    expect(marks.targets).toEqual([]);
  });

  it("ranks severities error > warning > info", () => {
    expect(worstSeverity(["info", "warning"])).toBe("warning");
    expect(worstSeverity(["warning", "error", "info"])).toBe("error");
    expect(worstSeverity([])).toBe("info");
  });
});

describe("issueMarks: edges the view does not draw", () => {
  it("marks the forking step for a fork edge to a missing node, in the Graph view", () => {
    const base = forkScenario();
    const def = {
      ...base,
      edges: [
        ...base.edges,
        { id: "gone", source: "status", target: "nowhere" },
      ],
    };
    expect(drawnEdgeIds(deriveStepLayout(def)).has("gone")).toBe(false);
    const marks = marksOf(def, "graph");
    expect(codes(marks, "nodes", "status")).toContain("danglingEdge");
    expect(marks.nodes.get("status")?.entries[0]?.viaEdge).toBe(true);
  });

  it("marks START for an edge from START to a missing node", () => {
    const base = forkScenario();
    const start = base.nodes.find((n) => n.type === "start")!;
    const def = {
      ...base,
      edges: [
        ...base.edges,
        { id: "gone", source: start.id, target: "nowhere" },
      ],
    };
    const marks = marksOf(def, "steps");
    expect(codes(marks, "nodes", start.id)).toContain("danglingEdge");
  });

  it("counts every severity on one node and shows the worst", () => {
    expect(worstSeverity(["info", "warning", "error"])).toBe("error");
    expect(worstSeverity(["info", "warning"])).toBe("warning");
  });
});
