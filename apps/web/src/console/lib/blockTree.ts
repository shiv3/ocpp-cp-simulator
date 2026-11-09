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
 */
import type { Edge } from "@xyflow/react";

import {
  type ChoiceNodeData,
  type ScenarioDefinition,
  type ScenarioNode,
  ScenarioNodeType,
  type SwitchNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { connectionRule } from "@ocpp-cp-simulator/core/scenario/scenarioConnectionRules";
import {
  isTerminal,
  lowerScenario,
  nextStep,
  pickableHandles,
  type ScenarioProgram,
} from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

import type { MessageKey } from "../../i18n";
import { createDefaultNode, updateStepData } from "./scenarioSteps";

// ---------------------------------------------------------------------------
// Types (design §1)

/** A stable key of a sequence: `root`, `detached/<k>`, then per level
 *  `/<block index>/lanes/<lane index>` or `/<block index>/body`. */
export type SeqPath = string;

export interface Seq {
  path: SeqPath;
  blocks: Block[];
  exit: SeqExit;
}

export type SeqExit =
  /** To END (`edgeId` null: a new edge to END is made). */
  | { kind: "end"; edgeId: string | null }
  /** The branch ends: no edge, only edges to missing nodes, a step that
   *  ends its branch, or a last block that ends every path itself. */
  | {
      kind: "stop";
      reason: "noEdge" | "dangling" | "terminalStep" | "blockEnds";
      edgeId?: string;
    }
  /** On to the parent's merge, a loop's header or a loop's continuation
   *  (the parent draws that node). */
  | { kind: "fallthrough"; to: string; edgeId?: string | null }
  /** A goto: a join into a step placed elsewhere, a loop back edge that is
   *  not structured, an edge into START. */
  | { kind: "link"; edgeId: string; target: string };

export type Block = StepBlock | ForkBlock | LoopBlock;

export interface StepBlock {
  kind: "step";
  node: ScenarioNode;
  /** The edge from the previous step (or the lane / START) into it; null
   *  when several edges join here (a merge) or it starts a detached island. */
  edgeIn: string | null;
}

/** `timeout` (a wait's event / timeout lanes, schema 1.7) and `parallel`
 *  (a parallel node with a join) are extension points: nothing recognizes
 *  them until the core has them. */
export type ForkKind =
  "start" | "parallel" | "switch" | "choice" | "timeout" | "extra";

export type LaneCondition =
  | { kind: "case"; index: number; value: unknown }
  | { kind: "default" }
  | { kind: "option"; index: number; weight: number; label?: string }
  | { kind: "all" }
  | { kind: "first" }
  | { kind: "event" }
  | { kind: "timeout"; seconds: number }
  | { kind: "ignored" }
  | { kind: "unpickable"; handle: string | null };

export interface Lane {
  edgeId: string;
  handle: string | null;
  condition: LaneCondition;
  body: Seq;
}

export interface ForkBlock {
  kind: "fork";
  forkKind: ForkKind;
  node: ScenarioNode;
  edgeIn: string | null;
  lanes: Lane[];
  /** Where the lanes meet again (the next block of the parent sequence, or
   *  the node the parent falls through to); null when they never do.
   *  `join` is the parallel extension point. */
  merge:
    | { kind: "node"; nodeId: string }
    | { kind: "join"; nodeId: string; mode: "all" | "any" }
    | null;
}

export interface LoopBlock {
  kind: "loop";
  /** The loop's first node: `body.blocks[0]`'s node. */
  headerId: string;
  body: Seq;
  backEdgeIds: string[];
}

export interface LinkEdge {
  edge: Edge;
  role:
    | "back"
    | "join"
    | "dead"
    | "dangling"
    | "intoStart"
    | "outOfEnd"
    | "timeoutDead";
}

export interface BlockTree {
  root: Seq;
  detached: Seq[];
  links: LinkEdge[];
  /** Every edge the tree draws structurally, by id. */
  drawnEdges: ReadonlyMap<string, { source: string; target: string }>;
  /** Where each placed node is: its sequence and block index. A loop
   *  header is at index 0 of its loop's body. */
  nodePath: ReadonlyMap<string, { path: SeqPath; index: number }>;
  /** The node a run starts from; null without one. */
  origin: ScenarioNode | null;
}

type Def = Pick<ScenarioDefinition, "nodes" | "edges">;
type Program = ScenarioProgram<ScenarioNode, Edge>;

const handleOf = (edge: Edge): string | null =>
  typeof edge.sourceHandle === "string" ? edge.sourceHandle : null;

/** A node of type END that is not the origin: never placed, an exit. */
function isEndSink(node: ScenarioNode, origin: ScenarioNode | undefined) {
  return node !== origin && node.type === ScenarioNodeType.END;
}

// ---------------------------------------------------------------------------
// Structural successors (design §2)

interface LaneEdge {
  edge: Edge;
  condition: LaneCondition;
}

interface NodeOut {
  /** The edges the tree structures out of the node, in lane order. One
   *  edge: a chain; two or more: a fork of `forkKind`. */
  lanes: LaneEdge[];
  forkKind: ForkKind;
}

function conditionOf(node: ScenarioNode, handle: string): LaneCondition {
  const data = node.data as Partial<SwitchNodeData & ChoiceNodeData>;
  if (handle === "default") return { kind: "default" };
  const caseMatch = /^case-(\d+)$/.exec(handle);
  if (caseMatch) {
    const index = Number(caseMatch[1]);
    return {
      kind: "case",
      index,
      value: Array.isArray(data.cases) ? data.cases[index] : undefined,
    };
  }
  const index = Number(/^option-(\d+)$/.exec(handle)?.[1] ?? 0);
  const option = Array.isArray(data.options) ? data.options[index] : undefined;
  return {
    kind: "option",
    index,
    weight: typeof option?.weight === "number" ? option.weight : 1,
    ...(typeof option?.label === "string" ? { label: option.label } : {}),
  };
}

/**
 * Extension point (schema 1.7, feat/scenario-timeout-edges): a wait's
 * `[event, timeout]` lanes. Nothing has timeout edges yet, so `null`; once
 * the core marks them, return the event edge and the timeout edge here and
 * the node becomes a "timeout" fork.
 */
function timeoutLanes(_program: Program, _node: ScenarioNode): null {
  return null;
}

function structuralOut(program: Program, node: ScenarioNode): NodeOut {
  const existing = program.outgoing.get(node.id) ?? [];
  if (node === program.origin) {
    return {
      lanes: existing.map((edge) => ({ edge, condition: { kind: "all" } })),
      forkKind: "start",
    };
  }
  if (isTerminal(node)) return { lanes: [], forkKind: "extra" };
  const timeout = timeoutLanes(program, node);
  if (timeout) return timeout;
  const out = connectionRule(node.type).out;
  if (out === "select") {
    const handles = pickableHandles(node) ?? [];
    const lanes: LaneEdge[] = [];
    const taken = new Set<Edge>();
    for (const handle of handles) {
      const first = existing.find((e) => handleOf(e) === handle);
      if (!first) continue;
      taken.add(first);
      lanes.push({ edge: first, condition: conditionOf(node, handle) });
    }
    for (const edge of existing) {
      if (taken.has(edge)) continue;
      const handle = handleOf(edge);
      lanes.push({
        edge,
        condition:
          handle !== null && handles.includes(handle)
            ? { kind: "ignored" }
            : { kind: "unpickable", handle },
      });
    }
    return {
      lanes,
      forkKind: node.type === ScenarioNodeType.CHOICE ? "choice" : "switch",
    };
  }
  // Extension point: a parallel node other than START (feat/scenario-
  // parallel-join) runs every edge. A START that is not the origin runs as a
  // step, so today this never matches.
  if (out === "parallel" && node.type !== ScenarioNodeType.START) {
    return {
      lanes: existing.map((edge) => ({ edge, condition: { kind: "all" } })),
      forkKind: "parallel",
    };
  }
  // `next` (and unknown types): the first edge to an existing node runs; the
  // others never do but stay lanes so no edge disappears.
  // TODO(timeout lanes, schema 1.7): leave a wait's `kind: "timeout"` edges
  // out of this chain (and out of `nextStep` here): they are the timeout
  // fork's own lanes (`timeoutLanes` above), never an "extra" fork's.
  // TODO(parallel): a parallel node's lanes are matched above; none of its
  // edges may reach this branch.
  // TODO(bounded loops, schema 1.7): on a latch with a `kind: "loop"` edge
  // and an ordinary exit edge, the loop edge is the back-edge lane and the
  // exit the step's chain edge (first-edge-wins among non-loop, non-timeout
  // edges), not an "extra" fork of two lanes.
  const step = nextStep(program, node, null);
  if (step.kind !== "edge") return { lanes: [], forkKind: "extra" };
  return {
    lanes: [
      { edge: step.edge, condition: { kind: "first" } },
      ...existing
        .filter((e) => e !== step.edge)
        .map((edge) => ({ edge, condition: { kind: "ignored" } as const })),
    ],
    forkKind: "extra",
  };
}

const isLive = (condition: LaneCondition): boolean =>
  condition.kind !== "ignored" && condition.kind !== "unpickable";

// ---------------------------------------------------------------------------
// Dominators and post-dominators (Cooper, Harvey, Kennedy)

/** Immediate dominators over `succ` from a virtual root `entry`. Every
 *  vertex must be reachable from `entry`. */
function immediateDominators(
  entry: string,
  succ: (v: string) => readonly string[],
): Map<string, string> {
  const order: string[] = [];
  const seen = new Set<string>([entry]);
  // Iterative DFS post-order.
  const stack: Array<{ v: string; i: number }> = [{ v: entry, i: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const next = succ(top.v);
    if (top.i < next.length) {
      const w = next[top.i++];
      if (!seen.has(w)) {
        seen.add(w);
        stack.push({ v: w, i: 0 });
      }
    } else {
      order.push(top.v);
      stack.pop();
    }
  }
  const rpo = order.reverse();
  const index = new Map(rpo.map((v, i) => [v, i]));
  const preds = new Map<string, string[]>();
  for (const v of rpo) {
    for (const w of succ(v)) {
      const list = preds.get(w);
      if (list) list.push(v);
      else preds.set(w, [v]);
    }
  }
  const idom = new Map<string, string>([[entry, entry]]);
  const intersect = (a: string, b: string): string => {
    while (a !== b) {
      while (index.get(a)! > index.get(b)!) a = idom.get(a)!;
      while (index.get(b)! > index.get(a)!) b = idom.get(b)!;
    }
    return a;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const v of rpo) {
      if (v === entry) continue;
      let candidate: string | undefined;
      for (const p of preds.get(v) ?? []) {
        if (!idom.has(p)) continue;
        candidate = candidate === undefined ? p : intersect(p, candidate);
      }
      if (candidate !== undefined && idom.get(v) !== candidate) {
        idom.set(v, candidate);
        changed = true;
      }
    }
  }
  return idom;
}

const ENTRY = "\u0000entry";
/** A lane body's exit until its (deferred) walk replaces the body. */
const PENDING: SeqExit = { kind: "stop", reason: "noEdge" };
const EXIT = "\u0000exit";
const LATCH = "\u0000latch:";

// ---------------------------------------------------------------------------
// Recognition (design §2)

/** Reads `def` into a {@link BlockTree}. Never throws. */
export function recognizeBlockTree(def: Def): BlockTree {
  const program: Program = lowerScenario<ScenarioNode, Edge>(def);
  const { nodesById } = program;
  const origin = program.origin;
  const firstNodes = [...nodesById.values()];

  const outs = new Map<string, NodeOut>();
  for (const node of firstNodes)
    outs.set(node.id, structuralOut(program, node));
  /** A lane edge whose target the walk may place (not END, not the origin). */
  const walkable = (edge: Edge): boolean => {
    const target = nodesById.get(edge.target);
    return !!target && target !== origin && !isEndSink(target, origin);
  };
  /** The lanes that run. Structure (back edges, loops, merges, loop exits)
   *  is computed on these only: an edge that never runs must not make a
   *  loop that never loops or take a fork's merge away. Dead lanes are
   *  walked after every live one and drawn wherever they lead. */
  const liveLanes = (id: string): LaneEdge[] =>
    (outs.get(id)?.lanes ?? []).filter((l) => isLive(l.condition));
  const laneTargets = (id: string): string[] =>
    liveLanes(id)
      .filter((l) => walkable(l.edge))
      .map((l) => l.edge.target);

  // --- DFS forest: back edges ---------------------------------------------
  const roots: string[] = [];
  if (origin) roots.push(origin.id);
  for (const node of firstNodes) {
    if (node !== origin && !isEndSink(node, origin)) roots.push(node.id);
  }
  const backEdges = new Set<Edge>();
  /** The nodes a DFS tree starts at: the origin, then each node no earlier
   *  tree reaches (file order). */
  const treeRoots: string[] = [];
  {
    const state = new Map<string, 1 | 2>(); // 1: on stack, 2: done
    for (const root of roots) {
      if (state.has(root)) continue;
      treeRoots.push(root);
      state.set(root, 1);
      const stack: Array<{ v: string; lanes: LaneEdge[]; i: number }> = [
        { v: root, lanes: liveLanes(root), i: 0 },
      ];
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.i < top.lanes.length) {
          const edge = top.lanes[top.i++].edge;
          if (!walkable(edge)) continue;
          const s = state.get(edge.target);
          if (s === 1) backEdges.add(edge);
          else if (s === undefined) {
            state.set(edge.target, 1);
            stack.push({ v: edge.target, lanes: liveLanes(edge.target), i: 0 });
          }
        } else {
          state.set(top.v, 2);
          stack.pop();
        }
      }
    }
  }

  // --- Dominators: reducible loops ----------------------------------------
  const idom = immediateDominators(ENTRY, (v) =>
    v === ENTRY ? treeRoots : laneTargets(v),
  );
  const dominates = (a: string, b: string): boolean => {
    for (let v: string | undefined = b; v !== undefined;) {
      if (v === a) return true;
      const up = idom.get(v);
      if (up === undefined || up === v) return false;
      v = up;
    }
    return false;
  };
  interface LoopInfo {
    body: Set<string>;
    backEdges: Edge[];
  }
  const loops = new Map<string, LoopInfo>();
  const loopBackEdges = new Set<Edge>();
  const preds = new Map<string, string[]>();
  for (const node of firstNodes) {
    for (const t of laneTargets(node.id)) {
      const list = preds.get(t);
      if (list) list.push(node.id);
      else preds.set(t, [node.id]);
    }
  }
  // File order, so a header's back edges are listed as the file has them.
  for (const edge of def.edges) {
    if (!backEdges.has(edge) || !dominates(edge.target, edge.source)) continue;
    loopBackEdges.add(edge);
    const header = edge.target;
    let info = loops.get(header);
    if (!info) {
      info = { body: new Set([header]), backEdges: [] };
      loops.set(header, info);
    }
    info.backEdges.push(edge);
    // The natural loop: everything that reaches the latch without the header.
    const work = [edge.source];
    while (work.length > 0) {
      const v = work.pop()!;
      if (info.body.has(v)) continue;
      info.body.add(v);
      for (const p of preds.get(v) ?? []) work.push(p);
    }
  }

  // --- Post-dominators on the forward graph -------------------------------
  // Back edges removed: a loop's back edge goes to its header's latch, any
  // other back edge (an irreducible loop) is a link and leaves to EXIT, as
  // do END, edges into START, and nodes without successors.
  const forward = new Map<string, string[]>();
  for (const node of firstNodes) {
    if (isEndSink(node, origin)) continue;
    const succ: string[] = [];
    for (const { edge } of liveLanes(node.id)) {
      if (loopBackEdges.has(edge)) succ.push(LATCH + edge.target);
      else if (backEdges.has(edge) || !walkable(edge)) succ.push(EXIT);
      else succ.push(edge.target);
    }
    if (succ.length === 0) succ.push(EXIT);
    forward.set(node.id, succ);
  }
  for (const header of loops.keys()) forward.set(LATCH + header, [EXIT]);
  const reversePreds = new Map<string, string[]>();
  for (const [v, succ] of forward) {
    for (const w of succ) {
      const list = reversePreds.get(w);
      if (list) list.push(v);
      else reversePreds.set(w, [v]);
    }
  }
  const ipdomRaw = immediateDominators(EXIT, (v) => reversePreds.get(v) ?? []);
  /** The node a fork's lanes meet at again, or null. */
  const ipdom = (id: string): string | null => {
    const p = ipdomRaw.get(id);
    if (p === undefined || p === EXIT) return null;
    return p.startsWith(LATCH) ? p.slice(LATCH.length) : p;
  };

  // --- Walk ---------------------------------------------------------------
  const placed = new Set<string>();
  const inLoop = new Set<string>();
  const drawnEdges = new Map<string, { source: string; target: string }>();
  const nodePath = new Map<string, { path: SeqPath; index: number }>();
  const links: LinkEdge[] = [];
  const draw = (edge: Edge) =>
    drawnEdges.set(edge.id, { source: edge.source, target: edge.target });

  // Links no walk follows: dangling edges, edges out of an END.
  for (const edge of def.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) links.push({ edge, role: "dangling" });
    else if (source !== origin && isTerminal(source)) {
      links.push({ edge, role: "outOfEnd" });
    }
  }
  const laneOf = new Map<Edge, LaneCondition>();
  for (const out of outs.values()) {
    for (const lane of out.lanes) laneOf.set(lane.edge, lane.condition);
  }

  type Entry = { edge: Edge } | { node: string };
  /** Dead lanes still to walk, in the order they were met. */
  const deadLanes: Array<() => void> = [];
  const walkDeadLanes = () => {
    for (let walk = deadLanes.shift(); walk; walk = deadLanes.shift()) walk();
  };

  const walkSeq = (
    path: SeqPath,
    entry: Entry,
    stop: ReadonlySet<string>,
    region: ReadonlySet<string> | null,
    headerOnEntry: string | null,
  ): Seq => {
    const blocks: Block[] = [];
    const done = (exit: SeqExit): Seq => ({ path, blocks, exit });
    let edge: Edge | null = "edge" in entry ? entry.edge : null;
    let id: string = "edge" in entry ? entry.edge.target : entry.node;
    let header = headerOnEntry;
    for (;;) {
      if (edge) {
        const target = nodesById.get(id)!;
        const linkExit = (role: LinkEdge["role"]): Seq => {
          links.push({ edge: edge!, role });
          return done({ kind: "link", edgeId: edge!.id, target: id });
        };
        if (target === origin) return linkExit("intoStart");
        if (isEndSink(target, origin)) {
          draw(edge);
          return done({ kind: "end", edgeId: edge.id });
        }
        const condition = laneOf.get(edge);
        const dead = condition !== undefined && !isLive(condition);
        // A lane that never runs into a node drawn elsewhere (a merge, a
        // loop header included) is a link, never drawn as if it ran there.
        if (dead && id !== header && (placed.has(id) || stop.has(id))) {
          return linkExit("dead");
        }
        if (stop.has(id) && id !== header) {
          draw(edge);
          return done({ kind: "fallthrough", to: id, edgeId: edge.id });
        }
        // A node outside the loop that is not placed yet (an exit other
        // than the one the loop continues at) is walked on in the lane: it
        // runs only through it.
        if (placed.has(id)) {
          return linkExit(backEdges.has(edge) ? "back" : "join");
        }
      }
      const node = nodesById.get(id)!;
      const index = blocks.length;

      // A loop header seen for the first time: the loop is one block.
      const loop = loops.get(id);
      if (loop && !inLoop.has(id)) {
        inLoop.add(id);
        const outside = (t: string) => !loop.body.has(t);
        let firstExit: string | null = null;
        for (const e of def.edges) {
          if (!loop.body.has(e.source) || !outside(e.target)) continue;
          const condition = laneOf.get(e);
          if (!condition || !isLive(condition) || !walkable(e)) continue;
          const t = e.target;
          if (
            stop.has(t) ||
            (!placed.has(t) && (region === null || region.has(t)))
          ) {
            firstExit = t;
            break;
          }
        }
        const bodyStop = new Set(stop);
        bodyStop.add(id);
        if (firstExit !== null) bodyStop.add(firstExit);
        const bodyPath = `${path}/${index}/body`;
        const body = walkSeq(
          bodyPath,
          edge ? { edge } : { node: id },
          bodyStop,
          loop.body,
          id,
        );
        blocks.push({
          kind: "loop",
          headerId: id,
          body,
          backEdgeIds: loop.backEdges.map((e) => e.id),
        });
        if (firstExit === null) {
          return done({ kind: "stop", reason: "blockEnds" });
        }
        if (stop.has(firstExit)) {
          return done({ kind: "fallthrough", to: firstExit, edgeId: null });
        }
        edge = null;
        id = firstExit;
        header = null;
        continue;
      }

      placed.add(id);
      if (edge) draw(edge);
      header = null;
      const out = outs.get(id)!;
      const isOrigin = node === origin;
      // A fork: two or more lanes, or one that never runs (a switch /
      // choice whose only edge has no handle it can pick).
      if (
        out.lanes.length >= 2 ||
        (out.lanes.length === 1 && !isLive(out.lanes[0].condition))
      ) {
        nodePath.set(id, { path, index });
        let merge = ipdom(id);
        if (
          merge !== null &&
          (merge === id ||
            (!stop.has(merge) &&
              (placed.has(merge) || (region !== null && !region.has(merge)))))
        ) {
          merge = null;
        }
        const laneStop = merge !== null ? new Set([...stop, merge]) : stop;
        const fork: ForkBlock = {
          kind: "fork",
          forkKind: out.forkKind,
          node,
          edgeIn: edge?.id ?? null,
          lanes: [],
          merge: merge !== null ? { kind: "node", nodeId: merge } : null,
        };
        blocks.push(fork);
        out.lanes.forEach((lane, j) => {
          const lanePath = `${path}/${index}/lanes/${j}`;
          const entry: Lane = {
            edgeId: lane.edge.id,
            handle: handleOf(lane.edge),
            condition: lane.condition,
            body: { path: lanePath, blocks: [], exit: PENDING },
          };
          fork.lanes.push(entry);
          const walk = () => {
            entry.body = walkSeq(
              lanePath,
              { edge: lane.edge },
              laneStop,
              region,
              null,
            );
          };
          // A dead lane waits until every live lane is walked: a node a run
          // reaches is placed where it runs, not in a lane that never does.
          if (isLive(lane.condition)) walk();
          else deadLanes.push(walk);
        });
        if (merge === null) return done({ kind: "stop", reason: "blockEnds" });
        if (stop.has(merge)) {
          return done({ kind: "fallthrough", to: merge, edgeId: null });
        }
        edge = null;
        id = merge;
        continue;
      }
      if (!isOrigin) {
        nodePath.set(id, { path, index });
        blocks.push({ kind: "step", node, edgeIn: edge?.id ?? null });
        if (isTerminal(node)) {
          return done({ kind: "stop", reason: "terminalStep" });
        }
      }
      if (out.lanes.length === 1) {
        edge = out.lanes[0].edge;
        id = edge.target;
        continue;
      }
      const dangling = (program.edgesFrom.get(id) ?? []).find(
        (e) => !nodesById.has(e.target),
      );
      return done(
        dangling
          ? { kind: "stop", reason: "dangling", edgeId: dangling.id }
          : { kind: "stop", reason: "noEdge" },
      );
    }
  };

  const empty = new Set<string>();
  const root: Seq = origin
    ? walkSeq("root", { node: origin.id }, empty, null, null)
    : { path: "root", blocks: [], exit: { kind: "stop", reason: "noEdge" } };
  walkDeadLanes();
  const detached: Seq[] = [];
  for (const node of firstNodes) {
    if (node === origin || isEndSink(node, origin) || placed.has(node.id)) {
      continue;
    }
    detached.push(
      walkSeq(
        `detached/${detached.length}`,
        { node: node.id },
        empty,
        null,
        null,
      ),
    );
    walkDeadLanes();
  }
  // Links in file order.
  const edgeIndex = new Map(def.edges.map((e, i) => [e, i]));
  links.sort((a, b) => edgeIndex.get(a.edge)! - edgeIndex.get(b.edge)!);
  return {
    root,
    detached,
    links,
    drawnEdges,
    nodePath,
    origin: origin ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tree helpers

/** The node a block is entered at. */
export function firstNodeOf(block: Block): ScenarioNode {
  if (block.kind === "loop") return firstNodeOf(block.body.blocks[0]);
  return block.node;
}

/** Every sequence of the tree, depth first (root, then detached). */
export function allSeqs(tree: Pick<BlockTree, "root" | "detached">): Seq[] {
  const out: Seq[] = [];
  const visit = (seq: Seq) => {
    out.push(seq);
    for (const block of seq.blocks) {
      if (block.kind === "fork") for (const l of block.lanes) visit(l.body);
      if (block.kind === "loop") visit(block.body);
    }
  };
  visit(tree.root);
  tree.detached.forEach(visit);
  return out;
}

/** Every node the tree places (fork nodes and the origin included), in
 *  pre-order. */
export function treeNodes(
  tree: Pick<BlockTree, "root" | "detached" | "origin">,
): ScenarioNode[] {
  const out: ScenarioNode[] = [];
  const rootFork = tree.root.blocks[0];
  if (
    tree.origin &&
    !(rootFork?.kind === "fork" && rootFork.node.id === tree.origin.id)
  ) {
    out.push(tree.origin);
  }
  const visit = (seq: Seq) => {
    for (const block of seq.blocks) {
      if (block.kind === "step") out.push(block.node);
      if (block.kind === "fork") {
        out.push(block.node);
        for (const l of block.lanes) visit(l.body);
      }
      if (block.kind === "loop") visit(block.body);
    }
  };
  visit(tree.root);
  tree.detached.forEach(visit);
  return out;
}

/**
 * Throws unless the tree places every node other than END exactly once and
 * accounts for every edge exactly once (drawn or a link). Dev / test check.
 */
export function assertTreeCovers(def: Def, tree: BlockTree): void {
  const origin = tree.origin ?? undefined;
  const expected = new Set<string>();
  for (const node of def.nodes) {
    if (!isEndSink(node, origin)) expected.add(node.id);
  }
  const seen = new Map<string, number>();
  for (const node of treeNodes(tree)) {
    seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count !== 1) throw new Error(`node ${id} placed ${count} times`);
    if (!expected.has(id)) throw new Error(`node ${id} is not in the file`);
  }
  for (const id of expected) {
    if (!seen.has(id)) throw new Error(`node ${id} is not placed`);
  }
  const edgeCount = new Map<string, number>();
  for (const id of tree.drawnEdges.keys()) edgeCount.set(id, 1);
  for (const link of tree.links) {
    edgeCount.set(link.edge.id, (edgeCount.get(link.edge.id) ?? 0) + 1);
  }
  const fileIds = new Set(def.edges.map((e) => e.id));
  for (const [id, count] of edgeCount) {
    if (count !== 1) throw new Error(`edge ${id} accounted ${count} times`);
    if (!fileIds.has(id)) throw new Error(`edge ${id} is not in the file`);
  }
  for (const id of fileIds) {
    if (!edgeCount.has(id)) throw new Error(`edge ${id} is not accounted`);
  }
}

