import type { Edge } from "@xyflow/react";

import {
  type ScenarioNode,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { connectionRule } from "@ocpp-cp-simulator/core/scenario/scenarioConnectionRules";
import {
  isLoopEdge,
  isTerminal,
  isTimeoutEdge,
  loopStep,
  lowerScenario,
  nextStep,
  timeoutStep,
} from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

import { createDefaultNode } from "../scenarioSteps";
import { handleOf, isLive } from "./structural";
import { type BlockTree, type Def, type LoopBlock, type Seq } from "./types";
import { allSeqs, nodeAtSlot, treeNodes } from "./treeHelpers";

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
  /** `"timeout"`: the edge the wait's timeout outcome takes. */
  kind?: "timeout";
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
    // A `parallel` node (schema 1.9) runs every ordinary edge: there is no
    // single edge it takes.
    if (connectionRule(node.type).out === "fork") continue;
    // A timeout lane must be the edge the timeout outcome takes; a chain
    // edge is checked with the wait's timeout edges left out (they are not
    // in `edgesFrom`).
    if (s.kind === "timeout") {
      if (timeoutStep(program, node)?.edge.id === s.edgeId) continue;
      throw new Error(
        `first edge wins: ${s.source} (timeout) does not take ${s.edgeId}`,
      );
    }
    const step = nextStep(program, node, s.handle);
    if (step.kind === "edge" && step.edge.id === s.edgeId) continue;
    throw new Error(
      `first edge wins: ${s.source} (${s.handle ?? "chain"}) takes ${
        step.kind === "edge" ? step.edge.id : step.kind
      }, not ${s.edgeId}`,
    );
  }
}

/** The loop edge a bounded loop needs: from its latch to its header. */
interface LoopReq {
  source: string;
  target: string;
  edgeId: string;
  loop: unknown;
}

/** What {@link requiredEdges} found besides the ordinary edges. */
interface LoopEdges {
  reqs: LoopReq[];
  /** Bounded loops that do not have exactly one latch leaving by "next",
   *  by header id. */
  problems: string[];
}

/** The edges `tree` needs, in emit order: chain and lane edges, exits;
 *  `endTarget` names the END an exit to END goes to. The loop edges of
 *  bounded loops go to `loops` when given. */
