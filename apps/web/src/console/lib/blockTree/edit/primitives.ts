import { isTerminal } from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

import type {
  Block,
  BlockTree,
  ForkBlock,
  LoopBlock,
  Seq,
  SeqExit,
  SeqPath,
  StepBlock,
} from "../types";
import { allSeqs, firstNodeOf, nodeAtSlot } from "../treeHelpers";

/** A copy of the tree's structure (sequences, blocks, lanes, exits); nodes
 *  and link edges are shared. */
export function cloneTree(tree: BlockTree): BlockTree {
  const cloneSeq = (seq: Seq): Seq => ({
    path: seq.path,
    exit: { ...seq.exit },
    blocks: seq.blocks.map((block): Block => {
      if (block.kind === "step") return { ...block };
      if (block.kind === "loop") {
        return {
          ...block,
          backEdgeIds: [...block.backEdgeIds],
          body: cloneSeq(block.body),
        };
      }
      return {
        ...block,
        merge: block.merge ? { ...block.merge } : null,
        lanes: block.lanes.map((lane) => ({
          ...lane,
          body: cloneSeq(lane.body),
        })),
      };
    }),
  });
  return {
    ...tree,
    root: cloneSeq(tree.root),
    detached: tree.detached.map(cloneSeq),
    links: [...tree.links],
  };
}

/** The sequence at `path` in `tree`, or null. */
export function seqAt(tree: BlockTree, path: SeqPath): Seq | null {
  const parts = path.split("/");
  let seq: Seq | undefined;
  let i: number;
  if (parts[0] === "root") {
    seq = tree.root;
    i = 1;
  } else if (parts[0] === "detached") {
    seq = tree.detached[Number(parts[1])];
    i = 2;
  } else return null;
  while (seq && i < parts.length) {
    const block: Block | undefined = seq.blocks[Number(parts[i])];
    if (!block) return null;
    if (parts[i + 1] === "body" && block.kind === "loop") {
      seq = block.body;
      i += 2;
    } else if (parts[i + 1] === "lanes" && block.kind === "fork") {
      seq = block.lanes[Number(parts[i + 2])]?.body;
      i += 3;
    } else return null;
  }
  return seq ?? null;
}

/** The loop whose body `path` is, or null. */
export function loopOfBody(tree: BlockTree, path: SeqPath): LoopBlock | null {
  const m = /^(.*)\/(\d+)\/body$/.exec(path);
  if (!m) return null;
  const block = seqAt(tree, m[1])?.blocks[Number(m[2])];
  return block?.kind === "loop" ? block : null;
}

/** Where a node's block is: its sequence and index (the origin of a chain
 *  root is not a block). */
export function locate(
  tree: BlockTree,
  nodeId: string,
): { seq: Seq; index: number; block: StepBlock | ForkBlock } | null {
  for (const seq of allSeqs(tree)) {
    const index = seq.blocks.findIndex(
      (b) => b.kind !== "loop" && b.node.id === nodeId,
    );
    if (index !== -1) {
      return {
        seq,
        index,
        block: seq.blocks[index] as StepBlock | ForkBlock,
      };
    }
  }
  return null;
}

/** Rewrites every fallthrough exit to `fromId` inside `seqs` (recursively). */
export function redirectFallthroughs(
  seqs: readonly Seq[],
  fromId: string,
  to: (old: Extract<SeqExit, { kind: "fallthrough" }>) => SeqExit,
): void {
  const visit = (seq: Seq) => {
    for (const block of seq.blocks) {
      if (block.kind === "fork") {
        for (const lane of block.lanes) visit(lane.body);
        if (block.merge?.nodeId === fromId) {
          const next = to({ kind: "fallthrough", to: fromId });
          block.merge =
            next.kind === "fallthrough"
              ? { ...block.merge, nodeId: next.to }
              : null;
        }
      }
      if (block.kind === "loop") visit(block.body);
    }
    if (seq.exit.kind === "fallthrough" && seq.exit.to === fromId) {
      seq.exit = to(seq.exit);
    }
  };
  seqs.forEach(visit);
}

/** The sequences inside one block. */
export const innerSeqs = (block: Block | undefined): Seq[] =>
  !block || block.kind === "step"
    ? []
    : block.kind === "loop"
      ? [block.body]
      : block.lanes.map((l) => l.body);

/** Whether anything inside `block` falls through to `nodeId`. */
export function fallsThroughTo(block: Block, nodeId: string): boolean {
  let found = false;
  const visit = (seq: Seq) => {
    if (seq.exit.kind === "fallthrough" && seq.exit.to === nodeId) found = true;
    for (const b of seq.blocks) innerSeqs(b).forEach(visit);
  };
  innerSeqs(block).forEach(visit);
  return found;
}

export function slotReachable(seq: Seq, index: number): boolean {
  if (index === 0) return true;
  const prev = seq.blocks[index - 1];
  if (prev.kind === "step") return !isTerminal(prev.node);
  // A bounded loop goes on after its last round.
  if (prev.kind === "loop" && prev.loopEdge) return true;
  const at = nodeAtSlot(seq, index);
  return at !== null && fallsThroughTo(prev, at);
}

/** Puts `block` (a new step or fork) at slot `index` of `seq`, rerouting
 *  what reached that slot into it. */
