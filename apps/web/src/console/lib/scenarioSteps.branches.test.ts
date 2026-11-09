import { describe, expect, it } from "vitest";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { forkScenario } from "../test/scenarioFixtures";
import {
  addParallelBranch,
  createEmptyScenario,
  findStepLane,
  insertLaneStep,
  insertStep,
  moveLaneStep,
  removeLaneStep,
  setLaneLink,
} from "./scenarioSteps";
import { deriveStepLayout, type StepLayout } from "./stepLayout";

/** Ids per lane: `main` and one array per branch. */
function lanes(def: ScenarioDefinition): {
  supported: boolean;
  main: string[];
  branches: string[][] | null;
} {
  const layout: StepLayout = deriveStepLayout(def);
  return {
    supported: layout.supported,
    main: layout.main.map((n) => n.id),
    branches: layout.fork
      ? layout.fork.branches.map((b) => b.steps.map((n) => n.id))
      : null,
  };
}

/** start → a → b, b looping back to a (no edge to END). */
function linearLoop(): ScenarioDefinition {
  const base = forkScenario();
  const step = (id: string) => ({
    id,
    type: ScenarioNodeType.DELAY,
    position: { x: 0, y: 0 },
    data: { label: id, delaySeconds: 1 },
  });
  const find = (type: ScenarioNodeType) =>
    base.nodes.find((n) => n.type === type)!;
  return {
    ...base,
    nodes: [
      { ...find(ScenarioNodeType.START), id: "start" },
      step("a"),
      step("b"),
      { ...find(ScenarioNodeType.END), id: "end" },
    ],
    edges: [
      { id: "e1", source: "start", target: "a" },
      { id: "e2", source: "a", target: "b" },
      { id: "e3", source: "b", target: "a" },
    ],
  } as ScenarioDefinition;
}

// forkScenario: main [plug, status], branches [[charge, meter], [wait]].

