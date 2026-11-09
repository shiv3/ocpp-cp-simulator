import { describe, expect, it } from "vitest";

import { ScenarioNodeType } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

import {
  assertTreeCovers,
  insertStep,
  rebuildFromTree,
  recognizeBlockTree,
  removeStep,
} from "./blockTree";
import {
  end,
  graph,
  node,
  semanticDrift,
  start,
} from "./__fixtures__/blockTreeKit";

// Schema 1.9: the editor has no block for `parallel` / `join` yet. Opening a
// scenario that uses them and saving it must not drop, rewire or reorder
// anything.
const def = graph(
  [
    start(),
    node("a", ScenarioNodeType.DELAY),
    node("par", "parallel" as ScenarioNodeType, { label: "Parallel" }),
    node("b1", ScenarioNodeType.DELAY),
    node("b2", ScenarioNodeType.DELAY),
    node("join", "join" as ScenarioNodeType, { label: "Join", mode: "any" }),
    node("c", ScenarioNodeType.DELAY),
    end(),
  ],
  [
    ["start", "a"],
    ["a", "par"],
    ["par", "b1"],
    ["par", "b2"],
    ["b1", "join"],
    ["b2", "join"],
    ["join", "c"],
    ["c", "end"],
  ],
);

describe("block tree with parallel / join nodes", () => {
  it("recognizes and rebuilds the graph unchanged", () => {
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    const rebuilt = rebuildFromTree(def, tree);
    expect(semanticDrift(def, rebuilt)).toEqual([]);
    expect(rebuilt.nodes.map((n) => n.id).sort()).toEqual(
      def.nodes.map((n) => n.id).sort(),
    );
    expect(rebuilt.edges.map((e) => e.id).sort()).toEqual(
      def.edges.map((e) => e.id).sort(),
    );
    expect(rebuilt.nodes.find((n) => n.id === "join")?.data).toEqual({
      label: "Join",
      mode: "any",
    });
  });
});

describe("editing around parallel / join nodes", () => {
  it("draws the parallel's edges as lanes that all run, merging at the join", () => {
    const tree = recognizeBlockTree(def);
    const fork = tree.root.blocks.find((b) => b.kind === "fork");
    expect(fork).toMatchObject({ kind: "fork", forkKind: "parallel" });
    if (fork?.kind !== "fork") return;
    expect(fork.lanes.map((l) => l.condition)).toEqual([
      { kind: "all" },
      { kind: "all" },
    ]);
    expect(fork.merge).toEqual({ kind: "node", nodeId: "join" });
  });

  it("removing a step before or after keeps the fork, its lanes and the join", () => {
    for (const id of ["a", "c"]) {
      const out = removeStep(def, recognizeBlockTree(def), id);
      expect(out).not.toBe(def);
      for (const e of ["par->b1", "par->b2", "b1->join", "b2->join"]) {
        expect(out.edges.map((x) => x.id)).toContain(e);
      }
      expect(out.nodes.find((n) => n.id === "join")?.data).toEqual({
        label: "Join",
        mode: "any",
      });
    }
  });

  it("inserting a step before the parallel changes nothing inside it", () => {
    const tree = recognizeBlockTree(def);
    const out = insertStep(def, tree, "root", 1, ScenarioNodeType.DELAY);
    for (const e of def.edges.filter((x) => x.source === "par")) {
      expect(out.edges).toContainEqual(e);
    }
    expect(out.nodes.filter((n) => n.type === "parallel")).toHaveLength(1);
    expect(out.nodes.filter((n) => n.type === "join")).toHaveLength(1);
  });

  it("refuses to remove the parallel while it has two lanes", () => {
    expect(removeStep(def, recognizeBlockTree(def), "par")).toBe(def);
  });
});
