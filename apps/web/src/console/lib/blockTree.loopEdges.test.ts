/**
 * Loop edges (schema 1.10, `kind: "loop"`) in the block tree: recognized as
 * bounded LoopBlocks, written back unchanged, kept (id, kind, `loop`,
 * unknown fields) by every operation, and refused where an edit would leave
 * a bounded loop without its single latch.
 */
import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioGraph } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";

import {
  allSeqs,
  assertTreeCovers,
  canInsertLoopAt,
  canSetLoopBounds,
  canWrapInLoop,
  DEFAULT_LOOP_BOUNDS,
  editCapabilities,
  insertForkBlock,
  insertStep,
  insertStepIntoNewLoop,
  type LoopBlock,
  loopBlockBounds,
  moveStep,
  moveStepTo,
  rebuildFromTree,
  recognizeBlockTree,
  removeStep,
  setLoopBounds,
  unwrapLoop,
  wrapInLoop,
} from "./blockTree";
import { end, graph, node, start, sw } from "./__fixtures__/blockTreeKit";
import { deriveStepLayout } from "./stepLayout";

type LoopEdge = Edge & { kind?: string; loop?: unknown; [k: string]: unknown };

/** `def` with a loop edge `source → target` appended. */
function withLoop(
  def: ScenarioDefinition,
  source: string,
  target: string,
  extra: Record<string, unknown> = { loop: { times: 2 } },
  id = "loop",
): ScenarioDefinition {
  return {
    ...def,
    edges: [...def.edges, { id, source, target, kind: "loop", ...extra }],
  } as ScenarioDefinition;
}

/** START → a → h → x → s → b → END, s loops back to h. */
const bodyOfThree = (extra?: Record<string, unknown>) =>
  withLoop(
    graph(
      [start(), node("a"), node("h"), node("x"), node("s"), node("b"), end()],
      [
        ["start", "a"],
        ["a", "h"],
        ["h", "x"],
        ["x", "s"],
        ["s", "b"],
        ["b", "end"],
      ],
    ),
    "s",
    "h",
    extra,
  );

/** START → a → m → b → END, m loops on itself. */
const selfLoop = (extra?: Record<string, unknown>) =>
  withLoop(
    graph(
      [start(), node("a"), node("m"), node("b"), end()],
      [
        ["start", "a"],
        ["a", "m"],
        ["m", "b"],
        ["b", "end"],
      ],
    ),
    "m",
    "m",
    extra,
  );

const loopsOf = (def: ScenarioDefinition): LoopBlock[] =>
  allSeqs(recognizeBlockTree(def)).flatMap((s) =>
    s.blocks.filter((b): b is LoopBlock => b.kind === "loop"),
  );

const loopEdges = (def: ScenarioDefinition): LoopEdge[] =>
  (def.edges as LoopEdge[]).filter((e) => e.kind === "loop");

/** The file reads back as a tree that covers it and has `n` bounded loops. */
function readsBack(def: ScenarioDefinition, bounded = 1) {
  const tree = recognizeBlockTree(def);
  assertTreeCovers(def, tree);
  expect(tree.links.filter((l) => l.role === "loopEdge")).toEqual([]);
  expect(loopsOf(def).filter((l) => l.loopEdge !== null)).toHaveLength(bounded);
  return tree;
}

const sameExceptUpdatedAt = (a: ScenarioDefinition, b: ScenarioDefinition) =>
  expect({ ...a, updatedAt: b.updatedAt }).toEqual(b);

