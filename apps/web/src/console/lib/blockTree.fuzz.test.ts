import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioGraph } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";

import {
  type BlockTree,
  type ForkBlock,
  type Seq,
  addLane,
  allSeqs,
  assertTreeCovers,
  editCapabilities,
  insertForkBlock,
  insertStep,
  moveStep,
  rebuildFromTree,
  recognizeBlockTree,
  removeLane,
  removeStep,
  setLaneHandle,
  setLink,
  unwrapLoop,
  wrapInLoop,
} from "./blockTree";
import { deriveStepLayout } from "./stepLayout";
import { legacyDeriveStepLayout } from "./__fixtures__/legacyStepLayout";
import {
  randomLayoutScenario,
  randomScenario,
  semanticDrift,
  semantics,
  xorshift,
} from "./__fixtures__/blockTreeKit";

/** Seeds 1..CASES; a failure names its seed, replay it with `caseOf(seed)`. */
const CASES = 2000;
const OP_CASES = 1500;

/** Odd seeds: any graph; even seeds: the shape the run views draw. */
const caseOf = (seed: number): ScenarioDefinition =>
  seed % 2 === 1
    ? randomScenario(xorshift(seed * 2654435761))
    : randomLayoutScenario(xorshift(seed * 2654435761));

const withoutUpdatedAt = (d: ScenarioDefinition) => ({
  ...d,
  updatedAt: undefined,
});