export function insertBlockAt(
  tree: BlockTree,
  seq: Seq,
  index: number,
  block: StepBlock | ForkBlock,
): void {
  const at = nodeAtSlot(seq, index);
  const id = block.node.id;
  if (index > 0 && at !== null) {
    const prev = seq.blocks[index - 1];
    redirectFallthroughs(innerSeqs(prev), at, (old) => ({ ...old, to: id }));
    // Between a fork and its merge: the lanes now meet at the new block.
    if (prev.kind === "fork" && prev.merge?.nodeId === at) {
      prev.merge = { ...prev.merge, nodeId: id };
    }
  }
  if (index === 0) {
    // A new first step of a loop is its new header: the back edges and
    // whatever entered the loop now enter it.
    const loop = loopOfBody(tree, seq.path);
    if (loop && at !== null) {
      redirectFallthroughs([tree.root, ...tree.detached], at, (old) => ({
        ...old,
        to: id,
      }));
      loop.headerId = id;
    }
  }
  // The edge that entered the slot now enters the new block; what was there
  // gets a new edge from it.
  const next = seq.blocks[index];
  if (next && next.kind !== "loop") {
    block.edgeIn = next.edgeIn;
    next.edgeIn = null;
  } else if (!next && seq.exit.kind !== "stop" && seq.blocks.length > 0) {
    const prev = seq.blocks[index - 1];
    // A step, or a bounded loop (its latch's edge on): that edge now enters
    // the new block.
    if (prev.kind === "step" || (prev.kind === "loop" && prev.loopEdge)) {
      block.edgeIn = seq.exit.edgeId ?? null;
      if (seq.exit.kind === "link") {
        seq.exit = { ...seq.exit, edgeId: crypto.randomUUID() };
      } else seq.exit = { ...seq.exit, edgeId: null };
    }
  }
  seq.blocks.splice(index, 0, block);
}

/** Where a run goes after the step at `index` of `seq` once that step
 *  (`removedId`) is gone: the next block, else the sequence's own ending; a
 *  loop that only repeated the step continues after the loop. */
export function continuationAfter(
  tree: BlockTree,
  seq: Seq,
  index: number,
  removedId: string,
):
  | { kind: "node"; id: string }
  | { kind: "end" }
  | { kind: "link"; target: string }
  | { kind: "stop" } {
  const following = seq.blocks[index + 1];
  if (following) return { kind: "node", id: firstNodeOf(following).id };
  const exit = seq.exit;
  if (exit.kind === "fallthrough") {
    if (exit.to !== removedId) return { kind: "node", id: exit.to };
    const m = /^(.*)\/(\d+)\/body$/.exec(seq.path);
    const parent = m ? seqAt(tree, m[1]) : null;
    return parent
      ? continuationAfter(tree, parent, Number(m![2]), removedId)
      : { kind: "stop" };
  }
  if (exit.kind === "end") return { kind: "end" };
  if (exit.kind === "link" && exit.target !== removedId) {
    return { kind: "link", target: exit.target };
  }
  return { kind: "stop" };
}

/** Whether a run in `seq` (or a lane nested in it) falls through to `id`. */
export function seqFallsThroughTo(seq: Seq, id: string): boolean {
  if (seq.exit.kind === "fallthrough" && seq.exit.to === id) return true;
  return seq.blocks.some((b) => fallsThroughTo(b, id));
}

/** Whether lane `laneIndex` of `fork` (inside the loop whose header is
 *  `headerId`) leaves the loop: the views draw it outside (see
 *  `lanesLeavingLoop` in stepTree.ts, which this mirrors). */
export function laneLeavesLoop(
  fork: ForkBlock,
  laneIndex: number,
  headerId: string,
  inner: ReadonlySet<string> = new Set(),
): boolean {
  if (fork.merge !== null) return false;
  // Falling through to the candidate header, or to a loop header passed on
  // the way down, repeats: the lane stays in the loop.
  const leaving = fork.lanes.map(
    (l) =>
      !seqFallsThroughTo(l.body, headerId) &&
      ![...inner].some((h) => seqFallsThroughTo(l.body, h)),
  );
  // Every lane leaving: the fork as a whole is the loop's way out.
  return leaving[laneIndex] === true && leaving.some((x) => !x);
}

/**
 * The innermost loop that repeats the sequence at `path`: a loop whose body
 * holds it, unless the way down from the body passes a lane that leaves the
 * loop (that lane runs once, after the loop). With the sequence the loop is
 * a block of and its index there.
 */
export function repeatingLoopAt(
  tree: BlockTree,
  path: SeqPath,
): { parent: Seq; index: number; loop: LoopBlock } | null {
  const re = /\/(\d+)\/body(?=\/|$)/g;
  const found: Array<{ at: number; end: number; index: number }> = [];
  for (let m = re.exec(path); m; m = re.exec(path)) {
    found.push({ at: m.index, end: m.index + m[0].length, index: +m[1] });
  }
  for (const c of found.reverse()) {
    const parent = seqAt(tree, path.slice(0, c.at));
    const loop = parent?.blocks[c.index];
    if (!parent || loop?.kind !== "loop") continue;
    const parts = path.slice(c.end).split("/").slice(1);
    let seq: Seq = loop.body;
    let repeats = true;
    const inner = new Set<string>();
    for (let k = 0; k < parts.length && repeats;) {
      const block: Block | undefined = seq.blocks[Number(parts[k])];
      if (parts[k + 1] === "body" && block?.kind === "loop") {
        inner.add(block.headerId);
        seq = block.body;
        k += 2;
      } else if (parts[k + 1] === "lanes" && block?.kind === "fork") {
        const j = Number(parts[k + 2]);
        if (laneLeavesLoop(block, j, loop.headerId, inner)) repeats = false;
        else seq = block.lanes[j].body;
        k += 3;
      } else repeats = false;
    }
    if (repeats) return { parent, index: c.index, loop };
  }
  return null;
}