describe("recognizing loop edges", () => {
  it("a self loop in the middle: a LoopBlock carrying the edge, then the steps after it", () => {
    const def = selfLoop();
    const tree = readsBack(def);
    expect(tree.root.blocks.map((b) => b.kind)).toEqual([
      "step",
      "loop",
      "step",
    ]);
    const loop = tree.root.blocks[1] as LoopBlock;
    expect(loop.headerId).toBe("m");
    expect(loop.loopEdge).toEqual({ edgeId: "loop", loop: { times: 2 } });
    expect(loop.body.exit).toEqual({
      kind: "fallthrough",
      to: "m",
      edgeId: "loop",
    });
    expect(tree.root.blocks[2]).toMatchObject({ edgeIn: "m->b" });
    expect(tree.root.exit).toEqual({ kind: "end", edgeId: "b->end" });
  });

  it("a body of several steps ends at the loop edge's source", () => {
    const tree = readsBack(bodyOfThree());
    const loop = tree.root.blocks[1] as LoopBlock;
    expect(
      loop.body.blocks.map((b) => (b.kind === "step" ? b.node.id : b.kind)),
    ).toEqual(["h", "x", "s"]);
    expect(tree.root.blocks[2]).toMatchObject({ edgeIn: "s->b" });
  });

  it("a loop edge whose source has no next edge: the branch ends after the loop", () => {
    const def = withLoop(
      graph(
        [start(), node("a"), node("m"), end()],
        [
          ["start", "a"],
          ["a", "m"],
        ],
      ),
      "m",
      "m",
    );
    const tree = readsBack(def);
    expect(tree.root.exit).toEqual({ kind: "stop", reason: "noEdge" });
  });

  it.each([
    ["selfLoop", selfLoop()],
    ["bodyOfThree", bodyOfThree({ loop: { forSeconds: 7200 }, note: "x" })],
    [
      "unknown fields and every bound",
      selfLoop({
        loop: {
          times: 10,
          forSeconds: 60,
          until: {
            value: { $from: "connector.power.soc" },
            cases: [{ $match: { gte: 80 } }],
          },
          extra: true,
        },
        label: "keep me",
        data: { a: 1 },
      }),
    ],
    ["no loop object", selfLoop({})],
  ])("%s round-trips byte-equal (graph → tree → graph)", (_, def) => {
    const out = rebuildFromTree(def, recognizeBlockTree(def));
    sameExceptUpdatedAt(out, def);
    expect(JSON.stringify(out.edges)).toBe(JSON.stringify(def.edges));
  });

  it("a loop edge out of a switch is not structured: kept as a link, untouched", () => {
    const def = withLoop(
      graph(
        [start(), sw("s"), node("x"), end()],
        [
          ["start", "s"],
          ["s", "x", "case-0"],
          ["x", "end"],
        ],
      ),
      "s",
      "s",
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(tree.links.map((l) => [l.edge.id, l.role])).toEqual([
      ["loop", "loopEdge"],
    ]);
    sameExceptUpdatedAt(rebuildFromTree(def, tree), def);
    expect(deriveStepLayout(def).supported).toBe(false);
  });

  it("a loop edge into a header with a plain back edge too stays a link", () => {
    const def = withLoop(
      graph(
        [start(), node("h"), node("s"), end()],
        [
          ["start", "h"],
          ["h", "s"],
          ["s", "h"],
        ],
      ),
      "h",
      "h",
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(tree.links.filter((l) => l.role === "loopEdge")).toHaveLength(1);
    sameExceptUpdatedAt(rebuildFromTree(def, tree), def);
  });

  it("a loop edge out of an End is accounted once", () => {
    const def = withLoop(
      graph(
        [start(), node("a"), end()],
        [
          ["start", "a"],
          ["a", "end"],
        ],
      ),
      "end",
      "a",
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    sameExceptUpdatedAt(rebuildFromTree(def, tree), def);
  });
});

describe("operations keep a loop edge's kind and fields", () => {
  const extra = { loop: { times: 2, forSeconds: 30 }, note: "keep" };
  /** The one loop edge of `out`: same id, kind, `loop` and unknown fields. */
  function keptEdge(out: ScenarioDefinition): LoopEdge {
    const [edge] = loopEdges(out);
    expect(loopEdges(out)).toHaveLength(1);
    expect(edge).toMatchObject({ id: "loop", kind: "loop", ...extra });
    return edge;
  }

  it("insert before the loop, at the loop's start, and after it", () => {
    const def = bodyOfThree(extra);
    const tree = recognizeBlockTree(def);
    const before = insertStep(def, tree, "root", 1, ScenarioNodeType.DELAY);
    expect(keptEdge(before)).toMatchObject({ source: "s", target: "h" });
    readsBack(before);
    const after = insertStep(def, tree, "root", 2, ScenarioNodeType.DELAY);
    expect(keptEdge(after)).toMatchObject({ source: "s", target: "h" });
    const added = after.nodes[after.nodes.length - 1].id;
    // s → new step → b: the loop's way on goes through the new step.
    expect(after.edges).toContainEqual(
      expect.objectContaining({ source: "s", target: added }),
    );
    readsBack(after);
    const header = insertStep(
      def,
      tree,
      "root/1/body",
      0,
      ScenarioNodeType.DELAY,
    );
    const newHeader = header.nodes[header.nodes.length - 1].id;
    expect(keptEdge(header)).toMatchObject({ source: "s", target: newHeader });
    readsBack(header);
  });

  it("a step added at the end of the body becomes the latch", () => {
    const def = bodyOfThree(extra);
    const out = insertStep(
      def,
      recognizeBlockTree(def),
      "root/1/body",
      3,
      ScenarioNodeType.DELAY,
    );
    const added = out.nodes[out.nodes.length - 1].id;
    expect(keptEdge(out)).toMatchObject({ source: added, target: "h" });
    expect(out.edges).toContainEqual(
      expect.objectContaining({ source: added, target: "b" }),
    );
    readsBack(out);
  });

  it("removing the latch hands the loop edge to the step before it", () => {
    const def = bodyOfThree(extra);
    const out = removeStep(def, recognizeBlockTree(def), "s");
    expect(keptEdge(out)).toMatchObject({ source: "x", target: "h" });
    expect(out.edges).toContainEqual(
      expect.objectContaining({ source: "x", target: "b" }),
    );
    readsBack(out);
  });

  it("removing a middle step, moving steps in the body", () => {
    const def = bodyOfThree(extra);
    const tree = recognizeBlockTree(def);
    const removed = removeStep(def, tree, "x");
    expect(keptEdge(removed)).toMatchObject({ source: "s", target: "h" });
    readsBack(removed);
    const moved = moveStep(def, tree, "root/1/body", 2, 1);
    // h → s → x: x is now last, the loop goes back from it.
    expect(keptEdge(moved)).toMatchObject({ source: "x", target: "h" });
    readsBack(moved);
  });

  it("moving a step from outside into the body", () => {
    const def = bodyOfThree(extra);
    const out = moveStepTo(def, recognizeBlockTree(def), "a", "root/1/body", 2);
    expect(out).not.toBe(def);
    expect(keptEdge(out)).toMatchObject({ source: "s", target: "h" });
    readsBack(out);
  });

  it("removing the only step of a self loop takes the loop away", () => {
    const def = selfLoop(extra);
    const out = removeStep(def, recognizeBlockTree(def), "m");
    expect(loopEdges(out)).toEqual([]);
    expect(out.edges).toContainEqual(
      expect.objectContaining({ source: "a", target: "b" }),
    );
    readsBack(out, 0);
  });

  it("wrapping a bounded loop in another one keeps it", () => {
    const def = bodyOfThree(extra);
    const tree = recognizeBlockTree(def);
    expect(canWrapInLoop(tree, "root", 0, 2).ok).toBe(true);
    const out = wrapInLoop(def, tree, "root", 0, 2);
    expect(keptEdge(out)).toMatchObject({ source: "s", target: "h" });
    // The outer loop ends the root: a plain back edge from b to a.
    expect(out.edges).toContainEqual(
      expect.objectContaining({ source: "b", target: "a" }),
    );
    readsBack(out);
  });

  it("unwrapping drops the loop edge; the latch goes on as before", () => {
    const def = bodyOfThree(extra);
    const out = unwrapLoop(def, recognizeBlockTree(def), "x");
    expect(loopEdges(out)).toEqual([]);
    expect(out.edges.filter((e) => e.source === "s")).toEqual([
      expect.objectContaining({ id: "s->b", target: "b" }),
    ]);
    readsBack(out, 0);
  });

  it("unwrapping a loop whose latch had no edge on: the branch ends there", () => {
    const def = withLoop(
      graph(
        [start(), node("a"), node("m"), end()],
        [
          ["start", "a"],
          ["a", "m"],
        ],
      ),
      "m",
      "m",
    );
    const out = unwrapLoop(def, recognizeBlockTree(def), "m");
    expect(loopEdges(out)).toEqual([]);
    expect(out.edges.filter((e) => e.source === "m")).toEqual([]);
  });

  it("a switch at the end of the body is refused; in the middle it is fine", () => {
    const def = bodyOfThree(extra);
    const tree = recognizeBlockTree(def);
    expect(
      editCapabilities(tree, { kind: "slot", path: "root/1/body", index: 3 })
        .insertForkBlock,
    ).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.breaksLoopBounds",
    });
    expect(insertForkBlock(def, tree, "root/1/body", 3, "switch")).toBe(def);
    const mid = insertForkBlock(def, tree, "root/1/body", 1, "switch");
    expect(mid).not.toBe(def);
    expect(keptEdge(mid)).toMatchObject({ source: "s", target: "h" });
    readsBack(mid);
  });

  it("a switch step cannot become the latch", () => {
    const def = withLoop(
      graph(
        [start(), node("h"), sw("w", ["a"]), node("s"), node("b"), end()],
        [
          ["start", "h"],
          ["h", "w"],
          ["w", "s", "case-0"],
          ["s", "b"],
          ["b", "end"],
        ],
      ),
      "s",
      "h",
    );
    const tree = recognizeBlockTree(def);
    // w is a chain step (one lane): moving s above it would leave w last.
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "s" }).moveUp,
    ).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.breaksLoopBounds",
    });
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "s" }).removeStep,
    ).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.breaksLoopBounds",
    });
    expect(removeStep(def, tree, "s")).toBe(def);
  });
});