// ---------------------------------------------------------------------------
// Rebuild (design §3)

interface Req {
  source: string;
  target: string;
  /** A string or null (none) is what the edge must carry; undefined (a
   *  chain edge) keeps a reused edge's own and gives a new one the
   *  default of its node type. */
  handle: string | null | undefined;
  preferId: string | null;
  /** A lane that runs (or a chain edge): first-edge-wins must pick it. */
  live: boolean;
  kind?: "timeout";
}

/** One edge the editor must keep the one the executor takes. */
export interface StructuralEdge {
  edgeId: string;
  source: string;
  /** The handle the node picks for it; null for a chain edge (the first
   *  edge to an existing node). */
  handle: string | null;
}

/**
 * Throws when an edge the editor draws as running is not the one the
 * executor takes: for a chain edge the first edge (to an existing node) of
 * its source, for a lane (and for the one edge of a switch / choice that is
 * still a chain) the first edge with its handle. Reordering edges
 * would otherwise revive dead ones.
 */
export function assertFirstEdgeWins(
  def: Def,
  structural: readonly StructuralEdge[],
): void {
  const program = lowerScenario<ScenarioNode, Edge>(def);
  for (const s of structural) {
    const node = program.nodesById.get(s.source);
    if (!node || node === program.origin) continue;
    // TODO(timeout lanes / parallel): a chain edge must be the first edge
    // with the wait's timeout edges left out, and a timeout lane the edge the
    // timeout outcome takes; a parallel node's lanes all run (no check).
    const step = nextStep(program, node, s.handle);
    if (step.kind === "edge" && step.edge.id === s.edgeId) continue;
    throw new Error(
      `first edge wins: ${s.source} (${s.handle ?? "chain"}) takes ${
        step.kind === "edge" ? step.edge.id : step.kind
      }, not ${s.edgeId}`,
    );
  }
}

