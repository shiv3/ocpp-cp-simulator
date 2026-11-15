import {
  type ChoiceNodeData,
  type ScenarioDefinition,
  type ScenarioNode,
  ScenarioNodeType,
  type SwitchNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { pickableHandles } from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

import { createDefaultNode, updateStepData } from "../../scenarioSteps";
import {
  canInsertAt,
  canSetLaneExit,
  editCapabilities,
  laneParent,
} from "../capabilities";
import { firstNodeOf, nodeAtSlot } from "../treeHelpers";
import { commit } from "../rebuild";
import { conditionOf } from "../structural";
import type {
  BlockTree,
  ForkBlock,
  ForkKind,
  Lane,
  LaneCondition,
  Seq,
  SeqExit,
  SeqPath,
  StepBlock,
} from "../types";
import { applyRemoveLane, newLaneHandle } from "./applies";
import { cloneTree, insertBlockAt, locate, seqAt } from "./primitives";

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