describe("a Repeat in the middle of a lane", () => {
  const chain = () =>
    graph(
      [start(), node("a"), node("b"), end()],
      [
        ["start", "a"],
        ["a", "b"],
        ["b", "end"],
      ],
    );

  it("wrapping a middle step makes a loop edge with the default bound", () => {
    const def = chain();
    const tree = recognizeBlockTree(def);
    expect(canWrapInLoop(tree, "root", 0, 0)).toEqual({ ok: true });
    const out = wrapInLoop(def, tree, "root", 0, 0);
    expect(loopEdges(out)).toEqual([
      expect.objectContaining({
        source: "a",
        target: "a",
        kind: "loop",
        loop: DEFAULT_LOOP_BOUNDS,
      }),
    ]);
    // a still goes on to b.
    expect(out.edges).toContainEqual(
      expect.objectContaining({ id: "a->b", source: "a", target: "b" }),
    );
    readsBack(out);
    expect(
      validateScenarioGraph(out).filter((i) => i.severity === "error"),
    ).toEqual([]);
  });

  it("at the end of a lane the loop stays a plain back edge (forever)", () => {
    const def = chain();
    const out = wrapInLoop(def, recognizeBlockTree(def), "root", 1, 1);
    expect(loopEdges(out)).toEqual([]);
    expect(out.edges).toContainEqual(
      expect.objectContaining({ source: "b", target: "b" }),
    );
  });

  it("a new Repeat block mid-lane: allowed, first step bounded", () => {
    const def = chain();
    const tree = recognizeBlockTree(def);
    expect(canInsertLoopAt(tree, "root", 1)).toEqual({ ok: true });
    const out = insertStepIntoNewLoop(
      def,
      tree,
      "root",
      1,
      ScenarioNodeType.DELAY,
    );
    const added = out.nodes[out.nodes.length - 1].id;
    expect(loopEdges(out)).toEqual([
      expect.objectContaining({
        source: added,
        target: added,
        loop: { times: 3 },
      }),
    ]);
    expect(out.edges).toContainEqual(
      expect.objectContaining({ source: added, target: "b" }),
    );
    readsBack(out);
    // A switch cannot be the step a bounded loop is checked after.
    expect(
      insertStepIntoNewLoop(def, tree, "root", 1, ScenarioNodeType.SWITCH),
    ).toBe(def);
  });

  it("a mid-lane wrap whose last step is a switch is refused", () => {
    const def = graph(
      [start(), sw("w", ["a"]), node("b"), end()],
      [
        ["start", "w"],
        ["w", "b", "case-0"],
        ["b", "end"],
      ],
    );
    expect(canWrapInLoop(recognizeBlockTree(def), "root", 0, 0)).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.loopNeedsNextStep",
    });
  });
});