export function requiredEdges(
  tree: BlockTree,
  endTarget: (exit: { edgeId: string | null }) => string,
  loops: LoopEdges = { reqs: [], problems: [] },
): Req[] {
  const origin = tree.origin;
  const reqs: Req[] = [];
  interface Pending {
    source: string;
    handle: string | null | undefined;
    preferId: string | null;
    live: boolean;
    kind?: "timeout";
    /** The step it leaves (a chain edge). */
    node?: ScenarioNode;
  }
  /** The bounded loops around, innermost last, with the ways back to their
   *  header met so far. */
  const bounded: Array<{
    loop: LoopBlock;
    latches: Array<{ pending: Pending; edgeId: string | null }>;
  }> = [];
  const latchSources = new Set<string>();
  const need = (p: Pending, target: string, fallbackId: string | null) =>
    reqs.push({
      source: p.source,
      target,
      handle: p.handle,
      preferId: p.preferId ?? fallbackId,
      live: p.live,
      ...(p.kind ? { kind: p.kind } : {}),
    });
  const emitSeq = (seq: Seq, entry: Pending | null): void => {
    let pending: Pending | null = entry;
    for (const block of seq.blocks) {
      if (block.kind === "loop") {
        if (!block.loopEdge) {
          emitSeq(block.body, pending);
          pending = null;
          continue;
        }
        const ctx = {
          loop: block,
          latches: [] as Array<{ pending: Pending; edgeId: string | null }>,
        };
        bounded.push(ctx);
        emitSeq(block.body, pending);
        bounded.pop();
        // The way back drawn with the loop edge is the latch; any other way
        // back to the header (a lane that never runs, drawn falling through)
        // is an ordinary edge. Without one, a single way back is the latch.
        const loopEdgeId = block.loopEdge.edgeId;
        const own = ctx.latches.filter((l) => l.edgeId === loopEdgeId);
        const chosen =
          own.length === 1
            ? own[0]
            : own.length === 0 && ctx.latches.length === 1
              ? ctx.latches[0]
              : undefined;
        for (const l of ctx.latches) {
          if (l !== chosen) need(l.pending, block.headerId, l.edgeId);
        }
        const latch = chosen?.pending;
        const node = latch?.node;
        if (
          !latch ||
          !node ||
          latch.handle !== undefined ||
          connectionRule(node.type).out !== "next" ||
          isTerminal(node) ||
          latchSources.has(node.id)
        ) {
          loops.problems.push(block.headerId);
          pending = null;
          continue;
        }
        latchSources.add(node.id);
        loops.reqs.push({
          source: node.id,
          target: block.headerId,
          edgeId: block.loopEdge.edgeId,
          loop: block.loopEdge.loop,
        });
        // Once a bound fires the latch goes on along its ordinary edge.
        pending = { ...latch, preferId: null, live: true };
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
              node: block.node,
            };
        continue;
      }
      for (const lane of block.lanes) {
        emitSeq(lane.body, {
          source: block.node.id,
          handle: lane.handle,
          preferId: lane.edgeId,
          live: block.node.id !== origin?.id && isLive(lane.condition),
          ...(lane.condition.kind === "timeout"
            ? { kind: "timeout" as const }
            : {}),
        });
      }
      pending = null;
    }
    if (!pending) return;
    const exit = seq.exit;
    if (exit.kind === "end") need(pending, endTarget(exit), exit.edgeId);
    else if (exit.kind === "link") need(pending, exit.target, exit.edgeId);
    else if (exit.kind === "fallthrough") {
      // Back to the header of a bounded loop around: its loop edge.
      const ctx = [...bounded]
        .reverse()
        .find((b) => b.loop.headerId === exit.to);
      if (ctx) ctx.latches.push({ pending, edgeId: exit.edgeId ?? null });
      else need(pending, exit.to, exit.edgeId ?? null);
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

  const loopEdges: LoopEdges = { reqs: [], problems: [] };
  const reqs = requiredEdges(tree, endTarget, loopEdges);
  if (loopEdges.problems.length > 0) {
    throw new Error(
      `bounded loop at ${loopEdges.problems[0]}: no single latch leaving by "next"`,
    );
  }

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
      link.role === "timeoutDead" ||
      link.role === "loopEdge"
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
  // Loop edges of bounded loops: by id. A plain back edge whose loop got
  // bounds becomes the loop edge (kind and `loop` set, the rest kept).
  const freshLoops: Edge[] = [];
  for (const lr of loopEdges.reqs) {
    const i = old.findIndex((e, k) => !used[k] && e.id === lr.edgeId);
    if (i === -1) {
      freshLoops.push({
        id: lr.edgeId,
        source: lr.source,
        target: lr.target,
        kind: "loop",
        ...(lr.loop !== undefined ? { loop: lr.loop } : {}),
      } as Edge);
      continue;
    }
    used[i] = true;
    const e = old[i] as Edge & { kind?: unknown; loop?: unknown };
    let next: Edge & { kind?: unknown; loop?: unknown } = e;
    if (e.source !== lr.source || e.target !== lr.target) {
      next = { ...next, source: lr.source, target: lr.target };
    }
    if (e.kind !== "loop") next = { ...next, kind: "loop" };
    if (e.loop !== lr.loop) {
      if (lr.loop === undefined) {
        const { loop: _dropped, ...rest } = next;
        next = rest;
      } else next = { ...next, loop: lr.loop };
    }
    assigned[i] = next;
  }
  // An ordinary edge is never matched to a loop edge (nor the other way).
  const pass = (match: (req: Req, e: Edge) => boolean) => {
    reqs.forEach((req, r) => {
      if (reqEdge[r]) return;
      const i = old.findIndex(
        (e, k) => !used[k] && !isLoopEdge(e) && match(req, e),
      );
      if (i !== -1) take(r, i);
    });
  };
  const handleFits = (req: Req, e: Edge) =>
    req.handle === undefined || handleOf(e) === req.handle;
  // A timeout lane reuses only a timeout edge, every other lane only an
  // ordinary one.
  const kindFits = (req: Req, e: Edge) =>
    (req.kind === "timeout") === isTimeoutEdge(e);
  pass(
    (req, e) =>
      e.id === req.preferId && e.source === req.source && kindFits(req, e),
  );
  pass(
    (req, e) =>
      e.source === req.source &&
      e.target === req.target &&
      handleFits(req, e) &&
      kindFits(req, e),
  );
  pass(
    (req, e) =>
      e.source === req.source && handleFits(req, e) && kindFits(req, e),
  );

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
  for (const e of freshLoops) outIds.add(e.id);
  const oldIds = new Set(old.map((e) => e.id));
  /** Ids of loop edges no loop keeps: never reused by an ordinary edge. */
  const droppedLoopIds = new Set(
    old.filter((e, k) => !used[k] && isLoopEdge(e)).map((e) => e.id),
  );
  const fresh: Array<{ edge: Edge; slot: number | null; req: number }> = [];
  const typeOf = (id: string) => inTree.get(id)?.type ?? oldById.get(id)?.type;
  reqs.forEach((req, r) => {
    if (reqEdge[r]) return;
    const id =
      req.preferId !== null &&
      !outIds.has(req.preferId) &&
      !droppedLoopIds.has(req.preferId) &&
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
    const slot = droppedLoopIds.has(req.preferId ?? "")
      ? -1
      : old.findIndex((e, k) => e.id === req.preferId && !used[k]);
    fresh.push({ edge, slot: slot === -1 ? null : slot, req: r });
  });
  const edges: Edge[] = [];
  old.forEach((_, i) => {
    if (assigned[i]) edges.push(assigned[i]!);
    for (const f of fresh) if (f.slot === i) edges.push(f.edge);
  });
  for (const f of fresh) if (f.slot === null) edges.push(f.edge);
  edges.push(...freshLoops);

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
    const select =
      node !== undefined && connectionRule(node.type).out === "select";
    structural.push({
      edgeId: edge.id,
      source: req.source,
      handle: select ? handleOf(edge) : null,
      ...(req.kind ? { kind: req.kind } : {}),
    });
  });
  assertFirstEdgeWins(result, structural);
  assertLoopEdgesFollowed(result, loopEdges.reqs);
  return result;
}