/** The edges `tree` needs, in emit order: chain and lane edges, exits;
 *  `endTarget` names the END an exit to END goes to. */
function requiredEdges(
  tree: BlockTree,
  endTarget: (exit: { edgeId: string | null }) => string,
): Req[] {
  const origin = tree.origin;
  const reqs: Req[] = [];
  interface Pending {
    source: string;
    handle: string | null | undefined;
    preferId: string | null;
    live: boolean;
  }
  const need = (p: Pending, target: string, fallbackId: string | null) =>
    reqs.push({
      source: p.source,
      target,
      handle: p.handle,
      preferId: p.preferId ?? fallbackId,
      live: p.live,
    });
  const emitSeq = (seq: Seq, entry: Pending | null): void => {
    let pending: Pending | null = entry;
    for (const block of seq.blocks) {
      if (block.kind === "loop") {
        emitSeq(block.body, pending);
        pending = null;
        continue;
      }
      if (pending) need(pending, block.node.id, block.edgeIn);
      if (block.kind === "step") {
        pending = isTerminal(block.node)
          ? null
          : {
              source: block.node.id,
              handle: undefined,
              preferId: null,
              live: true,
            };
        continue;
      }
      for (const lane of block.lanes) {
        emitSeq(lane.body, {
          source: block.node.id,
          handle: lane.handle,
          preferId: lane.edgeId,
          live: block.node.id !== origin?.id && isLive(lane.condition),
        });
      }
      pending = null;
    }
    if (!pending) return;
    const exit = seq.exit;
    if (exit.kind === "end") need(pending, endTarget(exit), exit.edgeId);
    else if (exit.kind === "link") need(pending, exit.target, exit.edgeId);
    else if (exit.kind === "fallthrough") {
      need(pending, exit.to, exit.edgeId ?? null);
    }
  };
  const rootFork = tree.root.blocks[0];
  const rootEntry: Pending | null =
    origin && !(rootFork?.kind === "fork" && rootFork.node.id === origin.id)
      ? { source: origin.id, handle: undefined, preferId: null, live: false }
      : null;
  emitSeq(tree.root, rootEntry);
  for (const seq of tree.detached) emitSeq(seq, null);
  return reqs;
}

