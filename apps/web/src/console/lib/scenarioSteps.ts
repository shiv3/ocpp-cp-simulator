import type { Edge } from "@xyflow/react";

import type { MessageKey } from "../../i18n";

import {
  type CancelReservationNodeData,
  type CertQuirksNodeData,
  type ConfigSetNodeData,
  type ConnectionTriggerNodeData,
  type ConnectorPlugNodeData,
  type CsmsCallTriggerNodeData,
  type DataTransferNodeData,
  type ChoiceNodeData,
  type DelayNodeData,
  type NotifyNodeData,
  type SetStateNodeData,
  type SwitchNodeData,
  type InboundPolicyNodeData,
  type MeterValueNodeData,
  type NotificationNodeData,
  type CallResponseNodeData,
  type OcppCallNodeData,
  type UseBehaviorNodeData,
  type RemoteStartTriggerNodeData,
  type RemoteStopTriggerNodeData,
  type ReservationTriggerNodeData,
  type ReserveNowNodeData,
  type ResponseOverrideNodeData,
  type ScenarioDefinition,
  type ScenarioNode,
  type ScenarioNodeData,
  ScenarioNodeType,
  type StatusChangeNodeData,
  type StatusNotificationNodeData,
  type StatusTriggerNodeData,
  type TransactionNodeData,
  type UnlockOutcomeNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
// Type-only: stepLayout imports this module's helpers at runtime.
import type { StepLayout, StepLink } from "./stepLayout";

/**
 * Maps a scenario graph (`nodes`/`edges`) to an ordered, list-editable
 * shape when it forms a single linear chain START → step[1] → … →
 * step[n] → (END). Most real scenarios in this repo are linear chains, so a
 * list-based editor can operate on `steps` directly instead of mounting
 * ReactFlow, and hand the result back to `rebuildLinearScenario`. The chain
 * is linear whether or not an END node terminates it — see `endNode` below.
 */
export interface LinearSteps {
  /**
   * false if any node has >1 outgoing edge (branch), a node exists that
   * the START→…→(END) walk never reaches (disconnected middle node), the
   * walk revisits a node (cycle), or there is no START node at all. A
   * missing END node does NOT make a clean chain non-linear (see `endNode`).
   */
  isLinear: boolean;
  /**
   * Ordered walk from START to the last reachable node, excluding the
   * START/END nodes themselves. Includes the terminal real (non-END) node
   * even when the scenario has no END node.
   */
  steps: ScenarioNode[];
  startNode: ScenarioNode | null;
  /**
   * The scenario's END node, or `null` if none exists. `null` can occur
   * even when `isLinear` is `true`: a user can delete
   * the END node and persist the result, and a clean START→…→chain with no
   * END is still considered linear so the list editor can open it —
   * `rebuildLinearScenario` self-heals by creating a new END node on save.
   */
  endNode: ScenarioNode | null;
}

function findNodeByType(
  nodes: readonly ScenarioNode[],
  type: ScenarioNodeType,
): ScenarioNode | null {
  return nodes.find((n) => n.type === type) ?? null;
}

export function deriveLinearSteps(
  def: Pick<ScenarioDefinition, "nodes" | "edges">,
): LinearSteps {
  const startNode = findNodeByType(def.nodes, ScenarioNodeType.START);
  const endNode = findNodeByType(def.nodes, ScenarioNodeType.END);

  if (!startNode) {
    return { isLinear: false, steps: [], startNode: null, endNode };
  }

  const nodesById = new Map(def.nodes.map((n) => [n.id, n]));
  const steps: ScenarioNode[] = [];
  const visited = new Set<string>([startNode.id]);
  let isLinear = true;
  let current: ScenarioNode = startNode;

  while (true) {
    const outgoing = def.edges.filter((e) => e.source === current.id);
    if (outgoing.length > 1) {
      isLinear = false;
      break;
    }
    if (outgoing.length === 0) {
      break;
    }
    const targetId = outgoing[0].target;
    const targetNode = nodesById.get(targetId);
    if (!targetNode || visited.has(targetId)) {
      // Dangling edge target, or a cycle back to an already-visited node.
      isLinear = false;
      break;
    }
    visited.add(targetId);
    if (targetNode.type === ScenarioNodeType.END) {
      current = targetNode;
      break;
    }
    steps.push(targetNode);
    current = targetNode;
  }

  if (isLinear && visited.size !== def.nodes.length) {
    // Some node in the scenario was never reached by the walk — an orphan
    // / disconnected middle node.
    isLinear = false;
  }

  return { isLinear, steps, startNode, endNode };
}

export interface DisplayedSteps {
  /** The node set actually rendered by the run console's timeline, in
   *  display order. */
  steps: ScenarioNode[];
  isLinear: boolean;
}

/**
 * The node set the Scenario Run console's timeline (`RunTimeline`) renders:
 * `deriveLinearSteps`'s ordered walk for linear scenarios, or every
 * non-START/END node in definition order for branching ones (flagged there
 * with an "order approximate" banner). Exported from here — rather than
 * defined separately in `RunTimeline.tsx` and `ScenarioRunPage.tsx` — so the
 * header's "step k/n" count and the timeline's rendered list are always the
 * same set and can't drift: they used to disagree for branching scenarios,
 * where the header called `deriveLinearSteps` directly (a partial walk that
 * stops at the first branch) while the timeline showed the full node list.
 */
export function deriveDisplayedSteps(
  def: Pick<ScenarioDefinition, "nodes" | "edges">,
): DisplayedSteps {
  const linear = deriveLinearSteps(def);
  const steps = linear.isLinear
    ? linear.steps
    : def.nodes.filter(
        (n) =>
          n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
      );
  return { steps, isLinear: linear.isLinear };
}

/**
 * The `sourceHandle` each node's one outgoing edge carries, read from `edges`.
 * A `switch` or `choice` picks its edge by handle (`case-<n>` / `default` /
 * `option-<n>`, schema 1.6), so a rebuild that dropped them would make the
 * node end its branch at run time (#822 review). A switch or choice whose
 * single edge has none gets the first lane it can run: `default` / `option-0`.
 */
function handlesBySource(
  nodes: readonly ScenarioNode[],
  edges: readonly Edge[],
): (sourceId: string) => string | undefined {
  const bySource = new Map<string, string | undefined>();
  const count = new Map<string, number>();
  for (const e of edges) {
    count.set(e.source, (count.get(e.source) ?? 0) + 1);
    bySource.set(e.source, e.sourceHandle ?? undefined);
  }
  const typeById = new Map(nodes.map((n) => [n.id, n.type]));
  return (sourceId) => {
    const kept = count.get(sourceId) === 1 ? bySource.get(sourceId) : undefined;
    if (kept !== undefined) return kept;
    const type = typeById.get(sourceId);
    if (type === ScenarioNodeType.SWITCH) return "default";
    if (type === ScenarioNodeType.CHOICE) return "option-0";
    return undefined;
  };
}

/** The handle of lane `index` leaving a fork node: the one it had, else the
 *  lane's own on a `switch` (`case-<index>` while cases remain, then `default`)
 *  or a `choice` (`option-<index>`). */
function forkHandle(
  fork: ScenarioNode,
  index: number,
  existing: string | undefined,
): string | undefined {
  if (existing !== undefined) return existing;
  if (fork.type === ScenarioNodeType.CHOICE) return `option-${index}`;
  if (fork.type === ScenarioNodeType.SWITCH) {
    const cases = (fork.data as { cases?: unknown[] }).cases;
    const n = Array.isArray(cases) ? cases.length : 0;
    return index < n ? `case-${index}` : "default";
  }
  return undefined;
}

/**
 * Rebuilds a scenario's `nodes`/`edges` from an ordered step list, keeping
 * (or creating, if absent) the START/END nodes, rewriting edges into a
 * single chain start→s1→…→sn→end, and repositioning every node on a
 * vertical grid so the node positions stay sane for the
 * result sanely. Never mutates `def` or any node in `orderedSteps`.
 */
export function rebuildLinearScenario(
  def: ScenarioDefinition,
  orderedSteps: ScenarioNode[],
): ScenarioDefinition {
  const startNode =
    findNodeByType(def.nodes, ScenarioNodeType.START) ??
    createDefaultNode(ScenarioNodeType.START);
  const endNode =
    findNodeByType(def.nodes, ScenarioNodeType.END) ??
    createDefaultNode(ScenarioNodeType.END);

  const positioned = [startNode, ...orderedSteps, endNode].map((n, idx) => ({
    ...n,
    position: { x: 250, y: idx * 120 },
  }));

  const handleOf = handlesBySource(def.nodes, def.edges);
  const edges: Edge[] = [];
  for (let i = 0; i < positioned.length - 1; i++) {
    const sourceHandle = handleOf(positioned[i].id);
    edges.push({
      id: crypto.randomUUID(),
      source: positioned[i].id,
      target: positioned[i + 1].id,
      ...(sourceHandle === undefined ? {} : { sourceHandle }),
    });
  }

  return {
    ...def,
    nodes: positioned,
    edges,
    updatedAt: new Date().toISOString(),
  };
}

export function insertStep(
  def: ScenarioDefinition,
  index: number,
  type: ScenarioNodeType,
): ScenarioDefinition {
  const linear = deriveLinearSteps(def);
  if (!linear.isLinear) return def;
  const steps = linear.steps;
  const clampedIndex = Math.max(0, Math.min(index, steps.length));
  const newNode = createDefaultNode(type);
  const newSteps = [
    ...steps.slice(0, clampedIndex),
    newNode,
    ...steps.slice(clampedIndex),
  ];
  return rebuildLinearScenario(def, newSteps);
}

export function removeStep(
  def: ScenarioDefinition,
  nodeId: string,
): ScenarioDefinition {
  const linear = deriveLinearSteps(def);
  if (!linear.isLinear) return def;
  const steps = linear.steps.filter((n) => n.id !== nodeId);
  return rebuildLinearScenario(def, steps);
}

export function moveStep(
  def: ScenarioDefinition,
  fromIndex: number,
  toIndex: number,
): ScenarioDefinition {
  const linear = deriveLinearSteps(def);
  if (!linear.isLinear) return def;
  const steps = [...linear.steps];
  const [moved] = steps.splice(fromIndex, 1);
  if (moved) {
    steps.splice(toIndex, 0, moved);
  }
  return rebuildLinearScenario(def, steps);
}

/** A lane of a `StepLayout`: the main chain, or a branch by its index. */
export type StepLane = "main" | number;

/** The editable shape behind a supported `StepLayout`: the chain, then the
 *  branches of its one fork (null without a fork), and the loop / join
 *  links. An empty branch is an edge from the fork node straight to END. */
interface LaneShape {
  main: ScenarioNode[];
  branches: ScenarioNode[][] | null;
  /** The `sourceHandle` of each branch's edge from the fork node, in step
   *  with `branches` (undefined: none yet). */
  handles: Array<string | undefined>;
  links: StepLink[];
}

function laneShape(layout: StepLayout): LaneShape {
  return {
    main: [...layout.main],
    branches: layout.fork
      ? layout.fork.branches.map((branch) => [...branch.steps])
      : null,
    handles: layout.fork
      ? layout.fork.branches.map((branch) => branch.handle)
      : [],
    links: layout.links.map((link) => ({ ...link })),
  };
}

const BRANCH_SPACING_X = 280;

/**
 * Rebuilds `nodes`/`edges` from a chain plus at most one fork and its links,
 * the shape `deriveStepLayout` reads back: START → main… → fork node (the
 * last main step, else START) → each branch → END. A lane closed by a link
 * ends there instead of at END; a link always leaves the *last* step of the
 * lane it was on (so inserting or moving steps keeps a loop closing at the
 * end), and one whose source or target is gone is dropped. Lanes are laid
 * out side by side under the fork. Never mutates its inputs.
 */
function rebuildLaneScenario(
  def: ScenarioDefinition,
  shape: LaneShape,
): ScenarioDefinition {
  const startNode =
    findNodeByType(def.nodes, ScenarioNodeType.START) ??
    createDefaultNode(ScenarioNodeType.START);
  const endNode =
    findNodeByType(def.nodes, ScenarioNodeType.END) ??
    createDefaultNode(ScenarioNodeType.END);
  const branches =
    shape.branches && shape.branches.length > 0 ? shape.branches : null;

  const nodes: ScenarioNode[] = [];
  const place = (node: ScenarioNode, x: number, row: number) =>
    nodes.push({ ...node, position: { x, y: row * 120 } });
  place(startNode, 250, 0);
  shape.main.forEach((node, i) => place(node, 250, i + 1));
  let endRow = shape.main.length + 1;
  if (branches) {
    const firstBranchRow = shape.main.length + 1;
    branches.forEach((steps, b) => {
      const x = 250 + (b - (branches.length - 1) / 2) * BRANCH_SPACING_X;
      steps.forEach((node, i) => place(node, x, firstBranchRow + i));
    });
    endRow =
      firstBranchRow + Math.max(...branches.map((steps) => steps.length));
  }
  place(endNode, 250, endRow);

  // Each lane: the node it hangs from, and its steps.
  const forkNode = shape.main[shape.main.length - 1] ?? startNode;
  const lanes: Array<{ from: ScenarioNode; steps: ScenarioNode[] }> = branches
    ? branches.map((steps) => ({ from: forkNode, steps }))
    : [{ from: startNode, steps: shape.main }];
  const laneOf = new Map<string, ScenarioNode[]>();
  for (const lane of lanes) {
    for (const step of lane.steps) laneOf.set(step.id, lane.steps);
  }
  // With a fork, the chain before it cannot close with a link.
  const mainIds = new Set(shape.main.map((n) => n.id));
  const stepIds = new Set(laneOf.keys());
  if (branches) for (const id of mainIds) stepIds.add(id);

  const edges: Edge[] = [];
  const handleOf = handlesBySource(def.nodes, def.edges);
  const link = (
    source: ScenarioNode,
    target: ScenarioNode,
    id?: string,
    handle?: string,
  ) => {
    const sourceHandle = handle ?? handleOf(source.id);
    edges.push({
      id: id ?? crypto.randomUUID(),
      source: source.id,
      target: target.id,
      ...(sourceHandle === undefined ? {} : { sourceHandle }),
    });
  };

  if (branches) {
    const chain = [startNode, ...shape.main];
    for (let i = 0; i < chain.length - 1; i++) link(chain[i], chain[i + 1]);
  }
  const closed = new Set<ScenarioNode[]>();
  const seen = new Set<string>();
  const nodeById = new Map(
    [...shape.main, ...(branches?.flat() ?? [])].map((n) => [n.id, n]),
  );
  for (const l of shape.links) {
    const steps = laneOf.get(l.source);
    if (!steps || steps.length === 0 || !stepIds.has(l.target)) continue;
    const source = steps[steps.length - 1];
    const key = `${source.id}>${l.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    closed.add(steps);
    link(
      source,
      nodeById.get(l.target)!,
      source.id === l.source ? l.id : undefined,
    );
  }
  for (const [laneIndex, lane] of lanes.entries()) {
    const chain = branches
      ? [lane.from, ...lane.steps]
      : [startNode, ...lane.steps];
    // The edge that leaves the fork node carries the lane's handle.
    const handleAt = (i: number): string | undefined =>
      branches && i === 0
        ? forkHandle(lane.from, laneIndex, shape.handles[laneIndex])
        : undefined;
    for (let i = 0; i < chain.length - 1; i++) {
      // Without a fork the chain's edges are this lane's; with one, each
      // branch's edges start at the fork node.
      link(chain[i], chain[i + 1], undefined, handleAt(i));
    }
    if (!closed.has(lane.steps)) {
      link(
        chain[chain.length - 1],
        endNode,
        undefined,
        handleAt(chain.length - 1),
      );
    }
  }

  return { ...def, nodes, edges, updatedAt: new Date().toISOString() };
}

/** Where a step sits in a layout: its lane, its index there, and the lane's
 *  length (for move bounds). Null when the node is not a step of it. */
export function findStepLane(
  layout: StepLayout,
  nodeId: string,
): { lane: StepLane; index: number; length: number } | null {
  const mainIndex = layout.main.findIndex((n) => n.id === nodeId);
  if (mainIndex !== -1) {
    return { lane: "main", index: mainIndex, length: layout.main.length };
  }
  const branches = layout.fork?.branches ?? [];
  for (const [lane, branch] of branches.entries()) {
    const index = branch.steps.findIndex((n) => n.id === nodeId);
    if (index !== -1) return { lane, index, length: branch.steps.length };
  }
  return null;
}

function laneSteps(shape: LaneShape, lane: StepLane): ScenarioNode[] | null {
  if (lane === "main") return shape.main;
  return shape.branches?.[lane] ?? null;
}

/**
 * Inserts a new step of `type` at `index` of one lane of `layout` (the
 * layout of `def`). `index` is clamped to the lane. Inserting at the end of
 * the main chain of a forked scenario makes the new step the fork node. An
 * unsupported layout (or an unknown lane) returns `def` unchanged.
 */
export function insertLaneStep(
  def: ScenarioDefinition,
  layout: StepLayout,
  lane: StepLane,
  index: number,
  type: ScenarioNodeType,
): ScenarioDefinition {
  if (!layout.supported) return def;
  const shape = laneShape(layout);
  const steps = laneSteps(shape, lane);
  if (!steps) return def;
  const clamped = Math.max(0, Math.min(index, steps.length));
  steps.splice(clamped, 0, createDefaultNode(type));
  return rebuildLaneScenario(def, shape);
}

/** Moves a step `delta` places within its own lane (`-1` up, `1` down, more
 *  for a drag); a target past the lane's edge is a no-op — a move never
 *  crosses lanes. */
export function moveLaneStep(
  def: ScenarioDefinition,
  layout: StepLayout,
  nodeId: string,
  delta: number,
): ScenarioDefinition {
  if (!layout.supported) return def;
  const found = findStepLane(layout, nodeId);
  if (!found) return def;
  const target = found.index + delta;
  if (delta === 0 || target < 0 || target >= found.length) return def;
  const shape = laneShape(layout);
  const steps = laneSteps(shape, found.lane)!;
  const [moved] = steps.splice(found.index, 1);
  steps.splice(target, 0, moved);
  return rebuildLaneScenario(def, shape);
}

/**
 * Removes a step from its lane. A branch left empty is dropped, and when a
 * single branch remains it folds into the chain (a one-branch fork is just a
 * chain).
 */
export function removeLaneStep(
  def: ScenarioDefinition,
  layout: StepLayout,
  nodeId: string,
): ScenarioDefinition {
  if (!layout.supported) return def;
  const found = findStepLane(layout, nodeId);
  if (!found) return def;
  const shape = laneShape(layout);
  laneSteps(shape, found.lane)!.splice(found.index, 1);
  if (found.lane !== "main" && shape.branches) {
    if (shape.branches[found.lane].length === 0) {
      shape.branches.splice(found.lane, 1);
      shape.handles.splice(found.lane, 1);
    }
    if (shape.branches.length === 1) {
      shape.main.push(...shape.branches[0]);
      shape.branches = null;
    }
  }
  return rebuildLaneScenario(def, shape);
}

/**
 * Adds a branch holding one Delay step. A forked scenario gets one more lane
 * from its fork node; a chain gets a fork at its last step (START when it has
 * none), whose first branch is the chain's own (empty) continuation to END.
 */
export function addParallelBranch(
  def: ScenarioDefinition,
  layout: StepLayout,
): ScenarioDefinition {
  if (!canAddBranch(layout)) return def;
  const shape = laneShape(layout);
  const delay = createDefaultNode(ScenarioNodeType.DELAY);
  shape.branches = shape.branches
    ? [...shape.branches, [delay]]
    : [[], [delay]];
  shape.handles = shape.branches.map((_, i) => shape.handles[i]);
  return rebuildLaneScenario(def, shape);
}

/** Whether "+ branch" can add a lane: a chain closed by a loop link cannot
 *  fork (the link would then leave the fork node). */
export function canAddBranch(layout: StepLayout): boolean {
  if (!layout.supported) return false;
  if (layout.fork) return true;
  return !layout.links.some((link) =>
    layout.main.some((step) => step.id === link.source),
  );
}

/**
 * Closes the lane `nodeId` ends with a loop to `targetId` (a step of the
 * layout, possibly the step itself), or opens it to END again with `null`.
 * Only the last step of a lane takes a link; anything else returns `def`.
 */
export function setLaneLink(
  def: ScenarioDefinition,
  layout: StepLayout,
  nodeId: string,
  targetId: string | null,
): ScenarioDefinition {
  if (!layout.supported) return def;
  const found = findStepLane(layout, nodeId);
  if (!found || found.index !== found.length - 1) return def;
  const shape = laneShape(layout);
  const steps = laneSteps(shape, found.lane)!;
  const laneIds = new Set(steps.map((n) => n.id));
  shape.links = shape.links.filter((l) => !laneIds.has(l.source));
  if (targetId !== null) {
    const all = [
      ...layout.main,
      ...(layout.fork?.branches.flatMap((b) => b.steps) ?? []),
    ];
    if (!all.some((n) => n.id === targetId)) return def;
    // A chain with a fork cannot close before it.
    if (layout.fork && found.lane === "main") return def;
    shape.links.push({
      id: crypto.randomUUID(),
      source: nodeId,
      target: targetId,
    });
  }
  return rebuildLaneScenario(def, shape);
}

/** The step a lane's loop link returns to (null: the lane runs to END). */
export function laneLinkTarget(
  layout: StepLayout,
  nodeId: string,
): string | null {
  return layout.links.find((l) => l.source === nodeId)?.target ?? null;
}

export function updateStepData(
  def: ScenarioDefinition,
  nodeId: string,
  data: ScenarioNodeData,
): ScenarioDefinition {
  const nodes = def.nodes.map((n) => (n.id === nodeId ? { ...n, data } : n));
  return { ...def, nodes, updatedAt: new Date().toISOString() };
}

/**
 * Default node data per `ScenarioNodeType`, mirroring the palette of
 * the retired ReactFlow editor for every type it offered. RESERVE_NOW / CANCEL_RESERVATION aren't in that palette (its
 * switch falls through to a generic "Unknown" node for them); their
 * defaults here were derived from `ReserveNowNodeData` /
 * `CancelReservationNodeData`'s field shapes instead. RESERVATION_TRIGGER's
 * default matches the `{ label: "Wait for ReserveNow", timeout: 0 }` shape
 * already used by the cert16 reservation templates
 * (packages/core/src/utils/scenarios/cert16-reservation-basic.json).
 */
export function createDefaultNode(type: ScenarioNodeType): ScenarioNode {
  const id = crypto.randomUUID();
  const position = { x: 0, y: 0 };

  switch (type) {
    case ScenarioNodeType.STATUS_CHANGE:
      return {
        id,
        type,
        position,
        data: {
          label: "Status Change",
          status: OCPPStatus.Available,
        } satisfies StatusChangeNodeData,
      };
    case ScenarioNodeType.TRANSACTION:
      return {
        id,
        type,
        position,
        data: {
          label: "Transaction",
          action: "start",
          tagId: "123456",
        } satisfies TransactionNodeData,
      };
    case ScenarioNodeType.METER_VALUE:
      return {
        id,
        type,
        position,
        data: {
          label: "Meter Value",
          value: 10,
          sendMessage: true,
        } satisfies MeterValueNodeData,
      };
    case ScenarioNodeType.DELAY:
      return {
        id,
        type,
        position,
        data: { label: "Delay", delaySeconds: 5 } satisfies DelayNodeData,
      };
    case ScenarioNodeType.NOTIFICATION:
      return {
        id,
        type,
        position,
        data: {
          label: "Notification",
          messageType: "Heartbeat",
          payload: {},
        } satisfies NotificationNodeData,
      };
    case ScenarioNodeType.CONNECTOR_PLUG:
      return {
        id,
        type,
        position,
        data: {
          label: "Connector Plug",
          action: "plugin",
        } satisfies ConnectorPlugNodeData,
      };
    case ScenarioNodeType.REMOTE_START_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for RemoteStart",
          timeout: 0,
        } satisfies RemoteStartTriggerNodeData,
      };
    case ScenarioNodeType.REMOTE_STOP_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for RemoteStop",
          timeout: 0,
        } satisfies RemoteStopTriggerNodeData,
      };
    case ScenarioNodeType.STATUS_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for Status",
          targetStatus: OCPPStatus.Charging,
          timeout: 0,
        } satisfies StatusTriggerNodeData,
      };
    case ScenarioNodeType.RESERVE_NOW:
      return {
        id,
        type,
        position,
        data: {
          label: "Reserve Now",
          expiryMinutes: 30,
          idTag: "123456",
        } satisfies ReserveNowNodeData,
      };
    case ScenarioNodeType.CANCEL_RESERVATION:
      return {
        id,
        type,
        position,
        data: {
          label: "Cancel Reservation",
          reservationId: 1,
        } satisfies CancelReservationNodeData,
      };
    case ScenarioNodeType.RESERVATION_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for ReserveNow",
          timeout: 0,
        } satisfies ReservationTriggerNodeData,
      };
    case ScenarioNodeType.STATUS_NOTIFICATION:
      return {
        id,
        type,
        position,
        data: {
          label: "Status Notification",
          status: OCPPStatus.Faulted,
          errorCode: "InternalError",
        } satisfies StatusNotificationNodeData,
      };
    case ScenarioNodeType.UNLOCK_OUTCOME:
      return {
        id,
        type,
        position,
        data: {
          label: "Unlock Outcome",
          outcome: "Unlocked",
        } satisfies UnlockOutcomeNodeData,
      };
    case ScenarioNodeType.CONFIG_SET:
      return {
        id,
        type,
        position,
        data: {
          label: "ConfigSet",
          key: "MeterValueSampleInterval",
          value: "30",
        } satisfies ConfigSetNodeData,
      };
    case ScenarioNodeType.DATA_TRANSFER:
      return {
        id,
        type,
        position,
        data: {
          label: "DataTransfer",
          vendorId: "com.example",
        } satisfies DataTransferNodeData,
      };
    case ScenarioNodeType.OCPP_CALL:
      return {
        id,
        type,
        position,
        data: {
          label: "OCPP call",
          action: "Heartbeat",
          payload: {},
        } satisfies OcppCallNodeData,
      };
    case ScenarioNodeType.CALL_RESPONSE:
      return {
        id,
        type,
        position,
        data: {
          label: "Call response",
          kind: "result",
          payload: {},
        } satisfies CallResponseNodeData,
      };
    case ScenarioNodeType.USE_BEHAVIOR:
      return {
        id,
        type,
        position,
        data: {
          label: "Use behavior",
          behaviorId: "",
        } satisfies UseBehaviorNodeData,
      };
    case ScenarioNodeType.NOTIFY:
      return {
        id,
        type,
        position,
        data: {
          label: "Notify",
          kind: "firmwareStatus",
          status: "Idle",
        } satisfies NotifyNodeData,
      };
    case ScenarioNodeType.SWITCH:
      return {
        id,
        type,
        position,
        data: {
          label: "Switch",
          value: { $from: "state.mode" },
          cases: ["a", "b"],
        } satisfies SwitchNodeData,
      };
    case ScenarioNodeType.CHOICE:
      return {
        id,
        type,
        position,
        data: { label: "Choice", options: [{}, {}] } satisfies ChoiceNodeData,
      };
    case ScenarioNodeType.SET_STATE:
      return {
        id,
        type,
        position,
        data: {
          label: "Set state",
          key: "mode",
          value: "a",
        } satisfies SetStateNodeData,
      };
    case ScenarioNodeType.CSMS_CALL_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for CSMS Call",
          action: "Reset",
          timeout: 0,
        } satisfies CsmsCallTriggerNodeData,
      };
    case ScenarioNodeType.RESPONSE_OVERRIDE:
      return {
        id,
        type,
        position,
        data: {
          label: "Response Override",
          action: "RemoteStartTransaction",
          status: "Rejected",
        } satisfies ResponseOverrideNodeData,
      };
    case ScenarioNodeType.INBOUND_POLICY:
      return {
        id,
        type,
        position,
        data: {
          label: "Inbound Policy",
          action: "Reset",
          policy: "callerror",
          errorCode: "NotImplemented",
          errorDescription: "",
        } satisfies InboundPolicyNodeData,
      };
    case ScenarioNodeType.CERT_QUIRKS:
      return {
        id,
        type,
        position,
        data: {
          label: "Certificate Quirks",
          mode: "set",
        } satisfies CertQuirksNodeData,
      };
    case ScenarioNodeType.CONNECTION_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for Disconnect",
          event: "disconnected",
          timeout: 0,
        } satisfies ConnectionTriggerNodeData,
      };
    case ScenarioNodeType.START:
      return {
        id,
        type,
        position,
        data: { label: "Start", triggerOn: "connect" },
      };
    case ScenarioNodeType.END:
      return {
        id,
        type,
        position,
        data: { label: "End" },
      };
    default: {
      const exhaustiveCheck: never = type;
      throw new Error(`Unhandled ScenarioNodeType: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * Builds a brand-new scenario with just START→END wired (no steps), a
 * manual trigger, and enabled=true — the starting point for the list-based
 * scenario editor's "new scenario" flow.
 */
export function createEmptyScenario(
  name: string,
  targetType: "chargePoint" | "connector",
  targetId?: number,
): ScenarioDefinition {
  const now = new Date().toISOString();
  const bare: ScenarioDefinition = {
    id: crypto.randomUUID(),
    name,
    targetType,
    ...(targetId !== undefined ? { targetId } : {}),
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
    trigger: { type: "manual" },
    enabled: true,
  };
  return rebuildLinearScenario(bare, []);
}

/**
 * One-line human summary of a step node's configuration, for a list-based
 * editor row. Falls back to the node's label for types without a bespoke
 * summary (and for START/END, which the list editor never renders as a
 * step but which may still flow through this function defensively).
 */
export function stepSummary(node: ScenarioNode): string {
  const label = node.data.label;

  switch (node.type) {
    case ScenarioNodeType.STATUS_CHANGE: {
      const d = node.data as StatusChangeNodeData;
      return `→ ${d.status}`;
    }
    case ScenarioNodeType.STATUS_NOTIFICATION: {
      const d = node.data as StatusNotificationNodeData;
      return `→ ${d.status}${d.errorCode ? ` · ${d.errorCode}` : ""}`;
    }
    case ScenarioNodeType.TRANSACTION: {
      const d = node.data as TransactionNodeData;
      return `${d.action}${d.tagId ? ` · tag ${d.tagId}` : ""}`;
    }
    case ScenarioNodeType.UNLOCK_OUTCOME: {
      const d = node.data as UnlockOutcomeNodeData;
      return d.outcome;
    }
    case ScenarioNodeType.METER_VALUE: {
      const d = node.data as MeterValueNodeData;
      if (d.useCurve) {
        return `curve · ${d.curvePoints?.length ?? 0} pts`;
      }
      return `${d.value} Wh${d.autoIncrement ? " · auto" : ""}`;
    }
    case ScenarioNodeType.CONNECTOR_PLUG: {
      const d = node.data as ConnectorPlugNodeData;
      return d.action;
    }
    case ScenarioNodeType.DELAY: {
      const d = node.data as DelayNodeData;
      return [
        `${d.delaySeconds} s`,
        d.until ? `until ${d.until}` : "",
        d.jitterSeconds ? `jitter ≤ ${d.jitterSeconds} s` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case ScenarioNodeType.REMOTE_START_TRIGGER: {
      const d = node.data as RemoteStartTriggerNodeData;
      return `wait RemoteStart${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.REMOTE_STOP_TRIGGER: {
      const d = node.data as RemoteStopTriggerNodeData;
      return `wait RemoteStop${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.STATUS_TRIGGER: {
      const d = node.data as StatusTriggerNodeData;
      return `wait ${d.targetStatus}${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.CSMS_CALL_TRIGGER: {
      const d = node.data as CsmsCallTriggerNodeData;
      return `wait ${d.action}${d.behavior === "replace" ? " · replace" : ""}${d.payload ? " · payload" : ""}${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.RESERVATION_TRIGGER: {
      const d = node.data as ReservationTriggerNodeData;
      return `wait ReserveNow${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.CONNECTION_TRIGGER: {
      const d = node.data as ConnectionTriggerNodeData;
      return `wait ${d.event}${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.RESERVE_NOW: {
      const d = node.data as ReserveNowNodeData;
      return `${d.idTag} · ${d.expiryMinutes}min`;
    }
    case ScenarioNodeType.CANCEL_RESERVATION: {
      const d = node.data as CancelReservationNodeData;
      return `#${d.reservationId}`;
    }
    case ScenarioNodeType.RESPONSE_OVERRIDE: {
      const d = node.data as ResponseOverrideNodeData;
      return `${d.action} → ${d.status}`;
    }
    case ScenarioNodeType.INBOUND_POLICY: {
      const d = node.data as InboundPolicyNodeData;
      if (d.policy === "answer") {
        return `${d.action} → normal`;
      } else if (d.policy === "callerror") {
        return `${d.action} → error(${d.errorCode ?? "NotImplemented"})`;
      } else {
        return `${d.action} → ignore`;
      }
    }
    case ScenarioNodeType.CERT_QUIRKS: {
      const d = node.data as CertQuirksNodeData;
      if (d.mode === "clear") {
        return "clear all quirks";
      } else {
        const parts: string[] = [];
        if (d.preset) parts.push(`preset: ${d.preset}`);
        if (d.csrKeyAlgorithm) parts.push(`CSR: ${d.csrKeyAlgorithm}`);
        if (d.csrPemLineEndings)
          parts.push(`PEM: ${d.csrPemLineEndings.toUpperCase()}`);
        return parts.length > 0 ? parts.join(" · ") : "set quirks";
      }
    }
    case ScenarioNodeType.CONFIG_SET: {
      const d = node.data as ConfigSetNodeData;
      return `${d.key} = ${d.value}`;
    }
    case ScenarioNodeType.DATA_TRANSFER: {
      const d = node.data as DataTransferNodeData;
      return d.vendorId;
    }
    case ScenarioNodeType.NOTIFICATION: {
      const d = node.data as NotificationNodeData;
      return d.messageType;
    }
    case ScenarioNodeType.OCPP_CALL: {
      const d = node.data as OcppCallNodeData;
      return d.skipValidation ? `${d.action} (unvalidated)` : d.action;
    }
    case ScenarioNodeType.CALL_RESPONSE: {
      const d = node.data as CallResponseNodeData;
      const what =
        d.kind === "error"
          ? `CALLERROR ${d.errorCode ?? "GenericError"}`
          : d.kind === "none"
            ? "no answer"
            : d.kind === "accepted" || d.kind === "rejected"
              ? d.kind
              : "CALLRESULT";
      return d.skipValidation ? `${what} (unvalidated)` : what;
    }
    case ScenarioNodeType.USE_BEHAVIOR: {
      const d = node.data as UseBehaviorNodeData;
      return d.behaviorId;
    }
    case ScenarioNodeType.NOTIFY: {
      const d = node.data as NotifyNodeData;
      return `${d.kind} ${d.status}`;
    }
    case ScenarioNodeType.SWITCH: {
      const d = node.data as SwitchNodeData;
      return `${JSON.stringify(d.value)} · ${d.cases?.length ?? 0} cases`;
    }
    case ScenarioNodeType.CHOICE: {
      const d = node.data as ChoiceNodeData;
      return `${d.options?.length ?? 0} options`;
    }
    case ScenarioNodeType.SET_STATE: {
      const d = node.data as SetStateNodeData;
      return `${d.key} = ${JSON.stringify(d.value)}`;
    }
    default:
      return label;
  }
}

/**
 * Palette groupings for the list-based step editor's "add step" picker.
 * Every `ScenarioNodeType` except START/END (which are implicit chain
 * endpoints, not user-insertable steps) appears in exactly one bucket.
 */
export const STEP_CATEGORIES: ReadonlyArray<{
  /** Stable English id (also keys the tile styles); show `labelKey`. */
  label: string;
  labelKey: MessageKey;
  types: ScenarioNodeType[];
}> = [
  {
    label: "Status",
    labelKey: "scenarios.category.status",
    types: [
      ScenarioNodeType.STATUS_CHANGE,
      ScenarioNodeType.STATUS_NOTIFICATION,
    ],
  },
  {
    label: "Transaction",
    labelKey: "scenarios.category.transaction",
    types: [ScenarioNodeType.TRANSACTION, ScenarioNodeType.UNLOCK_OUTCOME],
  },
  {
    label: "Meter & EV",
    labelKey: "scenarios.category.meterEv",
    types: [ScenarioNodeType.METER_VALUE, ScenarioNodeType.CONNECTOR_PLUG],
  },
  {
    label: "Wait & Trigger",
    labelKey: "scenarios.category.waitTrigger",
    types: [
      ScenarioNodeType.DELAY,
      ScenarioNodeType.REMOTE_START_TRIGGER,
      ScenarioNodeType.REMOTE_STOP_TRIGGER,
      ScenarioNodeType.STATUS_TRIGGER,
      ScenarioNodeType.CSMS_CALL_TRIGGER,
      ScenarioNodeType.RESERVATION_TRIGGER,
      ScenarioNodeType.CONNECTION_TRIGGER,
    ],
  },
  {
    label: "Advanced",
    labelKey: "scenarios.category.advanced",
    types: [
      ScenarioNodeType.RESPONSE_OVERRIDE,
      ScenarioNodeType.INBOUND_POLICY,
      ScenarioNodeType.CERT_QUIRKS,
      ScenarioNodeType.CONFIG_SET,
      ScenarioNodeType.DATA_TRANSFER,
      ScenarioNodeType.NOTIFICATION,
      ScenarioNodeType.OCPP_CALL,
      ScenarioNodeType.CALL_RESPONSE,
      ScenarioNodeType.USE_BEHAVIOR,
      ScenarioNodeType.NOTIFY,
      ScenarioNodeType.SWITCH,
      ScenarioNodeType.CHOICE,
      ScenarioNodeType.SET_STATE,
      ScenarioNodeType.RESERVE_NOW,
      ScenarioNodeType.CANCEL_RESERVATION,
    ],
  },
];
