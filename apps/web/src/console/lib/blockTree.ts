/**
 * The block tree: the editor's model of a scenario graph (design: "Block-tree
 * editor model"). "Structure what can be structured; every other edge stays
 * visible as a link."
 *
 * - {@link recognizeBlockTree} reads a definition into nested sequences of
 *   steps, forks (START fan-out, switch / choice lanes, edges a step never
 *   follows) and loops. Every node other than END is placed exactly once;
 *   every edge is drawn once or kept once as a link. It reads the graph only
 *   through `lowerScenario` and its helpers, so it cannot disagree with what
 *   the executor runs, and it is deterministic: it follows file order and
 *   `pickableHandles` order, and never sorts ids.
 * - {@link rebuildFromTree} writes a (possibly edited) tree back. It never
 *   changes what the file means: edges are reused by (source, target,
 *   handle), then retargeted by (source, handle), keep their id, unknown
 *   fields and index in `edges`; links are written back untouched; existing
 *   node positions never move. A no-op round trip returns the input (except
 *   `updatedAt`).
 * - The operations ({@link insertStep}, {@link moveStep}, …) are pure
 *   `(def, tree, …) → def` functions over the tree; {@link editCapabilities}
 *   says which ones apply, with a message key when one does not.
 *
 * Deviations from the design, kept small and written down here:
 * - `BlockTree.origin`: the START a run begins with. When it fans out it is
 *   the node of the root's first ForkBlock; otherwise it is implicit before
 *   the root sequence (so the root holds only steps), and coverage counts it
 *   through this field.
 * - `ForkBlock.edgeIn`: like `StepBlock.edgeIn`, the edge the fork node is
 *   entered by, so a round trip can hand every edge its own id back.
 * - `SeqExit` "fallthrough" carries the `edgeId` it was drawn with, and
 *   "stop" has a fourth reason, `blockEnds`: the sequence's last block (a
 *   fork without merge, a loop without continuation) ends every path itself.
 * - `LaneCondition` `{ kind: "first" }`: the lane of a step's first edge when
 *   the step has more edges (an "extra" fork): the only lane that runs.
 * - A loop's exits other than the first: the design makes them join links.
 *   Here a link only when the target is already placed; a target nothing has
 *   placed yet is walked on in the lane that leaves the loop. Otherwise the
 *   common "a fork, one lane loops back to it" leaves its other lanes
 *   detached. So a loop body (`LoopBlock.body`) can hold steps that are not
 *   in the loop: the Steps and Graph views (step B / C) must draw a lane
 *   whose sequence does not end by falling through to the loop's header
 *   (an `end`, `stop`, `link`, or a fallthrough to another node) as leaving
 *   the loop at the fork it starts from: its steps run once, after the loop
 *   is left, and are drawn outside the loop's tinted area / C-block, with
 *   the lane's edge crossing the loop's boundary. Only lanes (and their
 *   nested lanes) that fall through to the header are repeated.
 * - Dead lanes (ignored / unpickable: edges the executor never takes) do
 *   not shape the tree. Back edges, loops, merges and a loop's exits are
 *   computed on the lanes that run, so a dead edge back to a step never
 *   makes a loop and a dead edge to END never takes a merge away. Dead lanes
 *   are walked after every live one (a node a run reaches is placed where
 *   it runs): one into a node drawn elsewhere (a merge and a loop header
 *   included) is a link with role `dead`; one into a node nothing else
 *   reaches places that node in the lane.
 * - A switch / choice whose only edge never runs (no handle, or one it
 *   cannot pick) is a one-lane fork, not a chain: a chain would draw a step
 *   that never runs as the next one.
 * - `Capability` `{ ok: true, note }`: an operation that applies and does
 *   something worth saying (removing a step's first edge runs its next one).
 * - Operations never make an edge that never ran start running (or stop a
 *   running edge) beyond what they are asked to do: an operation that would
 *   (removing the running lane of a handle another edge also has, removing
 *   a step whose edge in is a step's first of several) is refused with
 *   `revivesDeadEdge`.
 * - Loop edges (schema 1.10, `kind: "loop"`): a loop edge `S → H` that
 *   the tree can structure is a {@link LoopBlock} with `loopEdge` set (a
 *   "bounded" loop, whatever its bounds): `H` is its header, the body ends
 *   at `S` (its latch, the one place that falls through to the header) and
 *   `S`'s ordinary next edge is where the loop's sequence goes on. The latch
 *   is not stored: it is whichever step falls through to the header, so
 *   inserting, removing or moving the body's last step moves the loop edge
 *   with it (its id, `loop` and unknown fields stay). A loop edge the tree
 *   cannot structure (out of a fork, a second one into a header that has
 *   other back edges, an irreducible one) stays a `loopEdge` link, written
 *   back untouched. Operations never leave a bounded loop without exactly
 *   one latch that is a step leaving by "next": such an edit is refused with
 *   `breaksLoopBounds`.
 */
import type { Edge } from "@xyflow/react";