const NODE_SPACING_Y = 120;

/**
 * Writes `tree` (recognized from `def`, possibly edited) back into a
 * definition. Nodes keep their order and positions (a new node is placed
 * just below its predecessor and appended); edges keep their id, fields and
 * index when reused, links are written back untouched. Never mutates its
 * inputs. A no-op round trip returns `def` with only `updatedAt` changed.
 */
export function rebuildFromTree<D extends Def>(def: D, tree: BlockTree): D {
  assertMergesConsistent(tree);
  const origin = tree.origin;
  const oldById = new Map<string, ScenarioNode>();
  for (const n of def.nodes) if (!oldById.has(n.id)) oldById.set(n.id, n);
  const placedNodes = treeNodes(tree);
  const inTree = new Map(placedNodes.map((n) => [n.id, n]));
  const isSink = (n: ScenarioNode) =>
    n.id !== origin?.id && n.type === ScenarioNodeType.END;

  // END for a new exit: the first END in the file, else a new one.
  let newEnd: ScenarioNode | null = null;
  const firstEnd = def.nodes.find(isSink);
  const endTarget = (exit: { edgeId: string | null }): string => {
    const old = def.edges.find((e) => e.id === exit.edgeId);
    const oldTarget = old ? oldById.get(old.target) : undefined;
    if (oldTarget && isSink(oldTarget)) return oldTarget.id;
    if (firstEnd) return firstEnd.id;
    newEnd ??= createDefaultNode(ScenarioNodeType.END);
    return newEnd.id;
  };

  const reqs = requiredEdges(tree, endTarget);

  // --- Nodes ----------------------------------------------------------------
  const keptIds = new Set<string>(inTree.keys());
  for (const n of def.nodes) if (isSink(n)) keptIds.add(n.id);
  const seenIds = new Set<string>();
  const nodes: ScenarioNode[] = [];
  for (const n of def.nodes) {
    const first = !seenIds.has(n.id);
    seenIds.add(n.id);
    if (!first) {
      nodes.push(n); // A duplicate id: never reachable, kept as it is.
      continue;
    }
    if (!keptIds.has(n.id)) continue; // removed
    nodes.push(inTree.get(n.id) ?? n);
  }
  const positions = new Map(nodes.map((n) => [n.id, n.position]));
  const appended: ScenarioNode[] = [];
  const placeNew = (n: ScenarioNode) => {
    const pred = reqs.find((r) => r.target === n.id)?.source;
    const at = pred !== undefined ? positions.get(pred) : undefined;
    const placedNode = at
      ? { ...n, position: { x: at.x, y: at.y + NODE_SPACING_Y } }
      : n;
    positions.set(n.id, placedNode.position);
    appended.push(placedNode);
  };
  for (const n of placedNodes) if (!oldById.has(n.id)) placeNew(n);
  if (newEnd) placeNew(newEnd);
  nodes.push(...appended);
  const finalIds = new Set(nodes.map((n) => n.id));

  // --- Edges ----------------------------------------------------------------
  const old = def.edges;
  const assigned: Array<Edge | null> = old.map(() => null);
  const removed = (id: string) => oldById.has(id) && !finalIds.has(id);
  // Links nothing structures (dangling, out of END) stay as they are.
  const untouched = new Set<Edge>();
  for (const link of tree.links) {
    if (
      link.role === "dangling" ||
      link.role === "outOfEnd" ||
      link.role === "timeoutDead"
    ) {
      if (removed(link.edge.source) || removed(link.edge.target)) continue;
      untouched.add(link.edge);
    }
  }
  const used = old.map((e) => untouched.has(e));
  old.forEach((e, i) => {
    if (used[i]) assigned[i] = e;
  });
  const reqEdge: Array<{ index: number } | null> = reqs.map(() => null);
  const take = (r: number, i: number) => {
    used[i] = true;
    reqEdge[r] = { index: i };
  };
  const pass = (match: (req: Req, e: Edge) => boolean) => {
    reqs.forEach((req, r) => {
      if (reqEdge[r]) return;
      const i = old.findIndex((e, k) => !used[k] && match(req, e));
      if (i !== -1) take(r, i);
    });
  };
  const handleFits = (req: Req, e: Edge) =>
    req.handle === undefined || handleOf(e) === req.handle;
  pass((req, e) => e.id === req.preferId && e.source === req.source);
  pass(
    (req, e) =>
      e.source === req.source && e.target === req.target && handleFits(req, e),
  );
  pass((req, e) => e.source === req.source && handleFits(req, e));

  const outIds = new Set<string>();
  reqs.forEach((req, r) => {
    const hit = reqEdge[r];
    if (!hit) return;
    const e = old[hit.index];
    let next: Edge = e;
    if (e.target !== req.target) next = { ...next, target: req.target };
    if (req.handle !== undefined && handleOf(e) !== req.handle) {
      if (req.handle === null) {
        const { sourceHandle: _dropped, ...rest } = next;
        next = rest;
      } else next = { ...next, sourceHandle: req.handle };
    }
    assigned[hit.index] = next;
  });
  for (const e of assigned) if (e) outIds.add(e.id);
  const oldIds = new Set(old.map((e) => e.id));
  const fresh: Array<{ edge: Edge; slot: number | null; req: number }> = [];
  const typeOf = (id: string) => inTree.get(id)?.type ?? oldById.get(id)?.type;
  reqs.forEach((req, r) => {
    if (reqEdge[r]) return;
    const id =
      req.preferId !== null &&
      !outIds.has(req.preferId) &&
      (!oldIds.has(req.preferId) ||
        old.every((e, k) => e.id !== req.preferId || !used[k]))
        ? req.preferId
        : crypto.randomUUID();
    outIds.add(id);
    let handle = req.handle;
    if (handle === undefined) {
      const type = typeOf(req.source);
      handle =
        type === ScenarioNodeType.SWITCH
          ? "default"
          : type === ScenarioNodeType.CHOICE
            ? "option-0"
            : null;
    }
    const edge: Edge = {
      id,
      source: req.source,
      target: req.target,
      ...(handle !== null ? { sourceHandle: handle } : {}),
      ...(req.kind ? { kind: req.kind } : {}),
    } as Edge;
    // A new edge takes the slot of the old edge it replaces (same id).
    const slot = old.findIndex((e, k) => e.id === req.preferId && !used[k]);
    fresh.push({ edge, slot: slot === -1 ? null : slot, req: r });
  });
  const edges: Edge[] = [];
  old.forEach((_, i) => {
    if (assigned[i]) edges.push(assigned[i]!);
    for (const f of fresh) if (f.slot === i) edges.push(f.edge);
  });
  for (const f of fresh) if (f.slot === null) edges.push(f.edge);

  const result = {
    ...def,
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  } as D;

  // First edge wins: every live chain / lane edge must be the one that runs.
  const structural: StructuralEdge[] = [];
  reqs.forEach((req, r) => {
    if (!req.live) return;
    const hit = reqEdge[r];
    const edge = hit
      ? assigned[hit.index]!
      : fresh.find((f) => f.req === r)!.edge;
    const node = inTree.get(req.source);
    // A switch / choice runs an edge through its handle, chain or lane: check
    // the edge it takes for that handle. Any other node: its first edge.
    // TODO(timeout lanes): a wait's timeout edge is not its chain edge; check
    // the event lane with the timeout edges left out, the timeout lane on its
    // own (nextStep with the timeout outcome).
    const select =
      node !== undefined && connectionRule(node.type).out === "select";
    structural.push({
      edgeId: edge.id,
      source: req.source,
      handle: select ? handleOf(edge) : null,
    });
  });
  assertFirstEdgeWins(result, structural);
  return result;
}

