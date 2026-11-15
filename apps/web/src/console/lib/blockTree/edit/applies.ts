/**
 * Edit steps shared by the operations (`blockTree.ts`) and the capability
 * checks (`../capabilities.ts`): each `apply*` performs an edit on a clone,
 * without the checks, so a capability can simulate it. Kept here so the two
 * sides do not import each other (#570).
 */
import type { ScenarioNode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { pickableHandles } from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

import {
  type Block,
  type BlockTree,
  type ForkBlock,
  type Lane,
  type LoopBlock,
  type Seq,
  type SeqExit,
  type SeqPath,
  type StepBlock,
} from "../types";
import { allSeqs, firstNodeOf, treeNodes } from "../treeHelpers";
import {
  continuationAfter,
  insertBlockAt,
  loopOfBody,
  locate,
  redirectFallthroughs,
  repeatingLoopAt,
  seqAt,
} from "./primitives";

/** Takes the step block at `index` out of `seq`, rerouting what reached it
 *  to what came after it. Returns the block. */
export function removeStepBlockAt(
  tree: BlockTree,
  seq: Seq,
  index: number,
  /** A move: the step comes back, so links into it stay. */
  moving = false,
): StepBlock {
  const block = seq.blocks[index] as StepBlock;
  const id = block.node.id;
  const following = seq.blocks[index + 1];
  const cont = continuationAfter(tree, seq, index, id);
  const followExit = (old: { edgeId?: string | null }): SeqExit => {
    if (cont.kind === "node") {
      return { kind: "fallthrough", to: cont.id, edgeId: old.edgeId ?? null };
    }
    if (cont.kind === "end") return { kind: "end", edgeId: old.edgeId ?? null };
    if (cont.kind === "link") {
      return {
        kind: "link",
        target: cont.target,
        edgeId: old.edgeId ?? crypto.randomUUID(),
      };
    }
    return { kind: "stop", reason: "noEdge" };
  };
  // Whatever fell through to the step (a merge, a loop's back edges, the
  // way into a loop from a merge before it) goes where the step went.
  redirectFallthroughs([tree.root, ...tree.detached], id, followExit);
  const loop = index === 0 ? loopOfBody(tree, seq.path) : null;
  if (loop && following) loop.headerId = firstNodeOf(following).id;
  // Links into the removed step go where it went.
  const nextId =
    cont.kind === "node" ? cont.id : cont.kind === "link" ? cont.target : null;
  for (const s of moving ? [] : allSeqs(tree)) {
    if (s.exit.kind === "link" && s.exit.target === id) {
      s.exit =
        nextId !== null
          ? { ...s.exit, target: nextId }
          : cont.kind === "end"
            ? { kind: "end", edgeId: s.exit.edgeId }
            : { kind: "stop", reason: "noEdge" };
    }
  }
  // The edge into the step now enters what follows it.
  if (following && following.kind !== "loop" && block.edgeIn !== null) {
    following.edgeIn = block.edgeIn;
  } else if (!following && block.edgeIn !== null) {
    if (seq.exit.kind === "end" || seq.exit.kind === "fallthrough") {
      seq.exit = { ...seq.exit, edgeId: block.edgeIn };
    } else if (seq.exit.kind === "link") {
      seq.exit = { ...seq.exit, edgeId: block.edgeIn };
    }
  }
  seq.blocks.splice(index, 1);
  if (loop && seq.blocks.length === 0) {
    // Nothing left to repeat: the loop goes.
    const m = /^(.*)\/(\d+)\/body$/.exec(seq.path)!;
    const parent = seqAt(tree, m[1])!;
    parent.blocks.splice(Number(m[2]), 1);
  }
  return block;
}

/** {@link removeStep} on `t` (a clone), without the checks. */
export function applyRemoveStep(t: BlockTree, nodeId: string): void {
  const found = locate(t, nodeId)!;
  if (found.block.kind === "fork") {
    // One lane (or none): the lane's steps take the fork's place, then the
    // fork node goes like any step.
    const fork = found.block;
    const seq = found.seq;
    const lane = fork.lanes[0];
    const after = seq.blocks.slice(found.index + 1);
    const laneBlocks = lane?.body.blocks ?? [];
    const first = laneBlocks[0] ?? after[0];
    if (lane && first && first.kind !== "loop") first.edgeIn = lane.edgeId;
    seq.blocks.splice(
      found.index,
      after.length + 1,
      { kind: "step", node: fork.node, edgeIn: fork.edgeIn },
      ...laneBlocks,
      ...after,
    );
    if (!lane) seq.exit = { kind: "stop", reason: "noEdge" };
    else if (lane.body.exit.kind !== "fallthrough") seq.exit = lane.body.exit;
    else if (!first && seq.exit.kind === "fallthrough") {
      seq.exit = { ...seq.exit, edgeId: lane.edgeId };
    }
  }
  removeStepBlockAt(t, found.seq, found.index);
}

/** {@link moveStep} on `t` (a clone), without the checks. */
export function applyMoveStep(
  t: BlockTree,
  path: SeqPath,
  from: number,
  to: number,
) {
  const seq = seqAt(t, path)!;
  const block = removeStepBlockAt(t, seq, from, true);
  insertBlockAt(t, seq, to, { kind: "step", node: block.node, edgeIn: null });
}

export function newLaneHandle(fork: ScenarioNode, lanes: readonly Lane[]) {
  const usedHandles = new Set(lanes.map((l) => l.handle));
  return (pickableHandles(fork) ?? []).find((h) => !usedHandles.has(h)) ?? null;
}

/** {@link removeLane} on `t` (a clone), without the checks. */
export function applyRemoveLane(
  t: BlockTree,
  nodeId: string,
  laneIndex: number,
) {
  const found = locate(t, nodeId)!;
  const fork = found.block as ForkBlock;
  const [lane] = fork.lanes.splice(laneIndex, 1);
  // Steps of the lane go; links into them go where the lane went.
  const gone = new Set(
    treeNodes({ root: lane.body, detached: [], origin: null }).map((n) => n.id),
  );
  for (const s of allSeqs(t)) {
    if (s.exit.kind === "link" && gone.has(s.exit.target)) {
      s.exit = { kind: "stop", reason: "noEdge" };
    }
  }
}

/** The bounds a loop made in the middle of a sequence starts with. */
export const DEFAULT_LOOP_BOUNDS: Readonly<{ times: number }> = { times: 3 };

/** Whether a loop of blocks `from`..`to` of `seq` would have something
 *  after it (a block, or a fallthrough to a merge): it then needs bounds. */
export function loopNeedsBounds(seq: Seq, to: number): boolean {
  return to < seq.blocks.length - 1 || seq.exit.kind === "fallthrough";
}

/** {@link wrapInLoop} on `seq` (of a clone), without the checks. */
export function applyWrapInLoop(seq: Seq, from: number, to: number): void {
  const path = seq.path;
  const body = seq.blocks.slice(from, to + 1);
  const header = firstNodeOf(body[0]).id;
  if (loopNeedsBounds(seq, to)) {
    // A loop edge: the last step keeps its ordinary edge to what follows.
    const edgeId = crypto.randomUUID();
    seq.blocks.splice(from, to - from + 1, {
      kind: "loop",
      headerId: header,
      body: {
        path: `${path}/${from}/body`,
        blocks: body,
        exit: { kind: "fallthrough", to: header, edgeId },
      },
      backEdgeIds: [edgeId],
      loopEdge: { edgeId, loop: { ...DEFAULT_LOOP_BOUNDS } },
    });
    repath(seq);
    return;
  }
  const backEdgeId =
    seq.exit.kind === "stop" ? crypto.randomUUID() : (seq.exit.edgeId ?? null);
  const loop: LoopBlock = {
    kind: "loop",
    headerId: header,
    body: {
      path: `${path}/${from}/body`,
      blocks: body,
      exit: { kind: "fallthrough", to: header, edgeId: backEdgeId },
    },
    backEdgeIds: backEdgeId ? [backEdgeId] : [],
    loopEdge: null,
  };
  seq.blocks.splice(from, to - from + 1, loop);
  seq.exit = { kind: "stop", reason: "blockEnds" };
  repath(seq);
}

/** The loop {@link unwrapLoop} takes away for a selected node: the
 *  innermost one that repeats it (a loop header: its own loop). */
export function loopToUnwrap(
  tree: BlockTree,
  nodeId: string,
): { parent: Seq; index: number; loop: LoopBlock } | null {
  const found = locate(tree, nodeId);
  return found ? repeatingLoopAt(tree, found.seq.path) : null;
}

/** Rewrites the paths of the sequences nested in `seq` after its blocks
 *  moved. */
export function repath(seq: Seq): void {
  seq.blocks.forEach((b, i) => {
    if (b.kind === "loop") {
      b.body.path = `${seq.path}/${i}/body`;
      repath(b.body);
    } else if (b.kind === "fork") {
      b.lanes.forEach((lane, j) => {
        lane.body.path = `${seq.path}/${i}/lanes/${j}`;
        repath(lane.body);
      });
    }
  });
}

/** The edge a block is entered by (a loop: its first block's). */
export function edgeInOf(block: Block): string | null {
  if (block.kind !== "loop") return block.edgeIn;
  const first = block.body.blocks[0];
  return first ? edgeInOf(first) : null;
}

/** Sets the edge a block is entered by (a loop: its first block's). */
export function setEdgeIn(block: Block, edgeId: string): void {
  if (block.kind === "loop") {
    const first = block.body.blocks[0];
    if (first) setEdgeIn(first, edgeId);
  } else block.edgeIn = edgeId;
}

/** {@link unwrapLoop} on `t` (a clone), without the checks. */
export function applyUnwrapLoop(t: BlockTree, nodeId: string): void {
  const { parent, index, loop } = loopToUnwrap(t, nodeId)!;
  const next = parent.blocks[index + 1];
  const after = parent.exit;
  // A bounded loop's latch goes on along its ordinary edge (the edge into
  // what follows the loop), not along its loop edge, which goes.
  const exitEdgeId = !loop.loopEdge
    ? null
    : next
      ? edgeInOf(next)
      : after.kind !== "stop"
        ? (after.edgeId ?? null)
        : null;
  const goOn = (old: { edgeId?: string | null }): SeqExit => {
    const edgeId =
      loop.loopEdge && old.edgeId === loop.loopEdge.edgeId
        ? exitEdgeId
        : (old.edgeId ?? null);
    if (next) return { kind: "fallthrough", to: firstNodeOf(next).id, edgeId };
    if (after.kind === "fallthrough") {
      return { kind: "fallthrough", to: after.to, edgeId };
    }
    if (after.kind === "link") {
      return {
        kind: "link",
        target: after.target,
        edgeId: edgeId ?? crypto.randomUUID(),
      };
    }
    // A loop that ended its sequence (nothing left it): the run ends.
    if (after.kind === "end" || after.reason === "blockEnds") {
      return { kind: "end", edgeId };
    }
    // A bounded loop whose last step had no edge on: its branch ends.
    if (loop.loopEdge) return { kind: "stop", reason: "noEdge" };
    throw new Error("unwrapLoop: the sequence around the loop has no ending");
  };
  const body = loop.body;
  redirectFallthroughs([body], loop.headerId, goOn);
  parent.blocks.splice(index, 1, ...body.blocks);
  const last = body.blocks[body.blocks.length - 1];
  if (next) {
    // The body's own last edge (a back edge) now enters the next block.
    if (
      body.exit.kind === "fallthrough" &&
      body.exit.edgeId &&
      last?.kind === "step"
    ) {
      setEdgeIn(next, body.exit.edgeId);
    }
  } else {
    parent.exit =
      last?.kind === "fork" && last.merge === null
        ? { kind: "stop", reason: "blockEnds" }
        : body.exit;
  }
  repath(parent);
}

/** Where the loop whose header is `headerId` stands: its sequence and index. */
export function locateLoop(
  tree: BlockTree,
  headerId: string,
): { seq: Seq; index: number; loop: LoopBlock } | null {
  for (const seq of allSeqs(tree)) {
    const index = seq.blocks.findIndex(
      (b) => b.kind === "loop" && b.headerId === headerId,
    );
    if (index !== -1) {
      return { seq, index, loop: seq.blocks[index] as LoopBlock };
    }
  }
  return null;
}

/** What a loop's bounds are set to: any subset; none at all repeats until
 *  the run stops. */
export interface LoopBoundsInput {
  times?: number;
  forSeconds?: number;
  until?: { value: unknown; cases: unknown[] };
}

/** Gives the plain loop `headerId` of `t` (a clone) a loop edge: its back
 *  edge, with `bounds`. */
export function boundPlainLoop(
  t: BlockTree,
  headerId: string,
  bounds: LoopBoundsInput,
): void {
  const { seq, index, loop } = locateLoop(t, headerId)!;
  loop.loopEdge = { edgeId: loop.backEdgeIds[0], loop: bounds };
  // Nothing ended the sequence after the loop but the loop itself: now its
  // last step's branch ends when a bound fires.
  if (
    index === seq.blocks.length - 1 &&
    seq.exit.kind === "stop" &&
    seq.exit.reason === "blockEnds"
  ) {
    seq.exit = { kind: "stop", reason: "noEdge" };
  }
}
