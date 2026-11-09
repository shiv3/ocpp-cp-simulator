import { describe, expect, it } from "vitest";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioGraph } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";

import {
  assertTreeCovers,
  canInsertLoopAt,
  canMoveStepTo,
  canSetLaneExit,
  setLaneExit,
  insertForkBlock,
  insertStepIntoNewLoop,
  moveStepTo,
  recognizeBlockTree,
  seqAt,
  allSeqs,
  treeNodes,
} from "./blockTree";
import {
  end,
  graph,
  node,
  randomLayoutScenario,
  randomScenario,
  start,
  sw,
  xorshift,
} from "./__fixtures__/blockTreeKit";

const chain = () =>
  graph(
    [start(), node("a"), node("b"), end()],
    [
      ["start", "a"],
      ["a", "b"],
      ["b", "end"],
    ],
  );

/** START → route ┬ case-0 → x → merge → END
 *                └ default (empty) ┘ */
const ifElse = () =>
  graph(
    [start(), sw("route"), node("x"), node("merge"), end()],
    [
      ["start", "route"],
      ["route", "x", "case-0"],
      ["route", "merge", "default"],
      ["x", "merge"],
      ["merge", "end"],
    ],
  );

describe("a pending Repeat block (UI-only until it holds a step)", () => {
  it("is allowed only where the repeat can close its sequence", () => {
    const def = chain();
    const tree = recognizeBlockTree(def);
    expect(canInsertLoopAt(tree, "root", 2).ok).toBe(true);
    const mid = canInsertLoopAt(tree, "root", 1);
    expect(mid).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.loopNotAtEnd",
    });
    // A lane that falls through to a merge cannot hold a forever loop.
    const t2 = recognizeBlockTree(ifElse());
    expect(canInsertLoopAt(t2, "root/0/lanes/0", 1).ok).toBe(false);
  });

  it("the first step written makes it real: one back edge, nothing else", () => {
    const def = chain();
    const tree = recognizeBlockTree(def);
    const out = insertStepIntoNewLoop(
      def,
      tree,
      "root",
      2,
      ScenarioNodeType.DELAY,
    );
    expect(out).not.toBe(def);
    expect(out.nodes).toHaveLength(def.nodes.length + 1);
    const added = out.nodes[out.nodes.length - 1].id;
    const back = out.edges.filter((e) => e.source === added);
    expect(back.map((e) => e.target)).toEqual([added]); // header = last = itself
    // b→END became b→added; no edge to END is left from the loop.
    expect(
      out.edges.some((e) => e.source === added && e.target === "end"),
    ).toBe(false);
    const loopTree = recognizeBlockTree(out);
    assertTreeCovers(out, loopTree);
    const loops = allSeqs(loopTree).flatMap((s) =>
      s.blocks.filter((b) => b.kind === "loop"),
    );
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ headerId: added });
    expect(() => validateScenarioGraph(out)).not.toThrow();
  });

  it("a refused slot leaves the file as it was", () => {
    const def = chain();
    const tree = recognizeBlockTree(def);
    expect(
      insertStepIntoNewLoop(def, tree, "root", 1, ScenarioNodeType.DELAY),
    ).toBe(def);
  });

  it("dropping a step in writes exactly one back edge, from the last body step to the header", () => {
    const def = chain();
    const tree = recognizeBlockTree(def);
    // a is dragged to the end into a new repeat: start → b → a → (back) a
    const out = moveStepTo(def, tree, "a", "root", 2, true);
    expect(out).not.toBe(def);
    expect(out.nodes).toEqual(def.nodes);
    const back = out.edges.filter((e) => e.source === "a");
    expect(back.map((e) => e.target)).toEqual(["a"]);
    const t2 = recognizeBlockTree(out);
    expect(t2.nodePath.get("a")?.path).toBe("root/1/body");
    expect(t2.nodePath.get("b")?.path).toBe("root");
    assertTreeCovers(out, t2);
  });

  it("wrapping the last step in place is a plain wrap", () => {
    const def = chain();
    const tree = recognizeBlockTree(def);
    const out = moveStepTo(def, tree, "b", "root", 2, true);
    const t2 = recognizeBlockTree(out);
    expect(t2.nodePath.get("b")?.path).toBe("root/1/body");
    expect(
      out.edges.filter((e) => e.source === "b").map((e) => e.target),
    ).toEqual(["b"]);
  });
});

