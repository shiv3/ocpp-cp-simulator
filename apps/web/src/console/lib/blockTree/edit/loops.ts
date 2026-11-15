import type { Edge } from "@xyflow/react";

import {
  type AnyScenarioNodeType,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { isTerminal } from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

import { createDefaultNode } from "../../scenarioSteps";
import {
  canInsertAt,
  canSetLoopBounds,
  canWrapInLoop,
  editCapabilities,
  no,
  OK,
  type Capability,
} from "../capabilities";
import { commit } from "../rebuild";
import { hasBounds, type BlockTree, type SeqPath } from "../types";
import {
  applyUnwrapLoop,
  applyWrapInLoop,
  boundPlainLoop,
  locateLoop,
  type LoopBoundsInput,
} from "./applies";
import { cloneTree, insertBlockAt, loopOfBody, seqAt } from "./primitives";

/**
 * Makes blocks `from`..`to` of the sequence at `path` a loop: the last of
 * them (a step) goes back to the first. At the end of a sequence that ends
 * (END, a jump, nothing) the loop is a plain back edge and repeats until the
 * run stops, as before. Anywhere else (steps follow, or the sequence goes on
 * to a merge) it is a loop edge with {@link DEFAULT_LOOP_BOUNDS}, so what
 * follows still runs; its last step must then leave by "next". Never around
 * an existing loop header.
 */
export function wrapInLoop(
  def: ScenarioDefinition,
  tree: BlockTree,
  path: SeqPath,
  from: number,
  to: number,
): ScenarioDefinition {
  if (!canWrapInLoop(tree, path, from, to).ok) return def;
  const t = cloneTree(tree);
  applyWrapInLoop(seqAt(t, path)!, from, to);
  return commit(def, t);
}

/**
 * Whether an empty "Repeat" block can go to slot `index` of the sequence at
 * `path`. At the end of a sequence that ends it repeats forever; anywhere
 * else (steps after it, or a fallthrough to a merge) it starts with
 * {@link DEFAULT_LOOP_BOUNDS} so what follows still runs (see
 * {@link wrapInLoop}). Not as the first block of a loop (two loops would
 * share a header). The check the first step added to it is wrapped by.
 */
export function canInsertLoopAt(
  tree: BlockTree,
  path: SeqPath,
  index: number,
): Capability {
  const slot = canInsertAt(tree, path, index);
  if (!slot.ok) return slot;
  if (index === 0 && loopOfBody(tree, path)) {
    return no("scenarios.editor.cannot.loopHeader");
  }
  return OK;
}

/** Whether the Repeat block at slot `index` of the sequence at `path` gets
 *  bounds ({@link DEFAULT_LOOP_BOUNDS}): something follows it. Its first
 *  step must then leave by "next" (not a switch or choice). */
export function newLoopIsBounded(
  tree: BlockTree,
  path: SeqPath,
  index: number,
): boolean {
  const seq = seqAt(tree, path);
  return (
    !!seq && (index < seq.blocks.length || seq.exit.kind === "fallthrough")
  );
}

/**
 * The first step of a pending (empty) Repeat block: a new step of `type` at
 * the end of the sequence at `path`, closed by a back edge to itself. The
 * empty block is never in the file; this is what makes it real.
 */
export function insertStepIntoNewLoop(
  def: ScenarioDefinition,
  tree: BlockTree,
  path: SeqPath,
  index: number,
  type: AnyScenarioNodeType,
): ScenarioDefinition {
  if (!canInsertLoopAt(tree, path, index).ok) return def;
  if (isTerminal(createDefaultNode(type))) return def;
  const t = cloneTree(tree);
  const seq = seqAt(t, path)!;
  insertBlockAt(t, seq, index, {
    kind: "step",
    node: createDefaultNode(type),
    edgeIn: null,
  });
  if (!canWrapInLoop(t, path, index, index).ok) return def;
  applyWrapInLoop(seq, index, index);
  return commit(def, t);
}

/**
 * "Stop repeating": takes away the innermost loop that repeats `nodeId`.
 * Its body's blocks take the loop's place; every back edge (a sequence of
 * the body, at any depth, that falls through to the header) goes on where
 * the loop went on instead: the next block of the sequence around the loop,
 * else that sequence's own ending (a loop that ended its sequence runs to
 * END). A back edge keeps its id and fields; only its target changes. Lanes
 * that already left the loop stay as they are.
 */
export function unwrapLoop(
  def: ScenarioDefinition,
  tree: BlockTree,
  nodeId: string,
): ScenarioDefinition {
  if (!editCapabilities(tree, { kind: "node", nodeId }).unwrapLoop.ok) {
    return def;
  }
  const t = cloneTree(tree);
  applyUnwrapLoop(t, nodeId);
  return commit(def, t);
}

/** `bounds` as a loop edge's `loop`: only the bounds given; undefined when
 *  there is none. */
function loopField(
  bounds: LoopBoundsInput | null,
): LoopBoundsInput | undefined {
  if (!bounds || !hasBounds(bounds)) return undefined;
  return {
    ...(bounds.times !== undefined ? { times: bounds.times } : {}),
    ...(bounds.forSeconds !== undefined
      ? { forSeconds: bounds.forSeconds }
      : {}),
    ...(bounds.until !== undefined ? { until: bounds.until } : {}),
  };
}

/**
 * Sets the bounds of the loop whose header is `headerId` (see
 * {@link canSetLoopBounds}). A loop edge keeps its id, kind and unknown
 * fields; only `loop` changes (removed when there are no bounds). A plain
 * loop's back edge becomes a loop edge. Unknown keys of the old `loop` are
 * dropped: the editor writes what it shows. `def` unchanged when refused.
 */
export function setLoopBounds(
  def: ScenarioDefinition,
  tree: BlockTree,
  headerId: string,
  bounds: LoopBoundsInput | null,
): ScenarioDefinition {
  if (!canSetLoopBounds(tree, headerId, bounds).ok) return def;
  const found = locateLoop(tree, headerId)!;
  const loop = loopField(bounds);
  if (found.loop.loopEdge) {
    const edgeId = found.loop.loopEdge.edgeId;
    return {
      ...def,
      edges: def.edges.map((e) => {
        if (e.id !== edgeId) return e;
        const { loop: _old, ...rest } = e as Edge & { loop?: unknown };
        return (loop ? { ...rest, loop } : rest) as typeof e;
      }),
      updatedAt: new Date().toISOString(),
    };
  }
  if (!loop) return def; // A plain loop already repeats forever.
  const t = cloneTree(tree);
  boundPlainLoop(t, headerId, loop);
  return commit(def, t);
}