/** A bounded loop's latch already has an earlier loop edge (one the tree
 *  keeps as a link): the executor would follow that one. */
class LoopEdgeNotFollowed extends Error {}

/** Throws unless each bounded loop's edge is the one its latch follows
 *  (`loopStep`: the first loop edge to an existing node). */
function assertLoopEdgesFollowed(def: Def, reqs: readonly LoopReq[]): void {
  if (reqs.length === 0) return;
  const program = lowerScenario<ScenarioNode, Edge>(def);
  for (const r of reqs) {
    const node = program.nodesById.get(r.source);
    const step = node ? loopStep(program, node) : null;
    if (step?.edge.id !== r.edgeId) {
      throw new LoopEdgeNotFollowed(
        `loop edge ${r.edgeId}: ${r.source} follows ${step?.edge.id ?? "none"}`,
      );
    }
  }
}

/** The header of a bounded loop in `tree` that does not have exactly one
 *  latch (a step leaving by "next"), or null when every one has. */
export function boundedLoopProblem(tree: BlockTree): string | null {
  const loops: LoopEdges = { reqs: [], problems: [] };
  requiredEdges(tree, () => "", loops);
  return loops.problems[0] ?? null;
}

/** Rebuilds `t` (an edited clone), or returns `def` unchanged when the edit
 *  left a bounded loop without its single latch. */
export function commit<D extends Def>(def: D, t: BlockTree): D {
  if (boundedLoopProblem(t) !== null) return def;
  try {
    return rebuildFromTree(def, t);
  } catch (error) {
    // The latch has another loop edge first: refused, not a bug.
    if (error instanceof LoopEdgeNotFollowed) return def;
    throw error;
  }
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