describe("moveStepTo: across sequences", () => {
  it("moves a step into a branch lane and out of it again", () => {
    const def = ifElse();
    const tree = recognizeBlockTree(def);
    // merge is the join after the fork; move a new-looking step: put x's
    // lane-mate... here: drag `merge` into the empty default lane.
    const can = canMoveStepTo(tree, "merge", "root/0/lanes/1", 0);
    expect(can.ok).toBe(true);
    const out = moveStepTo(def, tree, "merge", "root/0/lanes/1", 0);
    const t2 = recognizeBlockTree(out);
    assertTreeCovers(out, t2);
    expect(t2.nodePath.get("merge")?.path).toBe("root/0/lanes/1");
    expect(() => validateScenarioGraph(out)).not.toThrow();
  });

  it("refuses with a reason: onto its own place, a terminal, a loop header's emptied sequence", () => {
    const def = chain();
    const tree = recognizeBlockTree(def);
    expect(canMoveStepTo(tree, "a", "root", 0)).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.samePlace",
    });
    expect(canMoveStepTo(tree, "end", "root", 0).ok).toBe(false);
    expect(canMoveStepTo(tree, "a", "nowhere", 0).ok).toBe(false);
    expect(moveStepTo(def, tree, "a", "root", 1)).toBe(def);
  });

  it("dragging the only step out of a loop removes the loop", () => {
    const def = graph(
      [start(), node("a"), node("l"), end()],
      [
        ["start", "a"],
        ["a", "l"],
        ["l", "l"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect(tree.nodePath.get("l")?.path).toBe("root/1/body");
    const out = moveStepTo(def, tree, "l", "root", 0);
    const t2 = recognizeBlockTree(out);
    assertTreeCovers(out, t2);
    expect(t2.nodePath.get("l")?.path).toBe("root");
    expect(
      allSeqs(t2).every((s) => s.blocks.every((b) => b.kind !== "loop")),
    ).toBe(true);
  });
});

describe("branch insertion: switch and choice", () => {
  it("a switch gets a case lane and a default lane, empty, meeting at the next step", () => {
    const def = chain();
    const out = insertForkBlock(
      def,
      recognizeBlockTree(def),
      "root",
      1,
      "switch",
    );
    const added = out.nodes[out.nodes.length - 1];
    expect(added.type).toBe(ScenarioNodeType.SWITCH);
    const lanes = out.edges
      .filter((e) => e.source === added.id)
      .map((e) => [e.sourceHandle, e.target]);
    expect(lanes).toEqual([
      ["case-0", "b"],
      ["default", "b"],
    ]);
    const tree = recognizeBlockTree(out);
    const fork = tree.root.blocks.find((b) => b.kind === "fork");
    expect(
      fork?.kind === "fork" && fork.lanes.map((l) => l.body.blocks.length),
    ).toEqual([0, 0]);
  });

  it("a choice gets two options", () => {
    const def = chain();
    const out = insertForkBlock(
      def,
      recognizeBlockTree(def),
      "root",
      1,
      "choice",
    );
    const added = out.nodes[out.nodes.length - 1];
    expect(
      out.edges.filter((e) => e.source === added.id).map((e) => e.sourceHandle),
    ).toEqual(["option-0", "option-1"]);
  });

  it("a step dropped into an empty lane keeps both lane edges", () => {
    const def = chain();
    const forked = insertForkBlock(
      def,
      recognizeBlockTree(def),
      "root",
      1,
      "switch",
    );
    const tree = recognizeBlockTree(forked);
    const out = moveStepTo(forked, tree, "a", "root/1/lanes/0", 0);
    expect(out).not.toBe(forked);
    const t2 = recognizeBlockTree(out);
    expect(t2.nodePath.get("a")?.path).toBe("root/0/lanes/0");
    assertTreeCovers(out, t2);
  });
});

describe("cross-sequence moves over random scenarios", () => {
  it("every allowed move keeps the nodes, covers, validates and lands where dropped", () => {
    let moved = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rand = xorshift(seed * 2654435761);
      const def: ScenarioDefinition =
        seed % 2 ? randomScenario(rand) : randomLayoutScenario(rand);
      const tree = recognizeBlockTree(def);
      const ids = treeNodes(tree).map((n) => n.id);
      const seqs = allSeqs(tree);
      for (let k = 0; k < 6 && ids.length > 0; k++) {
        const id = ids[Math.floor(rand() * ids.length)];
        const seq = seqs[Math.floor(rand() * seqs.length)];
        const index = Math.floor(rand() * (seq.blocks.length + 1));
        const loop = rand() < 0.3;
        if (!canMoveStepTo(tree, id, seq.path, index, loop).ok) continue;
        const out = moveStepTo(def, tree, id, seq.path, index, loop);
        if (out === def) continue; // read-back safety net refused it
        moved++;
        const label = `seed ${seed}: ${id} -> ${seq.path}@${index} loop=${loop}`;
        expect(out.nodes.map((n) => n.id).sort(), label).toEqual(
          def.nodes.map((n) => n.id).sort(),
        );
        const t2 = recognizeBlockTree(out);
        assertTreeCovers(out, t2);
        expect(() => validateScenarioGraph(out), label).not.toThrow();
        expect(seqAt(t2, t2.nodePath.get(id)!.path), label).toBeTruthy();
      }
    }
    expect(moved).toBeGreaterThan(100);
  });
});