import {
  type ChoiceNodeData,
  type ScenarioDefinition,
  type ScenarioNode,
  ScenarioNodeType,
  type AnyScenarioNodeType,
  type SwitchNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { connectionRule } from "@ocpp-cp-simulator/core/scenario/scenarioConnectionRules";
import {
  isTerminal,
  pickableHandles,
} from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

import type { MessageKey } from "../../i18n";
import { createDefaultNode, updateStepData } from "./scenarioSteps";
import { conditionOf, isLive } from "./blockTree/structural";
import {
  hasBounds,
  type Block,
  type BlockTree,
  type ForkBlock,
  type ForkKind,
  type Lane,
  type LaneCondition,
  type LoopBlock,
  type Seq,
  type SeqExit,
  type SeqPath,
  type StepBlock,
} from "./blockTree/types";

import { recognizeBlockTree } from "./blockTree/recognize";
import { boundedLoopProblem, commit, requiredEdges } from "./blockTree/rebuild";
import {
  cloneTree,
  continuationAfter,
  insertBlockAt,
  loopOfBody,
  locate,
  redirectFallthroughs,
  repeatingLoopAt,
  seqAt,
  slotReachable,
} from "./blockTree/edit/primitives";
import {
  firstNodeOf,
  allSeqs,
  nodeAtSlot,
  treeNodes,
} from "./blockTree/treeHelpers";

export { recognizeBlockTree } from "./blockTree/recognize";
export {
  assertFirstEdgeWins,
  assertMergesConsistent,
  boundedLoopProblem,
  rebuildFromTree,
} from "./blockTree/rebuild";
export type { StructuralEdge } from "./blockTree/rebuild";
export { seqAt } from "./blockTree/edit/primitives";
export {
  firstNodeOf,
  allSeqs,
  treeNodes,
  assertTreeCovers,
} from "./blockTree/treeHelpers";
export { hasBounds, loopBlockBounds } from "./blockTree/types";
export type {
  Block,
  BlockTree,
  ForkBlock,
  ForkKind,
  Lane,
  LaneCondition,
  LinkEdge,
  LoopBlock,
  LoopEdgeRef,
  Seq,
  SeqExit,
  SeqPath,
  StepBlock,
} from "./blockTree/types";

// ---------------------------------------------------------------------------
// Operations (design §4)

/** Inserts a new step of `type` at slot `index` of the sequence at `path`. */
export function insertStep(
  def: ScenarioDefinition,
  tree: BlockTree,
  path: SeqPath,
  index: number,
  type: AnyScenarioNodeType,
): ScenarioDefinition {
  if (!canInsertAt(tree, path, index).ok) return def;
  const t = cloneTree(tree);
  const seq = seqAt(t, path)!;
  insertBlockAt(t, seq, index, {
    kind: "step",
    node: createDefaultNode(type),
    edgeIn: null,
  });
  return commit(def, t);
}

/** Takes the step block at `index` out of `seq`, rerouting what reached it
 *  to what came after it. Returns the block. */
function removeStepBlockAt(
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

/** Removes the step `nodeId`. A fork node with two or more lanes and the
 *  origin cannot be removed; a fork with one lane folds into its parent. */
export function removeStep(
  def: ScenarioDefinition,
  tree: BlockTree,
  nodeId: string,
): ScenarioDefinition {
  if (!editCapabilities(tree, { kind: "node", nodeId }).removeStep.ok) {
    return def;
  }
  const t = cloneTree(tree);
  applyRemoveStep(t, nodeId);
  return commit(def, t);
}

/** {@link removeStep} on `t` (a clone), without the checks. */
function applyRemoveStep(t: BlockTree, nodeId: string): void {
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

/** Moves the step at `from` of the sequence at `path` to slot `to` (an
 *  index in the sequence without it). A move never leaves its sequence. */
export function moveStep(
  def: ScenarioDefinition,
  tree: BlockTree,
  path: SeqPath,
  from: number,
  to: number,
): ScenarioDefinition {
  if (from === to) return def;
  if (!canMove(tree, path, from, to).ok) return def;
  const t = cloneTree(tree);
  applyMoveStep(t, path, from, to);
  return commit(def, t);
}

/** {@link moveStep} on `t` (a clone), without the checks. */
function applyMoveStep(t: BlockTree, path: SeqPath, from: number, to: number) {
  const seq = seqAt(t, path)!;
  const block = removeStepBlockAt(t, seq, from, true);
  insertBlockAt(t, seq, to, { kind: "step", node: block.node, edgeIn: null });
}

function newLaneHandle(fork: ScenarioNode, lanes: readonly Lane[]) {
  const usedHandles = new Set(lanes.map((l) => l.handle));
  return (pickableHandles(fork) ?? []).find((h) => !usedHandles.has(h)) ?? null;
}

function laneConditionFor(
  node: ScenarioNode,
  forkKind: ForkKind,
  handle: string | null,
  lanes: readonly Lane[],
): LaneCondition {
  if (forkKind === "start" || forkKind === "parallel") return { kind: "all" };
  const handles = pickableHandles(node);
  if (handles && handle !== null && handles.includes(handle)) {
    return lanes.some((l) => l.handle === handle)
      ? { kind: "ignored" }
      : conditionOf(node, handle);
  }
  if (handles) return { kind: "unpickable", handle };
  return { kind: "ignored" };
}

/**
 * Adds a lane holding one Delay step to the fork of `nodeId` (START, a
 * switch, a choice; later a parallel node). A START or switch / choice that
 * is still a chain becomes a fork whose first lane is its current
 * continuation. The new lane runs to the fork's merge, else to END.
 */
export function addLane(
  def: ScenarioDefinition,
  tree: BlockTree,
  nodeId: string,
): ScenarioDefinition {
  if (!editCapabilities(tree, { kind: "node", nodeId }).addLane.ok) return def;
  const t = cloneTree(tree);
  const delay = (): StepBlock => ({
    kind: "step",
    node: createDefaultNode(ScenarioNodeType.DELAY),
    edgeIn: null,
  });
  const found = locate(t, nodeId);
  if (!found && t.origin?.id === nodeId) {
    // A chain from START: the chain becomes the first lane.
    const oldRoot = t.root;
    const firstEdge =
      oldRoot.blocks[0] && oldRoot.blocks[0].kind !== "loop"
        ? oldRoot.blocks[0].edgeIn
        : oldRoot.blocks[0]?.kind === "loop"
          ? (oldRoot.blocks[0].body.blocks[0] as StepBlock | ForkBlock).edgeIn
          : oldRoot.exit.kind !== "stop"
            ? (oldRoot.exit.edgeId ?? null)
            : null;
    const lanes: Lane[] = [];
    const rePath = (seq: Seq, path: SeqPath): Seq => ({
      ...seq,
      path,
      blocks: seq.blocks.map((b, i) =>
        b.kind === "step"
          ? b
          : b.kind === "loop"
            ? { ...b, body: rePath(b.body, `${path}/${i}/body`) }
            : {
                ...b,
                lanes: b.lanes.map((l, j) => ({
                  ...l,
                  body: rePath(l.body, `${path}/${i}/lanes/${j}`),
                })),
              },
      ),
    });
    if (oldRoot.blocks.length > 0 || oldRoot.exit.kind !== "stop") {
      lanes.push({
        edgeId: firstEdge ?? crypto.randomUUID(),
        handle: null,
        condition: { kind: "all" },
        body: rePath(oldRoot, "root/0/lanes/0"),
      });
    }
    lanes.push({
      edgeId: crypto.randomUUID(),
      handle: null,
      condition: { kind: "all" },
      body: {
        path: `root/0/lanes/${lanes.length}`,
        blocks: [delay()],
        exit: { kind: "end", edgeId: null },
      },
    });
    t.root = {
      path: "root",
      blocks: [
        {
          kind: "fork",
          forkKind: "start",
          node: t.origin,
          edgeIn: null,
          lanes,
          merge: null,
        },
      ],
      exit: { kind: "stop", reason: "blockEnds" },
    };
    return commit(def, t);
  }
  if (!found) return def;
  const { seq, index } = found;
  let fork: ForkBlock;
  if (found.block.kind === "step") {
    // A switch / choice with one edge: that edge becomes the first lane,
    // both lanes meet again where it went.
    const step = found.block;
    const following = seq.blocks[index + 1];
    const into = following
      ? firstNodeOf(following).id
      : seq.exit.kind === "fallthrough"
        ? seq.exit.to
        : null;
    const oldEdge = following
      ? following.kind === "loop"
        ? (following.body.blocks[0] as StepBlock | ForkBlock).edgeIn
        : following.edgeIn
      : seq.exit.kind !== "stop"
        ? (seq.exit.edgeId ?? null)
        : null;
    const oldHandle =
      def.edges.find((e) => e.id === oldEdge)?.sourceHandle ?? null;
    const laneExit: SeqExit =
      into !== null
        ? { kind: "fallthrough", to: into, edgeId: oldEdge }
        : seq.exit.kind === "link"
          ? { ...seq.exit }
          : seq.exit.kind === "end"
            ? { kind: "end", edgeId: oldEdge }
            : { kind: "stop", reason: "noEdge" };
    fork = {
      kind: "fork",
      forkKind:
        step.node.type === ScenarioNodeType.CHOICE ? "choice" : "switch",
      node: step.node,
      edgeIn: step.edgeIn,
      lanes: [],
      merge: into !== null ? { kind: "node", nodeId: into } : null,
    };
    if (oldEdge !== null) {
      fork.lanes.push({
        edgeId: oldEdge,
        handle: oldHandle,
        condition: laneConditionFor(step.node, fork.forkKind, oldHandle, []),
        body: {
          path: `${seq.path}/${index}/lanes/0`,
          blocks: [],
          exit: laneExit,
        },
      });
    }
    if (following && following.kind !== "loop") following.edgeIn = null;
    seq.blocks[index] = fork;
    if (into === null) seq.exit = { kind: "stop", reason: "blockEnds" };
    else if (!following)
      seq.exit = { kind: "fallthrough", to: into, edgeId: null };
  } else fork = found.block;
  const handle =
    fork.forkKind === "start" ? null : newLaneHandle(fork.node, fork.lanes);
  const exit: SeqExit = fork.merge
    ? { kind: "fallthrough", to: fork.merge.nodeId, edgeId: null }
    : { kind: "end", edgeId: null };
  fork.lanes.push({
    edgeId: crypto.randomUUID(),
    handle,
    condition: laneConditionFor(fork.node, fork.forkKind, handle, fork.lanes),
    body: {
      path: `${seq.path}/${index}/lanes/${fork.lanes.length}`,
      blocks: [delay()],
      exit,
    },
  });
  return commit(def, t);
}

/** Removes lane `laneIndex` of the fork of `nodeId` and every step in it.
 *  The last lane cannot go, nor a running lane whose removal would let an
 *  edge that never ran run (another edge with its handle). Removing the
 *  first edge of a step with more runs its next one: that is allowed, and
 *  the capability carries a note saying so. */
export function removeLane(
  def: ScenarioDefinition,
  tree: BlockTree,
  nodeId: string,
  laneIndex: number,
): ScenarioDefinition {
  if (
    !editCapabilities(tree, { kind: "lane", nodeId, laneIndex }).removeLane.ok
  ) {
    return def;
  }
  const t = cloneTree(tree);
  applyRemoveLane(t, nodeId, laneIndex);
  return commit(def, t);
}

/** {@link removeLane} on `t` (a clone), without the checks. */
function applyRemoveLane(t: BlockTree, nodeId: string, laneIndex: number) {
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

/**
 * Inserts a new switch or choice at slot `index` of the sequence at `path`,
 * with one empty lane per handle it can pick. Its lanes meet again at the
 * block that followed (its merge); at the end of a sequence each lane takes
 * the sequence's own ending. `parallel` is an extension point (no node type
 * yet).
 */
export function insertForkBlock(
  def: ScenarioDefinition,
  tree: BlockTree,
  path: SeqPath,
  index: number,
  kind: "switch" | "choice",
): ScenarioDefinition {
  if (!canInsertAt(tree, path, index).ok) return def;
  const t = cloneTree(tree);
  const seq = seqAt(t, path)!;
  const made = createDefaultNode(
    kind === "switch" ? ScenarioNodeType.SWITCH : ScenarioNodeType.CHOICE,
  );
  // A switch starts as an if / else: one case and the default.
  const node: ScenarioNode =
    kind === "switch" && Array.isArray((made.data as SwitchNodeData).cases)
      ? {
          ...made,
          data: {
            ...made.data,
            cases: (made.data as SwitchNodeData).cases.slice(0, 1),
          },
        }
      : made;
  const at = nodeAtSlot(seq, index);
  const lastExit = seq.exit;
  const fork: ForkBlock = {
    kind: "fork",
    forkKind: kind,
    node,
    edgeIn: null,
    lanes: [],
    merge: at !== null ? { kind: "node", nodeId: at } : null,
  };
  (pickableHandles(node) ?? []).forEach((handle, j) => {
    const edgeId = crypto.randomUUID();
    const exit: SeqExit =
      at !== null
        ? { kind: "fallthrough", to: at, edgeId }
        : lastExit.kind === "link"
          ? { kind: "link", target: lastExit.target, edgeId }
          : lastExit.kind === "end"
            ? { kind: "end", edgeId }
            : { kind: "stop", reason: "noEdge" };
    fork.lanes.push({
      edgeId,
      handle,
      condition: conditionOf(node, handle),
      body: { path: `${path}/${index}/lanes/${j}`, blocks: [], exit },
    });
  });
  insertBlockAt(t, seq, index, fork);
  if (at === null) seq.exit = { kind: "stop", reason: "blockEnds" };
  return commit(def, t);
}

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

/** The bounds a loop made in the middle of a sequence starts with. */
export const DEFAULT_LOOP_BOUNDS: Readonly<{ times: number }> = { times: 3 };

/** Whether a loop of blocks `from`..`to` of `seq` would have something
 *  after it (a block, or a fallthrough to a merge): it then needs bounds. */
function loopNeedsBounds(seq: Seq, to: number): boolean {
  return to < seq.blocks.length - 1 || seq.exit.kind === "fallthrough";
}

/** {@link wrapInLoop} on `seq` (of a clone), without the checks. */
function applyWrapInLoop(seq: Seq, from: number, to: number): void {
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

/** Takes the step `nodeId` out of where it is and puts it at slot `index`
 *  of the sequence at `path` (`loop`: as the first step of a new Repeat
 *  block there). The tree is a clone; null when refused, with the reason. */
function simulateMoveTo(
  tree: BlockTree,
  nodeId: string,
  path: SeqPath,
  index: number,
  loop: boolean,
): { t: BlockTree; target: Seq; at: number } | { reason: MessageKey } {
  const found = locate(tree, nodeId);
  if (!found) return { reason: "scenarios.editor.cannot.notInTree" };
  if (found.block.kind !== "step") {
    return { reason: "scenarios.editor.cannot.notAStep" };
  }
  if (isTerminal(found.block.node)) {
    return { reason: "scenarios.editor.cannot.terminalStep" };
  }
  const removal = editCapabilities(tree, { kind: "node", nodeId }).removeStep;
  if (!removal.ok) return { reason: removal.reason };
  if (!seqAt(tree, path))
    return { reason: "scenarios.editor.cannot.notInTree" };
  const t = cloneTree(tree);
  const src = locate(t, nodeId)!;
  const target = seqAt(t, path)!;
  if (src.seq === target) {
    const n = target.blocks.length;
    // The loop closes the sequence: the step itself being last is a wrap.
    if (!(loop && src.index === n - 1 && index === n)) {
      if (index === src.index || index === src.index + 1) {
        return { reason: "scenarios.editor.cannot.samePlace" };
      }
    }
  }
  if (src.seq === target && loop && src.index === target.blocks.length - 1) {
    // Wrapping the last step of its own sequence where it stands.
    const cap = canWrapInLoop(t, path, src.index, src.index);
    if (!cap.ok) return { reason: cap.reason };
    applyWrapInLoop(target, src.index, src.index);
    [t.root, ...t.detached].forEach(repath);
    return { t, target, at: src.index };
  }
  const block = removeStepBlockAt(t, src.seq, src.index, true);
  [t.root, ...t.detached].forEach(repath);
  // `index` counts the slots as they were: a step taken out above the slot
  // moves it up by one.
  const at = src.seq === target && src.index < index ? index - 1 : index;
  const slot = loop
    ? canInsertLoopAt(t, target.path, at)
    : canInsertAt(t, target.path, at);
  if (!slot.ok) return { reason: slot.reason };
  insertBlockAt(t, target, at, {
    kind: "step",
    node: block.node,
    edgeIn: null,
  });
  if (loop) {
    const cap = canWrapInLoop(t, target.path, at, at);
    if (!cap.ok) return { reason: cap.reason };
    applyWrapInLoop(target, at, at);
  }
  [t.root, ...t.detached].forEach(repath);
  if (boundedLoopProblem(t) !== null) {
    return { reason: "scenarios.editor.cannot.breaksLoopBounds" };
  }
  return { t, target, at };
}

/**
 * Whether the step `nodeId` can be dropped at slot `index` of the sequence at
 * `path` (any sequence: a drag across lanes and into or out of loops is a
 * remove and an insert). `loop`: into a new Repeat block at that slot.
 */
export function canMoveStepTo(
  tree: BlockTree,
  nodeId: string,
  path: SeqPath,
  index: number,
  loop = false,
): Capability {
  const out = simulateMoveTo(tree, nodeId, path, index, loop);
  return "reason" in out ? no(out.reason) : OK;
}

/**
 * Moves the step `nodeId` to slot `index` of the sequence at `path`, across
 * sequences if need be. Returns `def` itself when refused (see
 * {@link canMoveStepTo}) or when the result would not read back as asked.
 */
export function moveStepTo(
  def: ScenarioDefinition,
  tree: BlockTree,
  nodeId: string,
  path: SeqPath,
  index: number,
  loop = false,
): ScenarioDefinition {
  const out = simulateMoveTo(tree, nodeId, path, index, loop);
  if ("reason" in out) return def;
  const next = commit(def, out.t);
  // Safety net: the file must read back with the step where it was dropped.
  const back = recognizeBlockTree(next);
  const place = back.nodePath.get(nodeId);
  const want = loop ? `${out.target.path}/${out.at}/body` : out.target.path;
  if (!place || place.path !== want) return def;
  return next;
}

/** The loop {@link unwrapLoop} takes away for a selected node: the
 *  innermost one that repeats it (a loop header: its own loop). */
function loopToUnwrap(
  tree: BlockTree,
  nodeId: string,
): { parent: Seq; index: number; loop: LoopBlock } | null {
  const found = locate(tree, nodeId);
  return found ? repeatingLoopAt(tree, found.seq.path) : null;
}

/** Rewrites the paths of the sequences nested in `seq` after its blocks
 *  moved. */
function repath(seq: Seq): void {
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
function edgeInOf(block: Block): string | null {
  if (block.kind !== "loop") return block.edgeIn;
  const first = block.body.blocks[0];
  return first ? edgeInOf(first) : null;
}

/** Sets the edge a block is entered by (a loop: its first block's). */
function setEdgeIn(block: Block, edgeId: string): void {
  if (block.kind === "loop") {
    const first = block.body.blocks[0];
    if (first) setEdgeIn(first, edgeId);
  } else block.edgeIn = edgeId;
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

/** {@link unwrapLoop} on `t` (a clone), without the checks. */
function applyUnwrapLoop(t: BlockTree, nodeId: string): void {
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

/**
 * Makes the step `nodeId` (the last block of its sequence) jump to
 * `target`, a placed step other than START, or run to END with `null`.
 */
export function setLink(
  def: ScenarioDefinition,
  tree: BlockTree,
  nodeId: string,
  target: string | null,
): ScenarioDefinition {
  const caps = editCapabilities(tree, { kind: "node", nodeId });
  if (!caps.setLink.ok) return def;
  if (
    target !== null &&
    (target === tree.origin?.id || !tree.nodePath.has(target))
  ) {
    return def;
  }
  const t = cloneTree(tree);
  const { seq } = locate(t, nodeId)!;
  const current = seq.exit;
  const currentTarget =
    current.kind === "link"
      ? current.target
      : current.kind === "fallthrough"
        ? current.to
        : null;
  if (
    (current.kind === "end" && target === null) ||
    (current.kind !== "end" && target !== null && target === currentTarget)
  ) {
    return def; // Already there.
  }
  const edgeId = current.kind !== "stop" ? (current.edgeId ?? null) : null;
  seq.exit =
    target === null
      ? { kind: "end", edgeId }
      : { kind: "link", target, edgeId: edgeId ?? crypto.randomUUID() };
  return commit(def, t);
}

/** Sets the `sourceHandle` of lane `laneIndex` of the fork of `nodeId`. A
 *  handle another lane already has is refused (`def` unchanged): only the
 *  first of the two would run. So is moving a running lane off a handle
 *  another (ignored) lane has: that one would start running. */
export function setLaneHandle(
  def: ScenarioDefinition,
  tree: BlockTree,
  nodeId: string,
  laneIndex: number,
  handle: string | null,
): ScenarioDefinition {
  if (
    !editCapabilities(tree, { kind: "lane", nodeId, laneIndex }).setLaneHandle
      .ok
  ) {
    return def;
  }
  const t = cloneTree(tree);
  const found = locate(t, nodeId);
  if (found?.block.kind !== "fork") return def;
  const fork = found.block;
  const lane = fork.lanes[laneIndex];
  if (!lane || fork.forkKind === "start") return def;
  if (lane.handle === handle) return def; // Already there.
  // Two lanes with one handle: only the first in file order would run.
  if (
    handle !== null &&
    fork.lanes.some((l) => l !== lane && l.handle === handle)
  ) {
    return def;
  }
  lane.handle = handle;
  lane.condition = laneConditionFor(
    fork.node,
    fork.forkKind,
    handle,
    fork.lanes.filter((l) => l !== lane),
  );
  return commit(def, t);
}

/**
 * Writes the condition of lane `laneIndex` of the switch / choice `nodeId`:
 * a switch case's value (`cases[i]`) or a choice option's weight / label
 * (`options[i]`). Other lanes have no condition of their own.
 */
export function setLaneCondition(
  def: ScenarioDefinition,
  tree: BlockTree,
  nodeId: string,
  laneIndex: number,
  value: unknown,
): ScenarioDefinition {
  const found = locate(tree, nodeId);
  if (found?.block.kind !== "fork") return def;
  const lane = found.block.lanes[laneIndex];
  const node = found.block.node;
  if (lane?.condition.kind === "case") {
    const data = node.data as SwitchNodeData;
    const cases = [...data.cases];
    cases[lane.condition.index] = value;
    return updateStepData(def, nodeId, { ...data, cases });
  }
  if (lane?.condition.kind === "option") {
    const data = node.data as ChoiceNodeData;
    const options = [...data.options];
    options[lane.condition.index] = {
      ...options[lane.condition.index],
      ...(value as { weight?: number; label?: string }),
    };
    return updateStepData(def, nodeId, { ...data, options });
  }
  return def;
}

// ---------------------------------------------------------------------------
// Capabilities

/** `note`: the operation applies, and does something the user should be
 *  told about (shown with the button). */
export type Capability =
  { ok: true; note?: MessageKey } | { ok: false; reason: MessageKey };

const OK: Capability = { ok: true };
const no = (reason: MessageKey): Capability => ({ ok: false, reason });

export type EditSelection =
  | { kind: "slot"; path: SeqPath; index: number }
  | { kind: "node"; nodeId: string }
  | { kind: "lane"; nodeId: string; laneIndex: number };

export interface EditCapabilities {
  insertStep: Capability;
  insertForkBlock: Capability;
  moveUp: Capability;
  moveDown: Capability;
  removeStep: Capability;
  addLane: Capability;
  removeLane: Capability;
  wrapInLoop: Capability;
  /** "Stop repeating": the innermost loop that repeats the selection. */
  unwrapLoop: Capability;
  setLink: Capability;
  setLaneHandle: Capability;
  setLaneCondition: Capability;
}

function canInsertAt(
  tree: BlockTree,
  path: SeqPath,
  index: number,
): Capability {
  const seq = seqAt(tree, path);
  if (!seq || index < 0 || index > seq.blocks.length) {
    return no("scenarios.editor.cannot.notInTree");
  }
  if (path === "root" && !tree.origin) {
    return no("scenarios.editor.cannot.noStart");
  }
  const first = seq.blocks[0];
  if (
    path === "root" &&
    index === 0 &&
    first?.kind === "fork" &&
    first.node.id === tree.origin?.id
  ) {
    return no("scenarios.editor.cannot.startNode");
  }
  if (!slotReachable(seq, index)) {
    const prev = seq.blocks[index - 1];
    return no(
      prev?.kind === "step"
        ? "scenarios.editor.cannot.afterTerminal"
        : "scenarios.editor.cannot.afterBlockEnds",
    );
  }
  return OK;
}

function canMove(
  tree: BlockTree,
  path: SeqPath,
  from: number,
  to: number,
): Capability {
  const seq = seqAt(tree, path);
  const block = seq?.blocks[from];
  if (!seq || !block) return no("scenarios.editor.cannot.notInTree");
  if (block.kind !== "step") return no("scenarios.editor.cannot.notAStep");
  if (from === 0 && loopOfBody(tree, path)) {
    return no("scenarios.editor.cannot.loopHeader");
  }
  if (isTerminal(block.node)) return no("scenarios.editor.cannot.terminalStep");
  if (to < 0 || to > seq.blocks.length - 1) {
    return no("scenarios.editor.cannot.atEdge");
  }
  // Only between steps: a fork's merge or a loop's continuation must stay.
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let i = lo; i <= hi; i++) {
    if (seq.blocks[i].kind !== "step") {
      return no("scenarios.editor.cannot.acrossBlock");
    }
  }
  if (lo > 0 && seq.blocks[lo - 1].kind !== "step") {
    return no("scenarios.editor.cannot.acrossBlock");
  }
  if (to === 0 && loopOfBody(tree, path)) {
    return no("scenarios.editor.cannot.loopHeader");
  }
  return OK;
}

/** Whether the step at `from` of the sequence at `path` can move to slot
 *  `to` (a drag over several places; one place: `moveUp` / `moveDown`). */
export function canMoveStep(
  tree: BlockTree,
  path: SeqPath,
  from: number,
  to: number,
): Capability {
  return canMove(tree, path, from, to);
}

export function canWrapInLoop(
  tree: BlockTree,
  path: SeqPath,
  from: number,
  to: number,
): Capability {
  const seq = seqAt(tree, path);
  if (!seq || from < 0 || to < from || to >= seq.blocks.length) {
    return no("scenarios.editor.cannot.notInTree");
  }
  const first = seq.blocks[from];
  const last = seq.blocks[to];
  if (first.kind === "loop" || (from === 0 && loopOfBody(tree, path))) {
    return no("scenarios.editor.cannot.loopHeader");
  }
  if (last.kind !== "step" || isTerminal(last.node)) {
    return no("scenarios.editor.cannot.loopNeedsStep");
  }
  if (
    path === "root" &&
    from === 0 &&
    first.kind === "fork" &&
    first.node.id === tree.origin?.id
  ) {
    return no("scenarios.editor.cannot.startNode");
  }
  if (loopNeedsBounds(seq, to)) {
    // A bounded loop is checked after its last step, which then goes on
    // along its ordinary edge: a switch / choice cannot.
    if (connectionRule(last.node.type).out !== "next") {
      return no("scenarios.editor.cannot.loopNeedsNextStep");
    }
    if (
      breaksLoopBounds(tree, (t) => applyWrapInLoop(seqAt(t, path)!, from, to))
    ) {
      return no("scenarios.editor.cannot.breaksLoopBounds");
    }
  }
  return OK;
}

/** Whether `edit` (applied to a clone of `tree`) leaves a bounded loop
 *  without its single latch. */
function breaksLoopBounds(
  tree: BlockTree,
  edit: (t: BlockTree) => void,
): boolean {
  const t = cloneTree(tree);
  edit(t);
  return boundedLoopProblem(t) !== null;
}

/** Where the loop whose header is `headerId` stands: its sequence and index. */
function locateLoop(
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

/**
 * Whether the loop whose header is `headerId` can take `bounds`. A loop
 * with something after it (a block, or a fallthrough to a merge) must keep
 * at least one bound (`unboundedMidLane`): without one the steps after it
 * would never run. A plain loop (a back edge) gets bounds by turning its one
 * back edge into a loop edge; with several back edges it cannot
 * (`loopSeveralBackEdges`), nor when its back edge leaves a switch / choice.
 */
export function canSetLoopBounds(
  tree: BlockTree,
  headerId: string,
  bounds: LoopBoundsInput | null,
): Capability {
  const found = locateLoop(tree, headerId);
  if (!found) return no("scenarios.editor.cannot.notInLoop");
  const { seq, index, loop } = found;
  const bounded = hasBounds(bounds);
  const after =
    index < seq.blocks.length - 1 ||
    seq.exit.kind === "fallthrough" ||
    seq.exit.kind === "link";
  if (!bounded && after) return no("scenarios.editor.cannot.unboundedMidLane");
  if (loop.loopEdge || !bounded) return OK;
  if (loop.backEdgeIds.length !== 1) {
    return no("scenarios.editor.cannot.loopSeveralBackEdges");
  }
  if (breaksLoopBounds(tree, (t) => boundPlainLoop(t, headerId, bounds!))) {
    return no("scenarios.editor.cannot.loopNeedsNextStep");
  }
  return OK;
}

/** Gives the plain loop `headerId` of `t` (a clone) a loop edge: its back
 *  edge, with `bounds`. */
function boundPlainLoop(
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

/** Where lane `lanePath` is: its fork (a switch or choice) and the parent
 *  sequence the fork stands in. */
function laneParent(
  tree: BlockTree,
  lanePath: SeqPath,
): { parent: Seq; forkIndex: number; fork: ForkBlock; seq: Seq } | null {
  const m = /^(.*)\/(\d+)\/lanes\/(\d+)$/.exec(lanePath);
  const seq = seqAt(tree, lanePath);
  if (!m || !seq) return null;
  const parent = seqAt(tree, m[1]);
  const fork = parent?.blocks[Number(m[2])];
  if (!parent || fork?.kind !== "fork") return null;
  return { parent, forkIndex: Number(m[2]), fork, seq };
}

/**
 * Whether the lane at `lanePath` (of a switch or choice) can end at the
 * first step of a block `target` further down the fork's own sequence,
 * skipping what lies between: the lane's last edge goes there. Its default
 * is the fork's merge (the next block), which is always allowed.
 */
export function canSetLaneExit(
  tree: BlockTree,
  lanePath: SeqPath,
  target: string,
): Capability {
  const found = laneParent(tree, lanePath);
  if (!found) return no("scenarios.editor.cannot.notInTree");
  const { parent, forkIndex, fork, seq } = found;
  if (fork.forkKind !== "switch" && fork.forkKind !== "choice") {
    return no("scenarios.editor.cannot.notAFork");
  }
  if (seq.exit.kind !== "fallthrough" && seq.exit.kind !== "link") {
    return no("scenarios.editor.cannot.laneEnds");
  }
  const at = parent.blocks.findIndex((b) => firstNodeOf(b).id === target);
  if (at <= forkIndex) return no("scenarios.editor.cannot.laneTargetNotLater");
  return OK;
}

/**
 * Makes the lane at `lanePath` end at `target` (see {@link canSetLaneExit});
 * the fork's merge puts it back to the default. Only that lane's last edge
 * changes. `def` itself when refused or when the file would not read back
 * with the edge there.
 */
export function setLaneExit(
  def: ScenarioDefinition,
  tree: BlockTree,
  lanePath: SeqPath,
  target: string,
): ScenarioDefinition {
  if (!canSetLaneExit(tree, lanePath, target).ok) return def;
  const t = cloneTree(tree);
  const { fork, seq } = laneParent(t, lanePath)!;
  const edgeId =
    (seq.exit.kind === "fallthrough" || seq.exit.kind === "link"
      ? seq.exit.edgeId
      : null) ?? crypto.randomUUID();
  if (fork.merge?.nodeId === target) {
    seq.exit = { kind: "fallthrough", to: target, edgeId };
  } else {
    seq.exit = { kind: "link", target, edgeId };
  }
  const next = commit(def, t);
  const edge = next.edges.find((e) => e.id === edgeId);
  if (!edge || edge.target !== target) return def;
  return next;
}

/** The ids of the edges a rebuild of `tree` keeps by id (links nothing
 *  structures aside: a rebuild writes them back as they are). */
function structureEdgeIds(tree: BlockTree): Set<string> {
  const ids = new Set<string>();
  for (const req of requiredEdges(tree, () => "")) {
    if (req.preferId !== null) ids.add(req.preferId);
  }
  return ids;
}

/** Whether taking edge `edgeId` out makes another edge of its source run:
 *  the edge is a running lane and a lane the executor skips today (a step's
 *  next edge, a switch / choice's next edge with the same handle) would take
 *  its place. */
function promotesOnRemoval(tree: BlockTree, edgeId: string): boolean {
  for (const seq of allSeqs(tree)) {
    for (const b of seq.blocks) {
      if (b.kind !== "fork") continue;
      const lane = b.lanes.find((l) => l.edgeId === edgeId);
      if (!lane) continue;
      if (!isLive(lane.condition)) return false;
      // TODO(timeout lanes / parallel): a wait's event and timeout lanes
      // and a parallel node's lanes all run; removing one promotes nothing.
      if (
        b.forkKind !== "extra" &&
        b.forkKind !== "switch" &&
        b.forkKind !== "choice"
      ) {
        return false;
      }
      return b.lanes.some(
        (l) =>
          l !== lane &&
          l.condition.kind === "ignored" &&
          (b.forkKind === "extra" || l.handle === lane.handle),
      );
    }
  }
  return false;
}

/** Whether `edit` (applied to a clone of `tree`) drops an edge whose loss
 *  makes an edge that never ran start running: an edit never changes what
 *  runs beyond what it was asked to. `allowed`: the edge whose removal is
 *  the edit's own meaning. */
function revivesDeadEdge(
  tree: BlockTree,
  edit: (t: BlockTree) => void,
  allowed: string | null = null,
): boolean {
  const before = structureEdgeIds(tree);
  const t = cloneTree(tree);
  edit(t);
  const after = structureEdgeIds(t);
  for (const id of before) {
    if (after.has(id) || id === allowed) continue;
    if (promotesOnRemoval(tree, id)) return true;
  }
  return false;
}

/** The loops whose bodies contain the sequence at `path`, innermost last. */
function enclosingLoops(tree: BlockTree, path: SeqPath): LoopBlock[] {
  const loops: LoopBlock[] = [];
  const re = /\/\d+\/body(?=\/|$)/g;
  for (let m = re.exec(path); m; m = re.exec(path)) {
    const loop = loopOfBody(tree, path.slice(0, m.index + m[0].length));
    if (loop) loops.push(loop);
  }
  return loops;
}

/** Whether the last step of `seq` goes back to the header of a loop around
 *  it: its edge is that loop's back edge, and moving it would undo the loop. */
function endsInBackEdge(tree: BlockTree, seq: Seq): boolean {
  const exit = seq.exit;
  if (exit.kind !== "fallthrough") return false;
  return enclosingLoops(tree, seq.path).some(
    (loop) =>
      loop.headerId === exit.to ||
      (!!exit.edgeId && loop.backEdgeIds.includes(exit.edgeId)),
  );
}

/** Which operations apply to `selection`, with the reason when one does
 *  not. Buttons are disabled with the reason as their title. */
export function editCapabilities(
  tree: BlockTree,
  selection: EditSelection,
): EditCapabilities {
  const notHere = no("scenarios.editor.cannot.notForSelection");
  const caps: EditCapabilities = {
    insertStep: notHere,
    insertForkBlock: notHere,
    moveUp: notHere,
    moveDown: notHere,
    removeStep: notHere,
    addLane: notHere,
    removeLane: notHere,
    wrapInLoop: notHere,
    unwrapLoop: notHere,
    setLink: notHere,
    setLaneHandle: notHere,
    setLaneCondition: notHere,
  };
  if (selection.kind === "slot") {
    caps.insertStep = canInsertAt(tree, selection.path, selection.index);
    caps.insertForkBlock = caps.insertStep;
    // A switch / choice as the last block of a bounded loop: its lanes would
    // each go back to the header, and a loop edge leaves a step only.
    if (
      caps.insertForkBlock.ok &&
      breaksLoopBounds(tree, (t) =>
        insertBlockAt(t, seqAt(t, selection.path)!, selection.index, {
          kind: "fork",
          forkKind: "switch",
          node: createDefaultNode(ScenarioNodeType.SWITCH),
          edgeIn: null,
          lanes: [],
          merge: null,
        }),
      )
    ) {
      caps.insertForkBlock = no("scenarios.editor.cannot.breaksLoopBounds");
    }
    return caps;
  }
  const nodeId = selection.nodeId;
  if (nodeId === tree.origin?.id) {
    const startNo = no("scenarios.editor.cannot.startNode");
    caps.removeStep = startNo;
    caps.moveUp = startNo;
    caps.moveDown = startNo;
    caps.setLink = startNo;
    caps.wrapInLoop = startNo;
    caps.unwrapLoop = no("scenarios.editor.cannot.notInLoop");
    caps.addLane = OK;
    if (selection.kind === "lane") {
      const fork = tree.root.blocks[0];
      const laneIndex = selection.laneIndex;
      caps.removeLane =
        fork?.kind === "fork" && fork.node.id === nodeId
          ? fork.lanes.length > 1 && fork.lanes[laneIndex]
            ? revivesDeadEdge(tree, (t) =>
                applyRemoveLane(t, nodeId, laneIndex),
              )
              ? no("scenarios.editor.cannot.revivesDeadEdge")
              : OK
            : no("scenarios.editor.cannot.lastLane")
          : no("scenarios.editor.cannot.notAFork");
      caps.setLaneHandle = no("scenarios.editor.cannot.noCondition");
      caps.setLaneCondition = no("scenarios.editor.cannot.noCondition");
    }
    return caps;
  }
  const found = locate(tree, nodeId);
  if (!found) {
    const none = no("scenarios.editor.cannot.notInTree");
    return Object.fromEntries(
      Object.keys(caps).map((k) => [k, none]),
    ) as unknown as EditCapabilities;
  }
  const { seq, index, block } = found;
  const isLoopHeader = index === 0 && loopOfBody(tree, seq.path) !== null;
  if (block.kind === "fork") {
    caps.removeStep =
      block.lanes.length >= 2
        ? no("scenarios.editor.cannot.forkHasLanes")
        : block.lanes.length === 1 && !isLive(block.lanes[0]!.condition)
          ? // Removing the fork would join its never-taken lane to the chain:
            // steps that never ran would start running.
            no("scenarios.editor.cannot.revivesDeadEdge")
          : isLoopHeader
            ? no("scenarios.editor.cannot.loopHeader")
            : revivesDeadEdge(tree, (t) => applyRemoveStep(t, nodeId))
              ? no("scenarios.editor.cannot.revivesDeadEdge")
              : OK;
    caps.moveUp = no("scenarios.editor.cannot.notAStep");
    caps.moveDown = caps.moveUp;
    caps.setLink = no("scenarios.editor.cannot.forkHasLanes");
    caps.addLane =
      block.forkKind === "parallel"
        ? OK
        : block.forkKind === "switch" || block.forkKind === "choice"
          ? // A new lane needs a handle no lane has yet, or it never runs.
            newLaneHandle(block.node, block.lanes) !== null
            ? OK
            : no("scenarios.editor.cannot.noFreeHandle")
          : no("scenarios.editor.cannot.cannotFork");
  } else {
    caps.removeStep = revivesDeadEdge(tree, (t) => applyRemoveStep(t, nodeId))
      ? no("scenarios.editor.cannot.revivesDeadEdge")
      : breaksLoopBounds(tree, (t) => applyRemoveStep(t, nodeId))
        ? no("scenarios.editor.cannot.breaksLoopBounds")
        : OK;
    const moveCap = (to: number): Capability => {
      const cap = canMove(tree, seq.path, index, to);
      if (!cap.ok) return cap;
      return breaksLoopBounds(tree, (t) =>
        applyMoveStep(t, seq.path, index, to),
      )
        ? no("scenarios.editor.cannot.breaksLoopBounds")
        : cap;
    };
    caps.moveUp = moveCap(index - 1);
    caps.moveDown = moveCap(index + 1);
    caps.setLink = isTerminal(block.node)
      ? no("scenarios.editor.cannot.terminalStep")
      : index !== seq.blocks.length - 1
        ? no("scenarios.editor.cannot.notLastStep")
        : endsInBackEdge(tree, seq)
          ? no("scenarios.editor.cannot.insideLoop")
          : OK;
    const out = connectionRule(block.node.type).out;
    // A switch / choice still a chain: its one edge (if any) runs, so it
    // has a handle it can pick; another lane needs a second one.
    const hasEdge =
      index < seq.blocks.length - 1 ||
      (seq.exit.kind !== "stop" && !!seq.exit.edgeId);
    const handles = pickableHandles(block.node) ?? [];
    caps.addLane =
      out !== "select" || isTerminal(block.node)
        ? no("scenarios.editor.cannot.cannotFork")
        : handles.length > (hasEdge ? 1 : 0)
          ? OK
          : no("scenarios.editor.cannot.noFreeHandle");
  }
  caps.wrapInLoop = canWrapInLoop(tree, seq.path, index, seq.blocks.length - 1);
  caps.unwrapLoop = !repeatingLoopAt(tree, seq.path)
    ? no("scenarios.editor.cannot.notInLoop")
    : revivesDeadEdge(tree, (t) => applyUnwrapLoop(t, nodeId))
      ? no("scenarios.editor.cannot.revivesDeadEdge")
      : OK;
  if (selection.kind === "lane") {
    const lane =
      block.kind === "fork" ? block.lanes[selection.laneIndex] : undefined;
    if (!lane) {
      caps.removeLane = no("scenarios.editor.cannot.notAFork");
      caps.setLaneHandle = caps.removeLane;
      caps.setLaneCondition = caps.removeLane;
    } else {
      const fork = block as ForkBlock;
      const laneIndex = selection.laneIndex;
      // Removing a step's first edge: its next edge runs instead. That is
      // what removing the edge means (the executor takes the first edge to
      // an existing node), so it is allowed, and said.
      const promotes =
        fork.forkKind === "extra" && promotesOnRemoval(tree, lane.edgeId);
      caps.removeLane =
        fork.lanes.length <= 1
          ? no("scenarios.editor.cannot.lastLane")
          : breaksLoopBounds(tree, (t) => applyRemoveLane(t, nodeId, laneIndex))
            ? no("scenarios.editor.cannot.breaksLoopBounds")
            : revivesDeadEdge(
                  tree,
                  (t) => applyRemoveLane(t, nodeId, laneIndex),
                  promotes ? lane.edgeId : null,
                )
              ? no("scenarios.editor.cannot.revivesDeadEdge")
              : promotes
                ? { ok: true, note: "scenarios.editor.note.promotesNextEdge" }
                : OK;
      // A running lane's handle moving away would let the next edge with
      // its old handle (an ignored lane) run.
      const shadows = fork.lanes.some(
        (l) =>
          l !== lane &&
          l.condition.kind === "ignored" &&
          l.handle === lane.handle,
      );
      caps.setLaneHandle =
        fork.forkKind !== "switch" && fork.forkKind !== "choice"
          ? no("scenarios.editor.cannot.noCondition")
          : isLive(lane.condition) && shadows
            ? no("scenarios.editor.cannot.revivesDeadEdge")
            : OK;
      caps.setLaneCondition =
        lane.condition.kind === "case" || lane.condition.kind === "option"
          ? OK
          : no("scenarios.editor.cannot.noCondition");
    }
  }
  return caps;
}
