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

// Operations (design §4)
export {
  canMoveStepTo,
  insertStep,
  moveStep,
  moveStepTo,
  removeStep,
} from "./blockTree/edit/steps";
export {
  addLane,
  insertForkBlock,
  removeLane,
  setLaneCondition,
  setLaneExit,
  setLaneHandle,
} from "./blockTree/edit/lanes";
export {
  canInsertLoopAt,
  insertStepIntoNewLoop,
  newLoopIsBounded,
  setLoopBounds,
  unwrapLoop,
  wrapInLoop,
} from "./blockTree/edit/loops";
export { setLink } from "./blockTree/edit/links";
