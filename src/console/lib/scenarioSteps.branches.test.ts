import { describe, expect, it } from "vitest";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "../../cp/application/scenario/ScenarioTypes";
import { forkScenario } from "../test/scenarioFixtures";
import {
  addParallelBranch,
  createEmptyScenario,
  findStepLane,
  insertLaneStep,
  insertStep,
  moveLaneStep,
  removeLaneStep,
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
    // A join: both branches reach `meter`.
    const joined = {
      ...def,
      edges: [
        ...def.edges,
        { id: "wait->meter", source: "wait", target: "meter" },
      ],
    };
    const layout = deriveStepLayout(joined);
    expect(layout.supported).toBe(false);
    expect(
      insertLaneStep(joined, layout, "main", 0, ScenarioNodeType.DELAY),
    ).toBe(joined);
    expect(addParallelBranch(joined, layout)).toBe(joined);
  });
});