describe("a lane continues at a later step", () => {
  const c = () =>
    graph(
      [start(), node("a"), node("b"), node("c"), end()],
      [
        ["start", "a"],
        ["a", "b"],
        ["b", "c"],
        ["c", "end"],
      ],
    );
  const forked = () => {
    const def = c();
    return insertForkBlock(def, recognizeBlockTree(def), "root", 1, "switch");
  };

  it("changes only that lane's edge, and the file reads back", () => {
    const def = forked();
    const tree = recognizeBlockTree(def);
    const lane = "root/1/lanes/0";
    expect(canSetLaneExit(tree, lane, "c").ok).toBe(true);
    const out = setLaneExit(def, tree, lane, "c");
    expect(out).not.toBe(def);
    const sw = def.nodes.find((n) => n.type === ScenarioNodeType.SWITCH)!;
    const was = def.edges.filter((e) => e.source === sw.id);
    const now = out.edges.filter((e) => e.source === sw.id);
    expect(now.map((e) => [e.sourceHandle, e.target])).toEqual([
      ["case-0", "c"],
      ["default", "b"],
    ]);
    // The lane kept its edge (same id); everything else is untouched.
    expect(now[0].id).toBe(was[0].id);
    expect(out.edges.filter((e) => e.source !== sw.id)).toEqual(
      def.edges.filter((e) => e.source !== sw.id),
    );
    const back = recognizeBlockTree(out);
    assertTreeCovers(out, back);
    expect(
      validateScenarioGraph(out).filter((d) => d.severity === "error"),
    ).toEqual([]);
  });

  it("the steps the lane skips stay with the other lanes, as the file says", () => {
    const def = forked();
    const out = setLaneExit(
      def,
      recognizeBlockTree(def),
      "root/1/lanes/0",
      "c",
    );
    const back = recognizeBlockTree(out);
    // The lanes now meet at c; b is run only by the lane that did not skip it.
    expect(back.nodePath.get("b")?.path).toBe("root/1/lanes/1");
    // The same fork's merge, picked on the unchanged file, is the default.
    const same = setLaneExit(
      def,
      recognizeBlockTree(def),
      "root/1/lanes/0",
      "b",
    );
    expect(
      same.edges
        .filter(
          (e) =>
            e.source ===
            out.edges.find(
              (x) => x.target === "c" && x.sourceHandle === "case-0",
            )!.source,
        )
        .map((e) => e.target),
    ).toEqual(["b", "b"]);
  });

  it("refuses a step before the fork, with a reason", () => {
    const def = forked();
    const tree = recognizeBlockTree(def);
    expect(canSetLaneExit(tree, "root/1/lanes/0", "a")).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.laneTargetNotLater",
    });
    expect(setLaneExit(def, tree, "root/1/lanes/0", "a")).toBe(def);
  });
});
