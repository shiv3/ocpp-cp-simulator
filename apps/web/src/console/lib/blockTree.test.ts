import { describe, expect, it } from "vitest";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

import {
  type Block,
  type BlockTree,
  type ForkBlock,
  type LoopBlock,
  type Seq,
  addLane,
  assertFirstEdgeWins,
  assertMergesConsistent,
  assertTreeCovers,
  editCapabilities,
  insertForkBlock,
  insertStep,
  moveStep,
  rebuildFromTree,
  recognizeBlockTree,
  removeLane,
  removeStep,
  setLaneCondition,
  setLaneHandle,
  setLink,
  unwrapLoop,
  wrapInLoop,
} from "./blockTree";
import { validateScenarioGraph } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";
import { deriveStepLayout } from "./stepLayout";
import { legacyDeriveStepLayout } from "./__fixtures__/legacyStepLayout";
import {
  choice,
  end,
  graph,
  liveEdgeIds,
  node,
  semanticDrift,
  semantics,
  shippedScenarios,
  start,
  sw,
} from "./__fixtures__/blockTreeKit";

const shipped = shippedScenarios();

/** The tree without node objects: kinds, ids and exits, for readable
 *  expectations. */
function shape(seq: Seq): unknown {
  const exit = seq.exit;
  return {
    blocks: seq.blocks.map((b: Block): unknown =>
      b.kind === "step"
        ? b.node.id
        : b.kind === "loop"
          ? { loop: b.headerId, body: shape(b.body) }
          : {
              fork: b.node.id,
              kind: b.forkKind,
              merge: b.merge?.nodeId ?? null,
              lanes: b.lanes.map((l) => ({
                when: l.condition.kind,
                ...(shape(l.body) as object),
              })),
            },
    ),
    exit:
      exit.kind === "fallthrough"
        ? `→${exit.to}`
        : exit.kind === "link"
          ? `link ${exit.target}`
          : exit.kind === "end"
            ? "end"
            : `stop ${exit.reason}`,
  };
}

const roundTrip = (def: ScenarioDefinition) =>
  rebuildFromTree(def, recognizeBlockTree(def));

const sameExceptUpdatedAt = (a: ScenarioDefinition, b: ScenarioDefinition) =>
  expect({ ...a, updatedAt: b.updatedAt }).toEqual(b);

describe("shipped scenarios", () => {
  it.each(shipped)(
    "%s: covers, round-trips byte-equal, same semantics",
    (_, def) => {
      const tree = recognizeBlockTree(def);
      assertTreeCovers(def, tree);
      const rebuilt = rebuildFromTree(def, tree);
      sameExceptUpdatedAt(rebuilt, def);
      expect(JSON.stringify(rebuilt.edges)).toBe(JSON.stringify(def.edges));
      expect(JSON.stringify(rebuilt.nodes)).toBe(JSON.stringify(def.nodes));
      expect(semantics(rebuilt)).toEqual(semantics(def));
    },
  );

  it.each(shipped)("%s: no-op operations round-trip", (_, def) => {
    const tree = recognizeBlockTree(def);
    // Move by zero.
    for (const [id, at] of tree.nodePath) {
      if (editCapabilities(tree, { kind: "node", nodeId: id }).removeStep.ok) {
        sameExceptUpdatedAt(
          moveStep(def, tree, at.path, at.index, at.index),
          def,
        );
      }
    }
    // setLink to where the last step already goes.
    const last = tree.root.blocks[tree.root.blocks.length - 1];
    if (last?.kind === "step" && tree.root.exit.kind === "end") {
      sameExceptUpdatedAt(setLink(def, tree, last.node.id, null), def);
    }
    // Insert, then remove the inserted step: the file comes back.
    for (let i = 0; i <= tree.root.blocks.length; i++) {
      if (
        !editCapabilities(tree, { kind: "slot", path: "root", index: i })
          .insertStep.ok
      )
        continue;
      const inserted = insertStep(def, tree, "root", i, ScenarioNodeType.DELAY);
      const added = inserted.nodes.find(
        (n) => !def.nodes.some((o) => o.id === n.id),
      )!;
      const back = removeStep(inserted, recognizeBlockTree(inserted), added.id);
      sameExceptUpdatedAt(back, def);
    }
  });

  it.each(shipped)(
    "%s: deriveStepLayout is the layout it always was",
    (_, def) => {
      const layout = deriveStepLayout(def);
      const legacy = legacyDeriveStepLayout(def);
      expect(layout.supported).toBe(legacy.supported);
      expect({
        ...layout,
        fork: layout.fork && {
          branches: layout.fork.branches.map((b, i) => ({
            ...b,
            name: String(i),
          })),
        },
      }).toEqual(legacy);
    },
  );
});