describe("branch-aware step editing", () => {
  it("inserts into one branch without touching the others", () => {
    const def = forkScenario();
    const next = insertLaneStep(
      def,
      deriveStepLayout(def),
      0,
      1,
      ScenarioNodeType.DELAY,
    );
    const result = lanes(next);

    expect(result.supported).toBe(true);
    expect(result.main).toEqual(["plug", "status"]);
    expect(result.branches?.[0]).toHaveLength(3);
    expect(result.branches?.[0][0]).toBe("charge");
    expect(result.branches?.[0][2]).toBe("meter");
    expect(result.branches?.[1]).toEqual(["wait"]);
    const inserted = next.nodes.find((n) => n.id === result.branches![0][1]);
    expect(inserted?.type).toBe(ScenarioNodeType.DELAY);
  });

  it("inserts at the end of the main chain, before the branches", () => {
    const def = forkScenario();
    const next = insertLaneStep(
      def,
      deriveStepLayout(def),
      "main",
      2,
      ScenarioNodeType.DELAY,
    );
    const result = lanes(next);
    expect(result.main).toHaveLength(3);
    expect(result.main.slice(0, 2)).toEqual(["plug", "status"]);
    expect(result.branches).toEqual([["charge", "meter"], ["wait"]]);
  });

  it("moves a step within its branch and never across lanes", () => {
    const def = forkScenario();
    const moved = moveLaneStep(def, deriveStepLayout(def), "meter", -1);
    expect(lanes(moved).branches).toEqual([["meter", "charge"], ["wait"]]);

    // Already first of its branch: a move up is a no-op, not a lane change.
    const stuck = moveLaneStep(moved, deriveStepLayout(moved), "meter", -1);
    expect(lanes(stuck).branches).toEqual([["meter", "charge"], ["wait"]]);
    expect(lanes(stuck).main).toEqual(["plug", "status"]);

    const last = moveLaneStep(def, deriveStepLayout(def), "wait", 1);
    expect(lanes(last).branches).toEqual([["charge", "meter"], ["wait"]]);
  });

  it("moves a step several places at once (a drag) within its lane", () => {
    let def = forkScenario();
    def = insertLaneStep(
      def,
      deriveStepLayout(def),
      0,
      2,
      ScenarioNodeType.DELAY,
    );
    const added = deriveStepLayout(def).fork!.branches[0].steps[2].id;
    const moved = moveLaneStep(def, deriveStepLayout(def), added, -2);
    expect(lanes(moved).branches).toEqual([
      [added, "charge", "meter"],
      ["wait"],
    ]);
    // Past the lane's edge: a no-op, never a clamp into another lane.
    const past = moveLaneStep(def, deriveStepLayout(def), "charge", 3);
    expect(lanes(past)).toEqual(lanes(def));
  });

  it("removes a step from a branch; emptying a branch drops it and a lone branch folds into the chain", () => {
    const def = forkScenario();
    const removed = removeLaneStep(def, deriveStepLayout(def), "charge");
    expect(lanes(removed).branches).toEqual([["meter"], ["wait"]]);
    expect(removed.nodes.some((n) => n.id === "charge")).toBe(false);

    const oneBranch = removeLaneStep(
      removed,
      deriveStepLayout(removed),
      "wait",
    );
    expect(lanes(oneBranch)).toEqual({
      supported: true,
      main: ["plug", "status", "meter"],
      branches: null,
    });
  });

  it("locates a step's lane and index", () => {
    const layout = deriveStepLayout(forkScenario());
    expect(findStepLane(layout, "status")).toEqual({
      lane: "main",
      index: 1,
      length: 2,
    });
    expect(findStepLane(layout, "wait")).toEqual({
      lane: 1,
      index: 0,
      length: 1,
    });
    expect(findStepLane(layout, "nope")).toBeNull();
  });

  it("adding a parallel branch to a chain forks at the last step", () => {
    let def = createEmptyScenario("Chain", "connector", 1);
    def = insertStep(def, 0, ScenarioNodeType.STATUS_CHANGE);
    def = insertStep(def, 1, ScenarioNodeType.TRANSACTION);
    const before = lanes(def);

    const next = addParallelBranch(def, deriveStepLayout(def));
    const result = lanes(next);

    expect(result.supported).toBe(true);
    // The fork node is the chain's last step.
    expect(result.main).toEqual(before.main);
    expect(result.branches).toHaveLength(2);
    expect(result.branches?.[0]).toEqual([]);
    expect(result.branches?.[1]).toHaveLength(1);
    const added = next.nodes.find((n) => n.id === result.branches![1][0]);
    expect(added?.type).toBe(ScenarioNodeType.DELAY);
    const forkNode = before.main[before.main.length - 1];
    expect(next.edges.filter((e) => e.source === forkNode)).toHaveLength(2);
  });

  it("adding a parallel branch to a fork adds one more lane", () => {
    const def = forkScenario();
    const next = addParallelBranch(def, deriveStepLayout(def));
    const result = lanes(next);
    expect(result.main).toEqual(["plug", "status"]);
    expect(result.branches).toHaveLength(3);
    expect(result.branches?.slice(0, 2)).toEqual([
      ["charge", "meter"],
      ["wait"],
    ]);
  });

  it("leaves an unsupported layout unchanged", () => {
    const def = forkScenario();
    // An orphan step nothing leads to.
    const joined = {
      ...def,
      nodes: [
        ...def.nodes,
        {
          id: "orphan",
          type: ScenarioNodeType.DELAY,
          position: { x: 0, y: 0 },
          data: { label: "x" },
        },
      ],
    } as typeof def;
    const layout = deriveStepLayout(joined);
    expect(layout.supported).toBe(false);
    expect(
      insertLaneStep(joined, layout, "main", 0, ScenarioNodeType.DELAY),
    ).toBe(joined);
    expect(addParallelBranch(joined, layout)).toBe(joined);
  });

  it("keeps a loop closing at the end of its lane through inserts and rewrites", () => {
    const chain = linearLoop();
    const layout = deriveStepLayout(chain);
    expect(layout.links).toHaveLength(1);
    const inserted = insertLaneStep(
      chain,
      layout,
      "main",
      2,
      ScenarioNodeType.DELAY,
    );
    const after = deriveStepLayout(inserted);
    expect(after.supported).toBe(true);
    expect(after.main).toHaveLength(3);
    // The loop now leaves the new last step, still back to `a`.
    expect(after.links.map((l) => [l.source, l.target])).toEqual([
      [after.main[2].id, "a"],
    ]);
  });

  it("setLaneLink closes a lane with a loop and opens it again", () => {
    const chain = {
      ...linearLoop(),
      edges: linearLoop().edges.filter(
        (e) => e.target !== "a" || e.source === "start",
      ),
    };
    const layout = deriveStepLayout(chain);
    expect(layout.links).toHaveLength(0);
    const looped = setLaneLink(chain, layout, "b", "a");
    expect(
      deriveStepLayout(looped).links.map((l) => [l.source, l.target]),
    ).toEqual([["b", "a"]]);
    // No edge to END any more: the loop closes the lane.
    expect(looped.edges.some((e) => e.target === "end")).toBe(false);
    const opened = setLaneLink(looped, deriveStepLayout(looped), "b", null);
    expect(deriveStepLayout(opened).links).toHaveLength(0);
    expect(opened.edges.some((e) => e.target === "end")).toBe(true);
    // Only a lane's last step takes a link.
    expect(setLaneLink(chain, layout, "a", "b")).toBe(chain);
  });

  it("refuses a parallel branch on a chain closed by a loop", () => {
    const chain = linearLoop();
    expect(addParallelBranch(chain, deriveStepLayout(chain))).toBe(chain);
  });
});
