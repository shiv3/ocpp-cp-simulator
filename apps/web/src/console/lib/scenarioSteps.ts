import type { Edge } from "@xyflow/react";

import {
  type AnyScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNode,
  type ScenarioNodeData,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { pickableHandles } from "@ocpp-cp-simulator/core/scenario/scenarioGraph";
// Type-only: stepLayout imports this module's helpers at runtime.
import type { StepLayout, StepLink } from "./stepLayout";
import { createDefaultNode } from "./scenarioSteps/defaults";

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

/** An edge's `sourceHandle`, `null` when it has none. */
const handleOf = (edge: Edge): string | null =>
  typeof edge.sourceHandle === "string" ? edge.sourceHandle : null;

/**
 * The `sourceHandle` (`null`: none) for a chain edge the input did not have
 * out of a node, read from `edges`. A `switch` or `choice` picks its edge by
 * handle (`case-<n>` / `default` / `option-<n>`, schema 1.6), so a rebuild
 * that dropped them would make the node end its branch at run time (#822
 * review). A node with exactly one edge in the input hands its handle, or
 * the lack of one, to the edge that replaces it: the file's meaning is kept,
 * a dead edge stays dead. Only a node with no single edge to inherit from (a
 * step just placed) gets one: `default` on a switch, `option-0` on a choice.
 */
function chainHandles(
  /** The rebuild's nodes: a step just placed is among them. */
  nodes: readonly ScenarioNode[],
  edges: readonly Edge[],
): (sourceId: string) => string | null {
  const bySource = new Map<string, string | null>();
  const count = new Map<string, number>();
  for (const e of edges) {
    count.set(e.source, (count.get(e.source) ?? 0) + 1);
    bySource.set(e.source, handleOf(e));
  }
  const typeById = new Map(nodes.map((n) => [n.id, n.type]));
  return (sourceId) => {
    if (count.get(sourceId) === 1) return bySource.get(sourceId)!;
    const type = typeById.get(sourceId);
    if (type === ScenarioNodeType.SWITCH) return "default";
    if (type === ScenarioNodeType.CHOICE) return "option-0";
    return null;
  };
}

/**
 * The handle of every lane leaving `fork`, in lane order. A lane that
 * existed keeps the handle its edge had, or none (`null`), whatever its
 * index: the editor never changes what a file says. Only a new lane
 * (`undefined`) gets one: the first handle the node can pick
 * (`pickableHandles`: `case-<i>` then `default` on a switch, `option-<i>` on
 * a choice) that no other lane uses, else none, never a duplicate (the
 * validator then reports `unpickableHandle`).
 */
function forkHandles(
  fork: ScenarioNode,
  handles: ReadonlyArray<string | null | undefined>,
): Array<string | null> {
  const pickable = pickableHandles(fork) ?? [];
  const used = new Set(
    handles.filter((h): h is string => typeof h === "string"),
  );
  return handles.map((handle) => {
    if (handle !== undefined) return handle;
    const free = pickable.find((h) => !used.has(h));
    if (free === undefined) return null;
    used.add(free);
    return free;
  });
}

/**
 * Hands back the input's edges for the pairs a rebuild draws again, so an
 * edge keeps its id and every field the editor does not understand (`type`,
 * `sourceHandle`, future fields). Several edges between one pair are handed
 * out in file order, the one already carrying the requested handle first.
 * `take`'s `sourceHandle`: a string or `null` (none) is what the edge must
 * carry; `undefined` keeps a reused edge's own and gives a new one none. A
 * pair the input did not have gets a new edge; `id` is kept when still free,
 * otherwise a fresh one is made.
 */
function edgeReuser(edges: readonly Edge[]) {
  const pool = new Map<string, Edge[]>();
  const keyOf = (source: string, target: string) => `${source}\u0000${target}`;
  for (const e of edges) {
    const key = keyOf(e.source, e.target);
    const list = pool.get(key);
    if (list) list.push(e);
    else pool.set(key, [e]);
  }
  const usedIds = new Set<string>();
  const has = (source: string, target: string): boolean =>
    (pool.get(keyOf(source, target))?.length ?? 0) > 0;
  const take = (
    source: string,
    target: string,
    sourceHandle: string | null | undefined,
    id?: string,
  ): Edge => {
    const list = pool.get(keyOf(source, target));
    if (list && list.length > 0) {
      const match =
        sourceHandle === undefined
          ? 0
          : list.findIndex((e) => handleOf(e) === sourceHandle);
      const [taken] = list.splice(Math.max(match, 0), 1);
      // Two edges of different pairs may share an id: keep the later one's
      // content (unknown fields included) and give it a fresh id.
      const existing = usedIds.has(taken.id)
        ? { ...taken, id: crypto.randomUUID() }
        : taken;
      usedIds.add(existing.id);
      // A lane asks for the handle its own edge had, and the pair's edge
      // with that handle is taken first (two empty lanes both run to END),
      // so this is a guard: the lane's handle wins.
      if (sourceHandle === undefined || handleOf(existing) === sourceHandle) {
        return existing;
      }
      if (sourceHandle === null) {
        const { sourceHandle: _dropped, ...rest } = existing;
        return rest;
      }
      return { ...existing, sourceHandle };
    }
    const fresh =
      id !== undefined && !usedIds.has(id) ? id : crypto.randomUUID();
    usedIds.add(fresh);
    return {
      id: fresh,
      source,
      target,
      ...(typeof sourceHandle === "string" ? { sourceHandle } : {}),
    };
  };
  return { has, take };
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

  const chainHandle = chainHandles(positioned, def.edges);
  const edgeFor = edgeReuser(def.edges);
  const edges: Edge[] = [];
  for (let i = 0; i < positioned.length - 1; i++) {
    const source = positioned[i].id;
    const target = positioned[i + 1].id;
    // An edge drawn again keeps its own handle (or none).
    const handle = edgeFor.has(source, target)
      ? undefined
      : chainHandle(source);
    edges.push(edgeFor.take(source, target, handle));
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
  type: AnyScenarioNodeType,
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
   *  with `branches`: a string, `null` for an edge that has none (kept so),
   *  `undefined` for a lane the user just added (`forkHandles` picks one). */
  handles: Array<string | null | undefined>;
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
  const chainHandle = chainHandles(nodes, def.edges);
  const edgeFor = edgeReuser(def.edges);
  const laneHandles = branches ? forkHandles(forkNode, shape.handles) : [];
  /** `handle`: a fork edge's lane handle. Any other edge drawn again keeps
   *  its own; a new one inherits per `chainHandles`. */
  const link = (
    source: ScenarioNode,
    target: ScenarioNode,
    id?: string,
    handle?: string | null,
  ) => {
    const sourceHandle =
      handle !== undefined || edgeFor.has(source.id, target.id)
        ? handle
        : chainHandle(source.id);
    edges.push(edgeFor.take(source.id, target.id, sourceHandle, id));
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
    const handleAt = (i: number): string | null | undefined =>
      branches && i === 0 ? laneHandles[laneIndex] : undefined;
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
  if (shape.branches) {
    shape.branches = [...shape.branches, [delay]];
    shape.handles = [...shape.handles, undefined];
  } else {
    // The chain's own continuation becomes the first lane: it keeps the
    // handle (or none) of the edge it already had; only the new lane gets one.
    const forkId =
      shape.main[shape.main.length - 1]?.id ??
      findNodeByType(def.nodes, ScenarioNodeType.START)?.id;
    const out = def.edges.filter((e) => e.source === forkId);
    shape.branches = [[], [delay]];
    shape.handles = [
      out.length === 1 ? handleOf(out[0]) : undefined,
      undefined,
    ];
  }
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

export { createDefaultNode };
export { stepSummary, summarizeValue } from "./scenarioSteps/summary";
export {
  STEP_CATEGORIES,
  STEP_HELP,
  STRUCTURE_TYPE,
  WAIT_STEP_TYPES,
} from "./scenarioSteps/catalog";