describe("recognizeBlockTree: structures", () => {
  it("an if/else that reconverges continues after the merge", () => {
    const def = graph(
      [start(), sw("s"), node("a"), node("b"), node("m"), node("after"), end()],
      [
        ["start", "s"],
        ["s", "a", "case-0"],
        ["s", "b", "default"],
        ["a", "m"],
        ["b", "m"],
        ["m", "after"],
        ["after", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(shape(tree.root)).toEqual({
      blocks: [
        {
          fork: "s",
          kind: "switch",
          merge: "m",
          lanes: [
            { when: "case", blocks: ["a"], exit: "→m" },
            { when: "default", blocks: ["b"], exit: "→m" },
          ],
        },
        "m",
        "after",
      ],
      exit: "end",
    });
    expect(tree.links).toEqual([]);
    sameExceptUpdatedAt(roundTrip(def), def);
  });

  it("a switch nested in a lane, reconverging inside it", () => {
    const def = graph(
      [
        start(),
        sw("s"),
        sw("inner", ["x"]),
        node("p"),
        node("q"),
        node("j"),
        node("b"),
        end(),
      ],
      [
        ["start", "s"],
        ["s", "inner", "case-0"],
        ["s", "b", "default"],
        ["inner", "p", "case-0"],
        ["inner", "q", "default"],
        ["p", "j"],
        ["q", "j"],
        ["j", "end"],
        ["b", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(shape(tree.root)).toEqual({
      blocks: [
        {
          fork: "s",
          kind: "switch",
          merge: null,
          lanes: [
            {
              when: "case",
              blocks: [
                {
                  fork: "inner",
                  kind: "switch",
                  merge: "j",
                  lanes: [
                    { when: "case", blocks: ["p"], exit: "→j" },
                    { when: "default", blocks: ["q"], exit: "→j" },
                  ],
                },
                "j",
              ],
              exit: "end",
            },
            { when: "default", blocks: ["b"], exit: "end" },
          ],
        },
      ],
      exit: "stop blockEnds",
    });
    expect(tree.nodePath.get("p")).toEqual({
      path: "root/0/lanes/0/0/lanes/0",
      index: 0,
    });
    sameExceptUpdatedAt(roundTrip(def), def);
  });

  it("a loop whose body has a switch: back edge structured, exit continues", () => {
    const def = graph(
      [
        start(),
        node("h"),
        sw("s", ["again"]),
        node("body"),
        node("out"),
        end(),
      ],
      [
        ["start", "h"],
        ["h", "s"],
        ["s", "body", "case-0"],
        ["s", "out", "default"],
        ["body", "h"],
        ["out", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(shape(tree.root)).toEqual({
      blocks: [
        {
          loop: "h",
          body: {
            blocks: [
              "h",
              {
                fork: "s",
                kind: "switch",
                merge: null,
                lanes: [
                  { when: "case", blocks: ["body"], exit: "→h" },
                  { when: "default", blocks: [], exit: "→out" },
                ],
              },
            ],
            exit: "stop blockEnds",
          },
        },
        "out",
      ],
      exit: "end",
    });
    const loop = tree.root.blocks[0] as LoopBlock;
    expect(loop.backEdgeIds).toEqual(["body->h"]);
    expect(tree.links).toEqual([]);
    sameExceptUpdatedAt(roundTrip(def), def);
  });

  it("a loop inside a fork lane", () => {
    const def = graph(
      [start(), choice("c"), node("h"), sw("t", ["more"]), node("x"), end()],
      [
        ["start", "c"],
        ["c", "h", "option-0"],
        ["c", "x", "option-1"],
        ["h", "t"],
        ["t", "h", "case-0"],
        ["t", "end", "default"],
        ["x", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    const fork = tree.root.blocks[0] as ForkBlock;
    expect(fork.forkKind).toBe("choice");
    expect(shape(fork.lanes[0].body)).toEqual({
      blocks: [
        {
          loop: "h",
          body: {
            blocks: [
              "h",
              {
                fork: "t",
                kind: "switch",
                merge: null,
                lanes: [
                  { when: "case", blocks: [], exit: "→h" },
                  { when: "default", blocks: [], exit: "end" },
                ],
              },
            ],
            exit: "stop blockEnds",
          },
        },
      ],
      exit: "stop blockEnds",
    });
    sameExceptUpdatedAt(roundTrip(def), def);
  });

  it("START fanning out and reconverging", () => {
    const def = graph(
      [start(), node("a"), node("b"), node("j"), end()],
      [
        ["start", "a"],
        ["start", "b"],
        ["a", "j"],
        ["b", "j"],
        ["j", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(shape(tree.root)).toEqual({
      blocks: [
        {
          fork: "start",
          kind: "start",
          merge: "j",
          lanes: [
            { when: "all", blocks: ["a"], exit: "→j" },
            { when: "all", blocks: ["b"], exit: "→j" },
          ],
        },
        "j",
      ],
      exit: "end",
    });
    sameExceptUpdatedAt(roundTrip(def), def);
  });

  it("an irreducible loop stays a link", () => {
    // a and b reach each other, each entered from the switch: neither
    // dominates the other.
    const def = graph(
      [start(), sw("s", ["x"]), node("a"), node("b")],
      [
        ["start", "s"],
        ["s", "a", "case-0"],
        ["s", "b", "default"],
        ["a", "b"],
        ["b", "a"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(tree.links.map((l) => [l.edge.id, l.role])).toEqual([
      ["b->a", "back"],
    ]);
    expect(allLoops(tree)).toEqual([]);
    sameExceptUpdatedAt(roundTrip(def), def);
  });

  it("an unreachable island is detached; edges into it are links", () => {
    const def = graph(
      [start(), node("a"), end(), node("i1"), node("i2")],
      [
        ["start", "a"],
        ["a", "end"],
        ["end", "i1"],
        ["i1", "i2"],
        ["i2", "a"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(tree.detached.map(shape)).toEqual([
      { blocks: ["i1", "i2"], exit: "link a" },
    ]);
    expect(tree.links.map((l) => [l.edge.id, l.role])).toEqual([
      ["end->i1", "outOfEnd"],
      ["i2->a", "join"],
    ]);
    sameExceptUpdatedAt(roundTrip(def), def);
  });

  it("dead edges stay visible: duplicate handle, unpickable, after the first", () => {
    const def = graph(
      [
        start(),
        sw("s", ["x"]),
        node("a"),
        node("b"),
        node("c"),
        node("d"),
        end(),
      ],
      [
        ["start", "s"],
        ["s", "a", "case-0"],
        ["s", "b", "case-0"],
        ["s", "c", "case-9"],
        ["s", "end", "default"],
        ["a", "d"],
        ["a", "end"],
        ["b", "end"],
        ["c", "missing"],
        ["d", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    const fork = tree.root.blocks[0] as ForkBlock;
    expect(fork.lanes.map((l) => l.condition)).toEqual([
      { kind: "case", index: 0, value: "x" },
      { kind: "default" },
      { kind: "ignored" },
      { kind: "unpickable", handle: "case-9" },
    ]);
    const aFork = fork.lanes[0].body.blocks[0] as ForkBlock;
    expect(aFork.forkKind).toBe("extra");
    expect(aFork.lanes.map((l) => l.condition.kind)).toEqual([
      "first",
      "ignored",
    ]);
    expect(shape(fork.lanes[3].body)).toEqual({
      blocks: ["c"],
      exit: "stop dangling",
    });
    expect(tree.links.map((l) => l.role)).toEqual(["dangling"]);
    sameExceptUpdatedAt(roundTrip(def), def);
    expect(semantics(roundTrip(def))).toEqual(semantics(def));
  });

  it("an edge into START and several STARTs", () => {
    const def = graph(
      [start(), node("a"), start("start2"), node("b")],
      [
        ["start", "a"],
        ["a", "start"],
        ["start2", "b"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(tree.origin?.id).toBe("start");
    expect(shape(tree.root)).toEqual({ blocks: ["a"], exit: "link start" });
    expect(tree.detached.map(shape)).toEqual([
      { blocks: ["start2", "b"], exit: "stop noEdge" },
    ]);
    sameExceptUpdatedAt(roundTrip(def), def);
  });

  it("no START: everything is detached", () => {
    const def = graph([node("a"), node("b")], [["a", "b"]]);
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(tree.origin).toBeNull();
    expect(tree.detached.map(shape)).toEqual([
      { blocks: ["a", "b"], exit: "stop noEdge" },
    ]);
  });
});

function allLoops(tree: BlockTree): LoopBlock[] {
  const out: LoopBlock[] = [];
  const visit = (seq: Seq) => {
    for (const b of seq.blocks) {
      if (b.kind === "loop") {
        out.push(b);
        visit(b.body);
      }
      if (b.kind === "fork") b.lanes.forEach((l) => visit(l.body));
    }
  };
  visit(tree.root);
  tree.detached.forEach(visit);
  return out;
}

describe("operations", () => {
  const chain = () =>
    graph(
      [start(), node("a"), node("b"), end()],
      [
        ["start", "a"],
        ["a", "b"],
        ["b", "end"],
      ],
    );

  it("insertStep adds one node and retargets one edge, keeping its id and index", () => {
    const def = chain();
    const out = insertStep(
      def,
      recognizeBlockTree(def),
      "root",
      1,
      ScenarioNodeType.DELAY,
    );
    const added = out.nodes[out.nodes.length - 1];
    expect(out.nodes.slice(0, -1)).toEqual(def.nodes);
    expect(added.position).toEqual({ x: 0, y: 120 });
    expect(out.edges.slice(0, 3)).toEqual([
      def.edges[0],
      { ...def.edges[1], target: added.id },
      def.edges[2],
    ]);
    expect(out.edges[3]).toMatchObject({ source: added.id, target: "b" });
    expect(out.edges).toHaveLength(4);
  });

  it("removeStep reconnects around the step with the edge that entered it", () => {
    const def = chain();
    const out = removeStep(def, recognizeBlockTree(def), "a");
    expect(out.nodes.map((n) => n.id)).toEqual(["start", "b", "end"]);
    expect(out.edges).toEqual([{ ...def.edges[0], target: "b" }, def.edges[2]]);
  });

  it("moveStep swaps two steps by retargeting, never re-creating, edges", () => {
    const def = chain();
    const out = moveStep(def, recognizeBlockTree(def), "root", 0, 1);
    expect(shape(recognizeBlockTree(out).root)).toEqual({
      blocks: ["b", "a"],
      exit: "end",
    });
    expect(out.edges.map((e) => e.id)).toEqual(def.edges.map((e) => e.id));
    expect(semantics(out)).not.toEqual(semantics(def));
  });

  it("insertStep after a fork's merge point runs after the lanes meet", () => {
    const def = graph(
      [start(), sw("s"), node("a"), node("b"), node("m"), end()],
      [
        ["start", "s"],
        ["s", "a", "case-0"],
        ["s", "b", "default"],
        ["a", "m"],
        ["b", "m"],
        ["m", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    const out = insertStep(def, tree, "root", 1, ScenarioNodeType.DELAY);
    const added = out.nodes[out.nodes.length - 1].id;
    expect(shape(recognizeBlockTree(out).root)).toMatchObject({
      blocks: [{ fork: "s", merge: added }, added, "m"],
    });
  });

  it("a step after lanes that all end is refused, with a reason", () => {
    const def = graph(
      [start(), sw("s"), node("a"), node("b"), end()],
      [
        ["start", "s"],
        ["s", "a", "case-0"],
        ["s", "b", "default"],
        ["a", "end"],
        ["b", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect(
      editCapabilities(tree, { kind: "slot", path: "root", index: 1 })
        .insertStep,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.afterBlockEnds" });
    expect(insertStep(def, tree, "root", 1, ScenarioNodeType.DELAY)).toBe(def);
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "s" }).removeStep,
    ).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.forkHasLanes",
    });
  });

  it("insertForkBlock adds a switch whose lanes meet at the next step", () => {
    const def = chain();
    const out = insertForkBlock(
      def,
      recognizeBlockTree(def),
      "root",
      1,
      "switch",
    );
    const tree = recognizeBlockTree(out);
    assertTreeCovers(out, tree);
    const sid = out.nodes[out.nodes.length - 1].id;
    expect(shape(tree.root)).toEqual({
      blocks: [
        "a",
        {
          fork: sid,
          kind: "switch",
          merge: "b",
          lanes: [
            { when: "case", blocks: [], exit: "→b" },
            { when: "default", blocks: [], exit: "→b" },
          ],
        },
        "b",
      ],
      exit: "end",
    });
    // The edge a→b now enters the switch.
    expect(out.edges[1]).toEqual({ ...def.edges[1], target: sid });
  });

  it("addLane turns a START chain into a fan-out; removeLane takes it back", () => {
    const def = chain();
    const out = addLane(def, recognizeBlockTree(def), "start");
    const tree = recognizeBlockTree(out);
    assertTreeCovers(out, tree);
    const fork = tree.root.blocks[0] as ForkBlock;
    expect(fork.forkKind).toBe("start");
    expect(fork.lanes).toHaveLength(2);
    expect(out.edges.slice(0, 3)).toEqual(def.edges);
    const back = removeLane(out, tree, "start", 1);
    sameExceptUpdatedAt(back, def);
  });

  it("addLane on a switch takes the first free handle", () => {
    const def = graph(
      [start(), sw("s", ["x", "y"]), node("a"), end()],
      [
        ["start", "s"],
        ["s", "a", "case-0"],
        ["s", "end", "default"],
        ["a", "end"],
      ],
    );
    const out = addLane(def, recognizeBlockTree(def), "s");
    const fork = recognizeBlockTree(out).root.blocks[0] as ForkBlock;
    expect(fork.lanes.map((l) => l.handle)).toEqual([
      "case-0",
      "case-1",
      "default",
    ]);
  });

  it("addLane is refused on a plain step", () => {
    const def = chain();
    expect(
      editCapabilities(recognizeBlockTree(def), { kind: "node", nodeId: "a" })
        .addLane,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.cannotFork" });
  });

  it("wrapInLoop closes the lane back to its first wrapped step", () => {
    const def = chain();
    const out = wrapInLoop(def, recognizeBlockTree(def), "root", 0, 1);
    const tree = recognizeBlockTree(out);
    expect(shape(tree.root)).toEqual({
      blocks: [{ loop: "a", body: { blocks: ["a", "b"], exit: "→a" } }],
      exit: "stop blockEnds",
    });
    // b→END became b→a: same id.
    expect(out.edges[2]).toEqual({ ...def.edges[2], target: "a" });
  });

  it("setLink jumps the last step and opens it to END again", () => {
    const def = chain();
    const tree = recognizeBlockTree(def);
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "a" }).setLink,
    ).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.notLastStep",
    });
    expect(setLink(def, tree, "b", "start")).toBe(def);
    const linked = setLink(def, tree, "b", "a");
    expect(linked.edges[2]).toEqual({ ...def.edges[2], target: "a" });
    const opened = setLink(linked, recognizeBlockTree(linked), "b", null);
    // A loop's last step goes back to its header: refused inside a loop.
    expect(opened).toBe(linked);
  });

  it("setLaneHandle rewrites the lane edge's handle; setLaneCondition the switch case", () => {
    const def = graph(
      [start(), sw("s", ["x"]), node("a"), end()],
      [
        ["start", "s"],
        ["s", "a", "case-0"],
        ["s", "end", "default"],
        ["a", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    const handled = setLaneHandle(def, tree, "s", 0, "case-5");
    expect(handled.edges[1]).toEqual({
      ...def.edges[1],
      sourceHandle: "case-5",
    });
    const cond = setLaneCondition(def, tree, "s", 0, "Accepted");
    expect(cond.nodes[1].data).toMatchObject({ cases: ["Accepted"] });
    expect(
      editCapabilities(tree, { kind: "lane", nodeId: "s", laneIndex: 1 })
        .setLaneCondition,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.noCondition" });
  });

  it("removeStep of a loop header moves the back edge to the next body step", () => {
    const def = graph(
      [start(), node("h"), node("b"), node("c")],
      [
        ["start", "h"],
        ["h", "b"],
        ["b", "c"],
        ["c", "h"],
      ],
    );
    const out = removeStep(def, recognizeBlockTree(def), "h");
    expect(shape(recognizeBlockTree(out).root)).toEqual({
      blocks: [{ loop: "b", body: { blocks: ["b", "c"], exit: "→b" } }],
      exit: "stop blockEnds",
    });
    expect(out.edges.map((e) => [e.id, e.target])).toEqual([
      ["start->h", "b"],
      ["b->c", "c"],
      ["c->h", "b"],
    ]);
  });
});

describe("unwrapLoop (Stop repeating)", () => {
  /** The result covers, passes the validator, round-trips, and nothing the
   *  edit did not touch runs differently. */
  const checked = (def: ScenarioDefinition, out: ScenarioDefinition) => {
    const tree = recognizeBlockTree(out);
    assertTreeCovers(out, tree);
    validateScenarioGraph(out);
    sameExceptUpdatedAt(roundTrip(out), out);
    expect(semanticDrift(def, out)).toEqual([]);
    // Nodes stay; a file without END gets one for a loop that ran to END.
    expect(out.nodes.slice(0, def.nodes.length)).toEqual(def.nodes);
    for (const n of out.nodes.slice(def.nodes.length)) {
      expect(n.type).toBe(ScenarioNodeType.END);
    }
    return tree;
  };
  /** Edges whose target changed: `[id, new target]`; every other edge is
   *  the same object. */
  const retargeted = (def: ScenarioDefinition, out: ScenarioDefinition) => {
    expect(out.edges.map((e) => e.id)).toEqual(def.edges.map((e) => e.id));
    return out.edges.flatMap((e, i) => {
      if (e === def.edges[i]) return [];
      expect(e).toEqual({ ...def.edges[i], target: e.target });
      return [[e.id, e.target]];
    });
  };

  it("a lane that loops back to an inner header is not 'leaving' the outer loop", () => {
    // O{h1; I{h2; f{case-0 -> h2 | case-1 -> c | default -> d -> END}}; c -> h1}
    // d runs once, after both loops: it is in neither.
    const def = graph(
      [
        start(),
        node("h1"),
        node("h2"),
        sw("f", ["m", "n"]),
        node("c"),
        node("d"),
        end(),
      ],
      [
        ["start", "h1"],
        ["h1", "h2"],
        ["h2", "f"],
        ["f", "h2", "case-0"],
        ["f", "c", "case-1"],
        ["f", "d", "default"],
        ["d", "end"],
        ["c", "h1"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "d" }).unwrapLoop,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.notInLoop" });
    // The loops themselves still unwrap.
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "h2" }).unwrapLoop.ok,
    ).toBe(true);
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "c" }).unwrapLoop.ok,
    ).toBe(true);
  });

  it("a loop that ends its lane runs on to END; the back edge keeps its id", () => {
    const def = graph(
      [start(), node("a"), node("b"), end()],
      [
        ["start", "a"],
        ["a", "b"],
        ["b", "a"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "b" }).unwrapLoop,
    ).toEqual({ ok: true });
    const out = unwrapLoop(def, tree, "b");
    expect(shape(checked(def, out).root)).toEqual({
      blocks: ["a", "b"],
      exit: "end",
    });
    expect(retargeted(def, out)).toEqual([["b->a", "end"]]);
  });

  it("a loop with a way out: the back edge goes where the loop went on", () => {
    const def = graph(
      [start(), node("x"), node("h"), sw("s", ["m"]), node("y"), end()],
      [
        ["start", "x"],
        ["x", "h"],
        ["h", "s"],
        ["s", "h", "case-0"],
        ["s", "y", "default"],
        ["y", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect((shape(tree.root) as { blocks: unknown[] }).blocks).toMatchObject([
      "x",
      { loop: "h" },
      "y",
    ]);
    const out = unwrapLoop(def, tree, "h");
    expect(shape(checked(def, out).root)).toMatchObject({
      blocks: ["x", "h", { fork: "s", merge: "y" }, "y"],
      exit: "end",
    });
    expect(retargeted(def, out)).toEqual([["s->h", "y"]]);
  });

  it("every back edge of a switch whose lanes return to the header moves", () => {
    const def = graph(
      [start(), node("h"), sw("s"), node("p"), node("q"), end()],
      [
        ["start", "h"],
        ["h", "s"],
        ["s", "p", "case-0"],
        ["s", "q", "case-1"],
        ["s", "h", "default"],
        ["p", "h"],
        ["q", "h"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect(tree.root.blocks[0]).toMatchObject({ kind: "loop" });
    const out = unwrapLoop(def, tree, "p");
    const after = checked(def, out);
    expect(shape(after.root)).toMatchObject({
      blocks: ["h", { fork: "s", merge: null }],
    });
    expect(retargeted(def, out)).toEqual([
      ["s->h", "end"],
      ["p->h", "end"],
      ["q->h", "end"],
    ]);
    // The default lane keeps its handle.
    expect(out.edges[4].sourceHandle).toBe("default");
  });

  it("nested loops: the innermost one around the selection goes", () => {
    const def = graph(
      [start(), node("h1"), node("h2"), node("b"), sw("s", ["m"]), node("c")],
      [
        ["start", "h1"],
        ["h1", "h2"],
        ["h2", "b"],
        ["b", "s"],
        ["s", "h2", "case-0"],
        ["s", "c", "default"],
        ["c", "h1"],
      ],
    );
    const tree = recognizeBlockTree(def);
    const inner = unwrapLoop(def, tree, "b");
    const innerTree = checked(def, inner);
    expect(allLoops(innerTree).map((l) => l.headerId)).toEqual(["h1"]);
    expect(retargeted(def, inner)).toEqual([["s->h2", "c"]]);
    // The outer loop's own header: the outer loop goes, the inner stays.
    const outer = unwrapLoop(def, tree, "h1");
    const outerTree = checked(def, outer);
    expect(allLoops(outerTree).map((l) => l.headerId)).toEqual(["h2"]);
    expect(outer.nodes.filter((n) => n.type === ScenarioNodeType.END)).toEqual([
      expect.objectContaining({ type: ScenarioNodeType.END }),
    ]);
    expect(retargeted(def, outer)).toEqual([
      ["c->h1", outer.nodes[outer.nodes.length - 1].id],
    ]);
  });

  it("a lane that already left the loop stays, and is not in the loop", () => {
    // loop { head; f1 [case-0 → head | case-1 → f2 [case-0 → x → head |
    // default → bye → END] | default → out] } → out → END: `out` is where
    // the loop goes on, `bye` leaves it two forks deep.
    const def = graph(
      [
        start(),
        node("head"),
        sw("f1", ["m", "n"]),
        sw("f2", ["m"]),
        node("x"),
        node("bye"),
        node("out"),
        end(),
      ],
      [
        ["start", "head"],
        ["head", "f1"],
        ["f1", "out", "default"],
        ["f1", "head", "case-0"],
        ["f1", "f2", "case-1"],
        ["f2", "x", "case-0"],
        ["x", "head"],
        ["f2", "bye", "default"],
        ["bye", "end"],
        ["out", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect((shape(tree.root) as { blocks: unknown[] }).blocks).toMatchObject([
      { loop: "head" },
      "out",
    ]);
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "bye" }).unwrapLoop,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.notInLoop" });
    expect(unwrapLoop(def, tree, "bye")).toBe(def);
    const out = unwrapLoop(def, tree, "x");
    checked(def, out);
    expect(retargeted(def, out)).toEqual([
      ["f1->head", "out"],
      ["x->head", "out"],
    ]);
  });

  it("is refused outside a loop; the closing step's jump points to it", () => {
    const def = graph(
      [start(), node("a"), node("b"), node("c"), end()],
      [
        ["start", "a"],
        ["a", "b"],
        ["b", "c"],
        ["c", "b"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "a" }).unwrapLoop,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.notInLoop" });
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "start" }).unwrapLoop.ok,
    ).toBe(false);
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "c" }).setLink,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.insideLoop" });
    const out = unwrapLoop(def, tree, "c");
    checked(def, out);
    expect(retargeted(def, out)).toEqual([["c->b", "end"]]);
    // Then the closing step can jump.
    expect(
      editCapabilities(recognizeBlockTree(out), { kind: "node", nodeId: "c" })
        .setLink.ok,
    ).toBe(true);
  });

  it("the shipped scenarios' loops all unwrap cleanly", () => {
    let count = 0;
    for (const [name, def] of shipped) {
      const tree = recognizeBlockTree(def);
      for (const loop of allLoops(tree)) {
        const out = unwrapLoop(def, tree, loop.headerId);
        expect(out, name).not.toBe(def);
        checked(def, out);
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
  });
});

describe("guarantees", () => {
  it("assertFirstEdgeWins catches a dead edge put before the running one", () => {
    const def = graph(
      [start(), node("a"), node("b"), node("c")],
      [
        ["start", "a"],
        ["a", "b"],
        ["a", "c"],
      ],
    );
    expect(() =>
      assertFirstEdgeWins(def, [{ edgeId: "a->b", source: "a", handle: null }]),
    ).not.toThrow();
    const swapped = {
      ...def,
      edges: [def.edges[0], def.edges[2], def.edges[1]],
    };
    expect(() =>
      assertFirstEdgeWins(swapped, [
        { edgeId: "a->b", source: "a", handle: null },
      ]),
    ).toThrow(/first edge wins/);
  });

  it("deriveStepLayout gives up where an End-labelled step has edges (the old walk went on)", () => {
    const def = graph(
      [start(), node("a", ScenarioNodeType.DELAY, { label: "End" }), node("b")],
      [
        ["start", "a"],
        ["a", "b"],
      ],
    );
    // The executor ends the branch at "a": "b" never runs.
    expect(
      recognizeBlockTree(def).detached.map((s) => s.blocks.length),
    ).toEqual([1]);
    expect(legacyDeriveStepLayout(def).supported).toBe(true);
    expect(deriveStepLayout(def).supported).toBe(false);
  });

  it("rebuild never moves an existing node and places a new one below its predecessor", () => {
    const def = graph(
      [start(), node("a"), end()],
      [
        ["start", "a"],
        ["a", "end"],
      ],
    );
    def.nodes[1] = { ...def.nodes[1], position: { x: 40, y: 300 } };
    const out = insertStep(
      def,
      recognizeBlockTree(def),
      "root",
      1,
      ScenarioNodeType.DELAY,
    );
    expect(out.nodes.slice(0, 3)).toEqual(def.nodes);
    expect(out.nodes[3].position).toEqual({ x: 40, y: 420 });
  });
});

describe("dead edges never shape or change what runs (review of #865)", () => {
  it("removing a switch whose only lane never runs is refused: its steps would start running", () => {
    const def = graph(
      [start(), node("a"), sw("s"), node("d"), end()],
      [
        ["start", "a"],
        ["a", "s"],
        ["s", "d"], // no handle: d never runs
        ["d", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    const caps = editCapabilities(tree, { kind: "node", nodeId: "s" });
    expect(caps.removeStep).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.revivesDeadEdge",
    });
    expect(removeStep(def, tree, "s")).toBe(def);
  });

  it("M1: a switch whose only edge it can never pick is a one-lane fork, not a chain", () => {
    const def = graph(
      [start(), sw("s"), node("b"), end()],
      [
        ["start", "s"],
        ["s", "b"], // no handle: the switch never takes it
        ["b", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(shape(tree.root)).toEqual({
      blocks: [
        {
          fork: "s",
          kind: "switch",
          merge: null,
          lanes: [{ when: "unpickable", blocks: ["b"], exit: "end" }],
        },
      ],
      exit: "stop blockEnds",
    });
    sameExceptUpdatedAt(roundTrip(def), def);
    // The run views' adapter still draws what it drew.
    expect(deriveStepLayout(def)).toEqual({
      ...legacyDeriveStepLayout(def),
      edgeInto: { s: "start->s", b: "s->b" },
      endEdgeId: "b->end",
    });
  });

  it("M2: removing the running lane of a handle another edge also has is refused", () => {
    const def = graph(
      [start(), sw("s", ["x"]), node("p"), node("q"), end()],
      [
        ["start", "s"],
        ["s", "p", "case-0"],
        ["s", "q", "case-0"], // never runs: case-0 takes s->p
        ["s", "end", "default"],
        ["p", "end"],
        ["q", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    const lane0 = editCapabilities(tree, {
      kind: "lane",
      nodeId: "s",
      laneIndex: 0,
    });
    expect(lane0.removeLane).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.revivesDeadEdge",
    });
    expect(removeLane(def, tree, "s", 0)).toBe(def);
    // Moving the running lane to another handle would revive s->q as well.
    expect(lane0.setLaneHandle).toEqual({
      ok: false,
      reason: "scenarios.editor.cannot.revivesDeadEdge",
    });
    expect(setLaneHandle(def, tree, "s", 0, "case-1")).toBe(def);
    // The dead lane itself can go, and nothing else changes.
    const fork = tree.root.blocks[0] as ForkBlock;
    expect(fork.lanes[2].condition.kind).toBe("ignored");
    const out = removeLane(def, tree, "s", 2);
    expect(out.edges.map((e) => e.id)).not.toContain("s->q");
    expect(semanticDrift(def, out)).toEqual([]);
    // Then the running lane can go too.
    const t2 = recognizeBlockTree(out);
    const without = removeLane(out, t2, "s", 0);
    expect(semantics(without).s).toMatchObject({
      handles: [
        ["case-0", "noEdgeForHandle"],
        ["default", "s->end>end"],
      ],
    });
  });

  it("M2: removing a step's first edge runs its next one, and the capability says so", () => {
    const def = graph(
      [start(), node("a"), node("b"), node("c"), end()],
      [
        ["start", "a"],
        ["a", "b"],
        ["a", "c"], // never runs: a takes a->b
        ["b", "end"],
        ["c", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect(
      editCapabilities(tree, { kind: "lane", nodeId: "a", laneIndex: 0 })
        .removeLane,
    ).toEqual({ ok: true, note: "scenarios.editor.note.promotesNextEdge" });
    const out = removeLane(def, tree, "a", 0);
    expect(semantics(out).a).toMatchObject({ next: "a->c>c" });
    // Removing b sends a->b on to END: fine. Without an edge after b,
    // removing it would drop a->b and run a->c without being asked to.
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "b" }).removeStep,
    ).toEqual({ ok: true });
    const lonely = graph(
      [start(), node("a"), node("b"), node("c"), end()],
      [
        ["start", "a"],
        ["a", "b"],
        ["a", "c"],
        ["c", "end"],
      ],
    );
    const t2 = recognizeBlockTree(lonely);
    expect(
      editCapabilities(t2, { kind: "node", nodeId: "b" }).removeStep,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.revivesDeadEdge" });
    expect(removeStep(lonely, t2, "b")).toBe(lonely);
  });

  it("M3: a dead edge back to a step makes no loop", () => {
    const def = graph(
      [start(), node("x"), node("a"), node("b"), end()],
      [
        ["start", "x"],
        ["x", "a"],
        ["a", "b"],
        ["a", "x"], // never runs: a takes a->b
        ["b", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(shape(tree.root)).toEqual({
      blocks: [
        "x",
        {
          fork: "a",
          kind: "extra",
          merge: "b",
          lanes: [
            { when: "first", blocks: [], exit: "→b" },
            { when: "ignored", blocks: [], exit: "link x" },
          ],
        },
        "b",
      ],
      exit: "end",
    });
    expect(tree.links.map((l) => [l.edge.id, l.role])).toEqual([
      ["a->x", "dead"],
    ]);
    sameExceptUpdatedAt(roundTrip(def), def);
  });

  it("M3: a dead lane to END keeps the switch's merge", () => {
    const def = graph(
      [
        start(),
        sw("s", ["x"]),
        node("p"),
        node("r"),
        node("q"),
        node("m"),
        end(),
      ],
      [
        ["start", "s"],
        ["s", "p", "case-0"],
        ["s", "r", "default"],
        ["s", "q", "case-0"], // never runs
        ["p", "m"],
        ["r", "m"],
        ["q", "end"],
        ["m", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(shape(tree.root)).toEqual({
      blocks: [
        {
          fork: "s",
          kind: "switch",
          merge: "m",
          lanes: [
            { when: "case", blocks: ["p"], exit: "→m" },
            { when: "default", blocks: ["r"], exit: "→m" },
            { when: "ignored", blocks: ["q"], exit: "end" },
          ],
        },
        "m",
      ],
      exit: "end",
    });
    expect(tree.links).toEqual([]);
    sameExceptUpdatedAt(roundTrip(def), def);
  });

  it("M3: a node a run reaches is placed where it runs, not in a dead lane met first", () => {
    const def = graph(
      [start(), node("a"), node("b"), node("c"), end()],
      [
        ["start", "a"],
        ["a", "b"],
        ["a", "c"], // never runs
        ["b", "c"],
        ["c", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    expect(shape(tree.root)).toEqual({
      blocks: [
        {
          fork: "a",
          kind: "extra",
          merge: "b",
          lanes: [
            { when: "first", blocks: [], exit: "→b" },
            { when: "ignored", blocks: [], exit: "link c" },
          ],
        },
        "b",
        "c",
      ],
      exit: "end",
    });
    sameExceptUpdatedAt(roundTrip(def), def);
  });

  it("M4: a second loop exit nothing else reaches is walked on in the lane that leaves the loop", () => {
    const def = graph(
      [start(), node("h"), sw("s"), node("x"), node("y"), node("z"), end()],
      [
        ["start", "h"],
        ["h", "s"],
        ["s", "x", "case-0"],
        ["s", "y", "case-1"],
        ["s", "z", "default"],
        ["x", "h"],
        ["y", "end"],
        ["z", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    const loop = tree.root.blocks[0] as LoopBlock;
    const fork = loop.body.blocks[1] as ForkBlock;
    // Only the case-0 lane goes back to the header. The first exit (y)
    // continues after the loop; z, the second, sits in its lane inside the
    // loop body, and the views must draw that lane as leaving the loop.
    expect(fork.lanes.map((l) => shape(l.body))).toEqual([
      { blocks: ["x"], exit: "→h" },
      { blocks: [], exit: "→y" },
      { blocks: ["z"], exit: "end" },
    ]);
    expect((shape(tree.root) as { blocks: unknown[] }).blocks).toEqual([
      expect.objectContaining({ loop: "h" }),
      "y",
    ]);
  });

  it("L1: a switch whose every handle has a lane takes no other", () => {
    const def = graph(
      [start(), sw("s", ["x"]), node("p"), node("q"), end()],
      [
        ["start", "s"],
        ["s", "p", "case-0"],
        ["s", "q", "default"],
        ["p", "end"],
        ["q", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "s" }).addLane,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.noFreeHandle" });
    expect(addLane(def, tree, "s")).toBe(def);
    // A choice still a chain with fewer than two options picks nothing.
    const lone = graph(
      [start(), choice("c", 1), node("a"), end()],
      [
        ["start", "c"],
        ["c", "a", "option-0"],
        ["a", "end"],
      ],
    );
    expect(
      editCapabilities(recognizeBlockTree(lone), { kind: "node", nodeId: "c" })
        .addLane,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.noFreeHandle" });
  });

  it("L2: no lane end may jump away from its loop's header, however deep", () => {
    const def = graph(
      [start(), node("h"), sw("s", ["a", "b"]), node("x"), node("y"), end()],
      [
        ["start", "h"],
        ["h", "s"],
        ["s", "x", "case-0"],
        ["s", "y", "case-1"],
        ["s", "end", "default"],
        ["x", "h"],
        ["y", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "x" }).setLink,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.insideLoop" });
    expect(setLink(def, tree, "x", "y")).toBe(def);
    // A lane that leaves the loop may jump.
    expect(
      editCapabilities(tree, { kind: "node", nodeId: "y" }).setLink,
    ).toEqual({ ok: true });
    const single = graph(
      [start(), node("h")],
      [
        ["start", "h"],
        ["h", "h"],
      ],
    );
    expect(
      editCapabilities(recognizeBlockTree(single), {
        kind: "node",
        nodeId: "h",
      }).setLink,
    ).toEqual({ ok: false, reason: "scenarios.editor.cannot.insideLoop" });
  });

  it("L3: a step inserted between a fork and its merge becomes the merge", () => {
    const def = graph(
      [start(), sw("s"), node("a"), node("b"), node("m"), end()],
      [
        ["start", "s"],
        ["s", "a", "case-0"],
        ["s", "b", "default"],
        ["a", "m"],
        ["b", "m"],
        ["m", "end"],
      ],
    );
    const out = insertStep(
      def,
      recognizeBlockTree(def),
      "root",
      1,
      ScenarioNodeType.DELAY,
    );
    const added = out.nodes[out.nodes.length - 1].id;
    expect(out.edges.slice(0, 6)).toEqual([
      def.edges[0],
      def.edges[1],
      def.edges[2],
      { ...def.edges[3], target: added },
      { ...def.edges[4], target: added },
      def.edges[5],
    ]);
    expect(out.edges[6]).toMatchObject({ source: added, target: "m" });
    const tree = recognizeBlockTree(out);
    expect((tree.root.blocks[0] as ForkBlock).merge?.nodeId).toBe(added);
    // rebuildFromTree checks every fork's merge against the tree it is given.
    const broken = recognizeBlockTree(def);
    (broken.root.blocks[0] as ForkBlock).merge = { kind: "node", nodeId: "a" };
    expect(() => assertMergesConsistent(broken)).toThrow(/merges at a/);
  });

  it("L4: no-op moves and links return the definition itself", () => {
    const def = graph(
      [start(), node("a"), node("b"), end()],
      [
        ["start", "a"],
        ["a", "b"],
        ["b", "end"],
      ],
    );
    const tree = recognizeBlockTree(def);
    expect(moveStep(def, tree, "root", 1, 1)).toBe(def);
    expect(setLink(def, tree, "b", null)).toBe(def);
    const linked = setLink(def, tree, "b", "a");
    expect(setLink(linked, recognizeBlockTree(linked), "b", "a")).toBe(linked);
  });

  it("L5: a switch still a chain is checked through its handle", () => {
    const def = graph(
      [start(), sw("s"), node("a"), node("b"), end()],
      [
        ["start", "s"],
        ["s", "b"], // first edge, but no handle: never taken
        ["s", "a", "case-0"],
        ["a", "end"],
      ],
    );
    expect(() =>
      assertFirstEdgeWins(def, [
        { edgeId: "s->a", source: "s", handle: "case-0" },
      ]),
    ).not.toThrow();
    expect(() =>
      assertFirstEdgeWins(def, [{ edgeId: "s->a", source: "s", handle: null }]),
    ).toThrow(/first edge wins/);
    expect(liveEdgeIds(def).has("s->b")).toBe(false);
  });
});