/**
 * Throws unless every fork's merge is where its sequence goes on after it:
 * the next block, or the node the sequence falls through to. Operations keep
 * the tree consistent without recognizing it again; dev / test check, run
 * by {@link rebuildFromTree} on every write: an inconsistent tree is a bug in
 * an operation, and refusing to write it beats writing a file whose meaning
 * changed.
 */
export function assertMergesConsistent(
  tree: Pick<BlockTree, "root" | "detached">,
): void {
  for (const seq of allSeqs(tree)) {
    seq.blocks.forEach((block, i) => {
      if (block.kind !== "fork" || block.merge === null) return;
      const next = nodeAtSlot(seq, i + 1);
      if (next !== block.merge.nodeId) {
        throw new Error(
          `fork ${block.node.id} merges at ${block.merge.nodeId}, but ${seq.path} goes on at ${next}`,
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Operations (design §4)

/** A copy of the tree's structure (sequences, blocks, lanes, exits); nodes
 *  and link edges are shared. */
function cloneTree(tree: BlockTree): BlockTree {
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
function loopOfBody(tree: BlockTree, path: SeqPath): LoopBlock | null {
  const m = /^(.*)\/(\d+)\/body$/.exec(path);
  if (!m) return null;
  const block = seqAt(tree, m[1])?.blocks[Number(m[2])];
  return block?.kind === "loop" ? block : null;
}

/** Where a node's block is: its sequence and index (the origin of a chain
 *  root is not a block). */
function locate(
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
function redirectFallthroughs(
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
const innerSeqs = (block: Block | undefined): Seq[] =>
  !block || block.kind === "step"
    ? []
    : block.kind === "loop"
      ? [block.body]
      : block.lanes.map((l) => l.body);

/** Whether anything inside `block` falls through to `nodeId`. */
function fallsThroughTo(block: Block, nodeId: string): boolean {
  let found = false;
  const visit = (seq: Seq) => {
    if (seq.exit.kind === "fallthrough" && seq.exit.to === nodeId) found = true;
    for (const b of seq.blocks) innerSeqs(b).forEach(visit);
  };
  innerSeqs(block).forEach(visit);
  return found;
}

/** The node the run reaches at slot `index` of `seq`: the block there, or
 *  the node the sequence falls through to; null at an end / link / stop. */
function nodeAtSlot(seq: Seq, index: number): string | null {
  const block = seq.blocks[index];
  if (block) return firstNodeOf(block).id;
  return seq.exit.kind === "fallthrough" ? seq.exit.to : null;
}

/** Whether a run can reach slot `index` of `seq` (0..length). */
function slotReachable(seq: Seq, index: number): boolean {
  if (index === 0) return true;
  const prev = seq.blocks[index - 1];
  if (prev.kind === "step") return !isTerminal(prev.node);
  const at = nodeAtSlot(seq, index);
  return at !== null && fallsThroughTo(prev, at);
}

/** Puts `block` (a new step or fork) at slot `index` of `seq`, rerouting
 *  what reached that slot into it. */
function insertBlockAt(
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
    if (prev.kind === "step") {
      block.edgeIn = seq.exit.edgeId ?? null;
      if (seq.exit.kind === "link") {
        seq.exit = { ...seq.exit, edgeId: crypto.randomUUID() };
      } else seq.exit = { ...seq.exit, edgeId: null };
    }
  }
  seq.blocks.splice(index, 0, block);
}

/** Inserts a new step of `type` at slot `index` of the sequence at `path`. */
export function insertStep(
  def: ScenarioDefinition,
  tree: BlockTree,
  path: SeqPath,
  index: number,
  type: ScenarioNodeType,
): ScenarioDefinition {
  if (!canInsertAt(tree, path, index).ok) return def;
  const t = cloneTree(tree);
  const seq = seqAt(t, path)!;
  insertBlockAt(t, seq, index, {
    kind: "step",
    node: createDefaultNode(type),
    edgeIn: null,
  });
  return rebuildFromTree(def, t);
}

/** Where a run goes after the step at `index` of `seq` once that step
 *  (`removedId`) is gone: the next block, else the sequence's own ending; a
 *  loop that only repeated the step continues after the loop. */
function continuationAfter(
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
  return rebuildFromTree(def, t);
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
  const seq = seqAt(t, path)!;
  const block = removeStepBlockAt(t, seq, from, true);
  insertBlockAt(t, seq, to, { kind: "step", node: block.node, edgeIn: null });
  return rebuildFromTree(def, t);
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
    return rebuildFromTree(def, t);
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
  return rebuildFromTree(def, t);
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
  return rebuildFromTree(def, t);
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
  return rebuildFromTree(def, t);
}

/**
 * Makes blocks `from`..`to` of the sequence at `path` a loop: the last of
 * them (a step) goes back to the first. Only at the end of a sequence (the
 * steps after it would never run), and not around an existing loop header.
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
  return rebuildFromTree(def, t);
}

/** {@link wrapInLoop} on `seq` (of a clone), without the checks. */
function applyWrapInLoop(seq: Seq, from: number, to: number): void {
  const path = seq.path;
  const body = seq.blocks.slice(from, to + 1);
  const header = firstNodeOf(body[0]).id;
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
  };
  seq.blocks.splice(from, to - from + 1, loop);
  seq.exit = { kind: "stop", reason: "blockEnds" };
  repath(seq);
}

/**
 * Whether an empty "Repeat" block can go to slot `index` of the sequence at
 * `path`: the repeat never ends, so it closes its sequence (nothing may come
 * after it, and a sequence that falls through to a merge or a loop header
 * cannot hold it). The check the first step added to it is wrapped by.
 */
export function canInsertLoopAt(
  tree: BlockTree,
  path: SeqPath,
  index: number,
): Capability {
  const slot = canInsertAt(tree, path, index);
  if (!slot.ok) return slot;
  const seq = seqAt(tree, path)!;
  if (index !== seq.blocks.length || seq.exit.kind === "fallthrough") {
    return no("scenarios.editor.cannot.loopNotAtEnd");
  }
  if (index === 0 && loopOfBody(tree, path)) {
    return no("scenarios.editor.cannot.loopHeader");
  }
  return OK;
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
  type: ScenarioNodeType,
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
  return rebuildFromTree(def, t);
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
  const next = rebuildFromTree(def, out.t);
  // Safety net: the file must read back with the step where it was dropped.
  const back = recognizeBlockTree(next);
  const place = back.nodePath.get(nodeId);
  const want = loop ? `${out.target.path}/${out.at}/body` : out.target.path;
  if (!place || place.path !== want) return def;
  return next;
}

/** Whether a run in `seq` (or a lane nested in it) falls through to `id`. */
function seqFallsThroughTo(seq: Seq, id: string): boolean {
  if (seq.exit.kind === "fallthrough" && seq.exit.to === id) return true;
  return seq.blocks.some((b) => fallsThroughTo(b, id));
}

/** Whether lane `laneIndex` of `fork` (inside the loop whose header is
 *  `headerId`) leaves the loop: the views draw it outside (see
 *  `lanesLeavingLoop` in stepTree.ts, which this mirrors). */
function laneLeavesLoop(
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
function repeatingLoopAt(
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
  return rebuildFromTree(def, t);
}

/** {@link unwrapLoop} on `t` (a clone), without the checks. */
function applyUnwrapLoop(t: BlockTree, nodeId: string): void {
  const { parent, index, loop } = loopToUnwrap(t, nodeId)!;
  const next = parent.blocks[index + 1];
  const after = parent.exit;
  const goOn = (old: { edgeId?: string | null }): SeqExit => {
    const edgeId = old.edgeId ?? null;
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
  return rebuildFromTree(def, t);
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
  return rebuildFromTree(def, t);
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

function canWrapInLoop(
  tree: BlockTree,
  path: SeqPath,
  from: number,
  to: number,
): Capability {
  const seq = seqAt(tree, path);
  if (!seq || from < 0 || to < from || to >= seq.blocks.length) {
    return no("scenarios.editor.cannot.notInTree");
  }
  if (to !== seq.blocks.length - 1 || seq.exit.kind === "fallthrough") {
    return no("scenarios.editor.cannot.loopNotAtEnd");
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
      : OK;
    caps.moveUp = canMove(tree, seq.path, index, index - 1);
    caps.moveDown = canMove(tree, seq.path, index, index + 1);
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
