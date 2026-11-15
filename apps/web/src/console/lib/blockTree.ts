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
import {
  isTerminal,
  pickableHandles,
} from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

import type { MessageKey } from "../../i18n";
import { createDefaultNode, updateStepData } from "./scenarioSteps";
import { conditionOf } from "./blockTree/structural";
import {
  hasBounds,
  type BlockTree,
  type ForkBlock,
  type ForkKind,
  type Lane,
  type LaneCondition,
  type Seq,
  type SeqExit,
  type SeqPath,
  type StepBlock,
} from "./blockTree/types";

import {
  canInsertAt,
  canMove,
  canWrapInLoop,
  editCapabilities,
  canSetLaneExit,
  canSetLoopBounds,
  laneParent,
  no,
  OK,
  type Capability,
} from "./blockTree/capabilities";
import {
  applyMoveStep,
  applyRemoveLane,
  applyRemoveStep,
  applyUnwrapLoop,
  applyWrapInLoop,
  boundPlainLoop,
  locateLoop,
  newLaneHandle,
  removeStepBlockAt,
  repath,
  type LoopBoundsInput,
} from "./blockTree/edit/applies";
import { recognizeBlockTree } from "./blockTree/recognize";
import { boundedLoopProblem, commit } from "./blockTree/rebuild";
import {
  cloneTree,
  insertBlockAt,
  loopOfBody,
  locate,
  seqAt,
} from "./blockTree/edit/primitives";
import { firstNodeOf, nodeAtSlot } from "./blockTree/treeHelpers";

export { recognizeBlockTree } from "./blockTree/recognize";
export {
  canMoveStep,
  canSetLaneExit,
  canSetLoopBounds,
  canWrapInLoop,
  editCapabilities,
} from "./blockTree/capabilities";
export type {
  Capability,
  EditCapabilities,
  EditSelection,
} from "./blockTree/capabilities";
export type { LoopBoundsInput } from "./blockTree/edit/applies";
export { DEFAULT_LOOP_BOUNDS } from "./blockTree/edit/applies";
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