describe("editing bounds", () => {
  it("writes `loop` only; the edge keeps its id, kind and other fields", () => {
    const def = selfLoop({ loop: { times: 2, extra: 1 }, note: "keep" });
    const tree = recognizeBlockTree(def);
    const out = setLoopBounds(def, tree, "m", {
      forSeconds: 7200,
      until: { value: { $from: "connector.power.soc" }, cases: [80] },
    });
    expect(loopEdges(out)).toEqual([
      {
        id: "loop",
        source: "m",
        target: "m",
        kind: "loop",
        note: "keep",
        loop: {
          forSeconds: 7200,
          until: { value: { $from: "connector.power.soc" }, cases: [80] },
        },
      },
    ]);
    expect(out.edges.filter((e) => e.id !== "loop")).toEqual(
      def.edges.filter((e) => e.id !== "loop"),
    );
    expect(loopBlockBounds(loopsOf(out)[0])).toEqual({
      forSeconds: 7200,
      until: { value: { $from: "connector.power.soc" }, cases: [80] },
    });
  });

  it("removing every bound of a loop with steps after it is refused", () => {
    const def = selfLoop();
    const tree = recognizeBlockTree(def);
    expect(canSetLoopBounds(tree, "m", {})).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.unboundedMidLane",
    });
    expect(setLoopBounds(def, tree, "m", null)).toBe(def);
  });

  it("at the end of a lane the bounds can go: `loop` is removed", () => {
    const def = withLoop(
      graph(
        [start(), node("a"), node("m"), end()],
        [
          ["start", "a"],
          ["a", "m"],
        ],
      ),
      "m",
      "m",
    );
    const tree = recognizeBlockTree(def);
    expect(canSetLoopBounds(tree, "m", null).ok).toBe(true);
    const out = setLoopBounds(def, tree, "m", null);
    expect(loopEdges(out)).toEqual([
      { id: "loop", source: "m", target: "m", kind: "loop" },
    ]);
    expect(loopBlockBounds(loopsOf(out)[0])).toBeNull();
  });

  it("bounds on a plain loop turn its back edge into a loop edge", () => {
    const def = graph(
      [start(), node("a"), node("b"), end()],
      [
        ["start", "a"],
        ["a", "b"],
        ["b", "a"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect(loopsOf(def)[0].loopEdge).toBeNull();
    const out = setLoopBounds(def, tree, "a", { times: 5 });
    expect(loopEdges(out)).toEqual([
      {
        id: "b->a",
        source: "b",
        target: "a",
        kind: "loop",
        loop: { times: 5 },
      },
    ]);
    const back = readsBack(out);
    // When the bound fires the branch ends (b has no other edge).
    expect(back.root.exit).toEqual({ kind: "stop", reason: "noEdge" });
    // And steps can be added after it.
    const more = insertStep(out, back, "root", 1, ScenarioNodeType.DELAY);
    expect(more).not.toBe(out);
    readsBack(more);
  });
});