/** A recognized result must cover, run the validator, and round-trip. */
function checkResult(def: ScenarioDefinition, label: string): void {
  let tree: BlockTree;
  try {
    tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    validateScenarioGraph(def);
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`, { cause: error });
  }
  expect(withoutUpdatedAt(rebuildFromTree(def, tree)), label).toEqual(
    withoutUpdatedAt(def),
  );
}

describe("block tree fuzz (xorshift, 2–12 nodes)", () => {
  it(`recognizes, covers, round-trips and is deterministic (${CASES} seeds)`, () => {
    const seen = new Map<string, number>();
    for (let seed = 1; seed <= CASES; seed++) {
      const def = caseOf(seed);
      const label = `seed ${seed}`;
      let tree: BlockTree;
      try {
        tree = recognizeBlockTree(def);
        assertTreeCovers(def, tree);
      } catch (error) {
        throw new Error(`${label}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      expect(recognizeBlockTree(def), label).toEqual(tree);
      count(tree, seen);
      const rebuilt = rebuildFromTree(def, tree);
      expect(withoutUpdatedAt(rebuilt), label).toEqual(withoutUpdatedAt(def));
      expect(semantics(rebuilt), label).toEqual(semantics(def));
    }
    // The generators reach every structure the recognizer knows.
    for (const what of [
      "loop",
      "loop with a fork",
      "fork in a loop lane",
      "nested fork",
      "merge",
      "start fork",
      "switch",
      "choice",
      "extra",
      "detached",
      "link:back",
      "link:join",
      "link:dead",
      "link:dangling",
      "link:intoStart",
      "link:outOfEnd",
      "lane:unpickable",
      "lane:ignored",
      "no start",
    ]) {
      expect(seen.get(what) ?? 0, what).toBeGreaterThan(0);
    }
  });

  it(`the StepLayout adapter agrees with the old layout whenever it supports a graph (${CASES} seeds)`, () => {
    let supported = 0;
    let legacyOnly = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      const def = caseOf(seed);
      const layout = deriveStepLayout(def);
      const legacy = legacyDeriveStepLayout(def);
      if (!layout.supported) {
        if (legacy.supported) legacyOnly++;
        continue;
      }
      supported++;
      expect(
        {
          ...layout,
          fork: layout.fork && {
            branches: layout.fork.branches.map((b, i) => ({
              ...b,
              name: String(i),
            })),
          },
        },
        `seed ${seed}`,
      ).toEqual(legacy);
    }
    // The tree only gives up where an "End"-labelled step has edges (the
    // old walk went on along them) or the origin is not of type START.
    expect(supported).toBeGreaterThan(CASES / 4);
    // The tree gives up only where an "End"-labelled step has edges or a
    // node labelled "Start" comes before the START (see blockTree.test.ts);
    // the generators make neither.
    expect(legacyOnly).toBe(0);
  });

  const byOp = new Map<string, number>();
  let applied = 0;
  const chunks = Array.from({ length: OP_CASES / 250 }, (_, i) => [
    i * 250 + 1,
    (i + 1) * 250,
  ]);
  it.each(chunks)(
    "every operation editCapabilities allows keeps the graph whole (seeds %i–%i)",
    (first, last) => {
      for (let seed = first; seed <= last; seed++) {
        const def = caseOf(seed);
        const tree = recognizeBlockTree(def);
        const rand = xorshift(seed * 7919 + 1);
        const pick = <T>(xs: readonly T[]): T | undefined =>
          xs[Math.floor(rand() * xs.length)];
        const seqs = allSeqs(tree);
        const placed = [...tree.nodePath.keys()];
        const label = (op: string) => `seed ${seed} ${op}`;
        const run = (
          op: string,
          f: () => ScenarioDefinition,
          promoted?: ReadonlySet<string>,
        ) => {
          let out: ScenarioDefinition;
          try {
            out = f();
          } catch (error) {
            throw new Error(`${label(op)}: ${(error as Error).message}`, {
              cause: error,
            });
          }
          checkResult(out, label(op));
          // Nothing the operation did not touch runs differently.
          expect(semanticDrift(def, out, promoted), label(op)).toEqual([]);
          applied++;
          const name = op.split(" ")[0];
          byOp.set(name, (byOp.get(name) ?? 0) + 1);
          return out;
        };

        // insertStep: one node more, nothing removed, old edges only
        // retargeted to it, one edge out of it.
        for (const seq of seqs) {
          const index = Math.floor(rand() * (seq.blocks.length + 1));
          const caps = editCapabilities(tree, {
            kind: "slot",
            path: seq.path,
            index,
          });
          if (!caps.insertStep.ok) continue;
          const out = run(`insertStep ${seq.path}@${index}`, () =>
            insertStep(def, tree, seq.path, index, ScenarioNodeType.DELAY),
          );
          expect(
            out.nodes.slice(0, def.nodes.length),
            label("insertStep"),
          ).toEqual(def.nodes);
          expect(out.nodes, label("insertStep")).toHaveLength(
            def.nodes.length + 1,
          );
          const added = out.nodes[out.nodes.length - 1].id;
          const byId = new Map(out.edges.map((e) => [e.id, e]));
          for (const e of def.edges) {
            const now = byId.get(e.id);
            expect(now, label("insertStep keeps every edge")).toBeDefined();
            if (now !== e) {
              expect(now, label("insertStep retargets only")).toEqual({
                ...e,
                target: added,
              });
            }
          }
          const fresh = out.edges.filter(
            (e) => !def.edges.some((o) => o.id === e.id),
          );
          expect(
            fresh.length,
            label("insertStep adds edges"),
          ).toBeLessThanOrEqual(1);
          // The edge on from the new step, or (after a step that had no edge) the
          // edge into it.
          for (const e of fresh) {
            expect(
              [e.source, e.target],
              label("insertStep fresh edge"),
            ).toContain(added);
          }
          if (!seq.path.startsWith("detached") || index > 0) {
            expect(
              out.edges.filter((e) => e.target === added).length,
              label(`insertStep ${seq.path}@${index} entered`),
            ).toBeGreaterThan(0);
          }
        }
        for (const seq of seqs.slice(0, 2)) {
          const index = Math.floor(rand() * (seq.blocks.length + 1));
          if (
            !editCapabilities(tree, { kind: "slot", path: seq.path, index })
              .insertForkBlock.ok
          )
            continue;
          const kind = rand() < 0.5 ? "switch" : "choice";
          const out = run(`insertForkBlock ${seq.path}@${index}`, () =>
            insertForkBlock(def, tree, seq.path, index, kind),
          );
          expect(out.nodes).toHaveLength(def.nodes.length + 1);
        }

        for (let k = 0; k < 3; k++) {
          const nodeId = pick(placed);
          if (!nodeId) break;
          const caps = editCapabilities(tree, { kind: "node", nodeId });
          const at = tree.nodePath.get(nodeId)!;
          if (caps.removeStep.ok) {
            const out = run(`removeStep ${nodeId}`, () =>
              removeStep(def, tree, nodeId),
            );
            expect(
              out.nodes.map((n) => n.id),
              label("removeStep"),
            ).toEqual(def.nodes.map((n) => n.id).filter((id) => id !== nodeId));
            expect(
              out.edges.filter(
                (e) => e.source === nodeId || e.target === nodeId,
              ),
              label("removeStep edges"),
            ).toEqual([]);
          }
          if (caps.moveUp.ok) {
            const out = run(`moveUp ${nodeId}`, () =>
              moveStep(def, tree, at.path, at.index, at.index - 1),
            );
            expect(out.nodes, label("moveUp")).toEqual(def.nodes);
            // Edges are retargeted, not multiplied (a step that had no edge
            // and moves up takes a new one; the one it no longer needs goes).
            expect(out.edges.length, label("moveUp")).toBe(def.edges.length);
          }
          if (caps.moveDown.ok) {
            run(`moveDown ${nodeId}`, () =>
              moveStep(def, tree, at.path, at.index, at.index + 1),
            );
          }
          if (caps.addLane.ok) {
            const out = run(`addLane ${nodeId}`, () =>
              addLane(def, tree, nodeId),
            );
            expect(out.nodes.length).toBeGreaterThan(def.nodes.length);
            // Edges are only added or retargeted, never dropped.
            for (const e of def.edges) {
              expect(
                out.edges.some((o) => o.id === e.id),
                label("addLane"),
              ).toBe(true);
            }
          }
          if (caps.setLink.ok) {
            const target = rand() < 0.3 ? null : (pick(placed) ?? null);
            const out = run(`setLink ${nodeId}→${target}`, () =>
              setLink(def, tree, nodeId, target),
            );
            // Opening to END adds an END when the file has none.
            expect(
              out.nodes.slice(0, def.nodes.length),
              label("setLink"),
            ).toEqual(def.nodes);
            for (const n of out.nodes.slice(def.nodes.length)) {
              expect(n.type).toBe(ScenarioNodeType.END);
            }
          }
          if (caps.wrapInLoop.ok) {
            const out = run(`wrapInLoop ${nodeId}`, () =>
              wrapInLoop(
                def,
                tree,
                at.path,
                at.index,
                seqLength(tree, at.path) - 1,
              ),
            );
            expect(out.nodes).toEqual(def.nodes);
          }
          if (caps.unwrapLoop.ok) {
            const out = run(`unwrapLoop ${nodeId}`, () =>
              unwrapLoop(def, tree, nodeId),
            );
            // Back edges are only retargeted; an END may be added.
            expect(out.nodes.slice(0, def.nodes.length)).toEqual(def.nodes);
            expect(
              out.edges.map((e) => e.id),
              label("unwrapLoop"),
            ).toEqual(def.edges.map((e) => e.id));
          }
          const fork = forkOf(tree, nodeId);
          if (fork) {
            const laneIndex = Math.floor(rand() * fork.lanes.length);
            const lane = editCapabilities(tree, {
              kind: "lane",
              nodeId,
              laneIndex,
            });
            if (lane.removeLane.ok) {
              // Removing a step's first edge runs its next one: the
              // capability says so.
              const promoted =
                lane.removeLane.note ===
                "scenarios.editor.note.promotesNextEdge"
                  ? new Set(fork.lanes.map((l) => l.edgeId))
                  : undefined;
              run(
                `removeLane ${nodeId}/${laneIndex}`,
                () => removeLane(def, tree, nodeId, laneIndex),
                promoted,
              );
            }
            if (lane.setLaneHandle.ok) {
              const out = run(`setLaneHandle ${nodeId}/${laneIndex}`, () =>
                setLaneHandle(def, tree, nodeId, laneIndex, "case-0"),
              );
              expect(out.nodes).toEqual(def.nodes);
              const changed = out.edges.filter(
                (e, i) => e !== def.edges[i],
              ) as Edge[];
              expect(changed.length).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    },
  );

  it(`exercised every operation over ${OP_CASES} seeds`, () => {
    expect(applied).toBeGreaterThan(OP_CASES);
    for (const op of [
      "insertStep",
      "insertForkBlock",
      "removeStep",
      "moveUp",
      "moveDown",
      "addLane",
      "setLink",
      "wrapInLoop",
      "unwrapLoop",
      "removeLane",
      "setLaneHandle",
    ]) {
      expect(byOp.get(op) ?? 0, op).toBeGreaterThan(10);
    }
    console.info(`operations applied: ${applied}`, Object.fromEntries(byOp));
  });
});

function count(tree: BlockTree, seen: Map<string, number>): void {
  const bump = (what: string) => seen.set(what, (seen.get(what) ?? 0) + 1);
  if (!tree.origin) bump("no start");
  if (tree.detached.length > 0) bump("detached");
  for (const link of tree.links) bump(`link:${link.role}`);
  const visit = (seq: Seq, inFork: boolean, inLoop: boolean) => {
    for (const b of seq.blocks) {
      if (b.kind === "loop") {
        bump("loop");
        if (inFork) bump("fork in a loop lane");
        visit(b.body, inFork, true);
      } else if (b.kind === "fork") {
        bump(b.forkKind === "start" ? "start fork" : b.forkKind);
        if (inFork) bump("nested fork");
        if (inLoop) bump("loop with a fork");
        if (b.merge) bump("merge");
        for (const l of b.lanes) {
          bump(`lane:${l.condition.kind}`);
          visit(l.body, true, inLoop);
        }
      }
    }
  };
  visit(tree.root, false, false);
  tree.detached.forEach((d) => visit(d, false, false));
}

function seqLength(tree: BlockTree, path: string): number {
  return allSeqs(tree).find((s) => s.path === path)!.blocks.length;
}

function forkOf(tree: BlockTree, nodeId: string): ForkBlock | null {
  for (const seq of allSeqs(tree)) {
    for (const b of seq.blocks) {
      if (b.kind === "fork" && b.node.id === nodeId) return b;
    }
  }
  return null;
}
