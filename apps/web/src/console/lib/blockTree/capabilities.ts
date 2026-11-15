/**
 * Capabilities (design §4): which edit operations apply to a selection, with
 * the reason when one does not. Depends on `edit/applies.ts` (the edits it
 * simulates), never on the operations in `../blockTree.ts` (#570).
 */
import { connectionRule } from "@ocpp-cp-simulator/core/scenario/scenarioConnectionRules";
import {
  isTerminal,
  pickableHandles,
} from "@ocpp-cp-simulator/core/scenario/scenarioGraph";
import { ScenarioNodeType } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

import type { MessageKey } from "../../../i18n";
import { createDefaultNode } from "../scenarioSteps";
import { isLive } from "./structural";
import { allSeqs, firstNodeOf } from "./treeHelpers";
import { boundedLoopProblem, requiredEdges } from "./rebuild";
import {
  cloneTree,
  insertBlockAt,
  loopOfBody,
  locate,
  repeatingLoopAt,
  seqAt,
  slotReachable,
} from "./edit/primitives";
import {
  applyMoveStep,
  applyRemoveLane,
  applyRemoveStep,
  applyUnwrapLoop,
  applyWrapInLoop,
  boundPlainLoop,
  locateLoop,
  loopNeedsBounds,
  newLaneHandle,
  type LoopBoundsInput,
} from "./edit/applies";
import {
  hasBounds,
  type BlockTree,
  type ForkBlock,
  type LoopBlock,
  type Seq,
  type SeqPath,
} from "./types";

/** `note`: the operation applies, and does something the user should be
 *  told about (shown with the button). */
export type Capability =
  { ok: true; note?: MessageKey } | { ok: false; reason: MessageKey };

export const OK: Capability = { ok: true };
export const no = (reason: MessageKey): Capability => ({ ok: false, reason });

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

export function canInsertAt(
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

export function canMove(
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
export function breaksLoopBounds(
  tree: BlockTree,
  edit: (t: BlockTree) => void,
): boolean {
  const t = cloneTree(tree);
  edit(t);
  return boundedLoopProblem(t) !== null;
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

/** Where lane `lanePath` is: its fork (a switch or choice) and the parent
 *  sequence the fork stands in. */
export function laneParent(
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
