import type { Edge } from "@xyflow/react";

import type { ScenarioNode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  isLoopEdge,
  isTerminal,
  loopStep,
  lowerScenario,
} from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

import { immediateDominators } from "./dominators";
import {
  handleOf,
  isEndSink,
  isLive,
  type LaneEdge,
  type NodeOut,
  structuralOut,
} from "./structural";
import type {
  Block,
  BlockTree,
  Def,
  ForkBlock,
  Lane,
  LaneCondition,
  LinkEdge,
  Program,
  Seq,
  SeqExit,
  SeqPath,
} from "./types";

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
  // --- Loop edges (schema 1.10) -------------------------------------------
  // The loop edge each step may follow (`loopStep`): a candidate latch. A
  // step with several ordinary edges (an "extra" fork) is not one.
  const candidates = new Map<string, Edge>();
  for (const node of firstNodes) {
    const step = loopStep(program, node);
    if (!step || !walkable(step.edge)) continue;
    if ((outs.get(node.id)?.lanes.length ?? 0) > 1) continue;
    candidates.set(node.id, step.edge);
  }

  interface LoopInfo {
    body: Set<string>;
    backEdges: Edge[];
  }
  /** Back edges, dominators and natural loops over the lanes that run plus
   *  the `accepted` loop edges (by source). */
  const findLoops = (accepted: ReadonlyMap<string, Edge>) => {
    const lanesOf = (id: string): LaneEdge[] => {
      const lanes = liveLanes(id);
      const loopEdge = accepted.get(id);
      return loopEdge
        ? [...lanes, { edge: loopEdge, condition: { kind: "first" } }]
        : lanes;
    };
    const targetsOf = (id: string): string[] =>
      lanesOf(id)
        .filter((l) => walkable(l.edge))
        .map((l) => l.edge.target);

    // DFS forest: back edges.
    const roots: string[] = [];
    if (origin) roots.push(origin.id);
    for (const node of firstNodes) {
      if (node !== origin && !isEndSink(node, origin)) roots.push(node.id);
    }
    const backEdges = new Set<Edge>();
    /** The nodes a DFS tree starts at: the origin, then each node no
     *  earlier tree reaches (file order). */
    const treeRoots: string[] = [];
    {
      const state = new Map<string, 1 | 2>(); // 1: on stack, 2: done
      for (const root of roots) {
        if (state.has(root)) continue;
        treeRoots.push(root);
        state.set(root, 1);
        const stack: Array<{ v: string; lanes: LaneEdge[]; i: number }> = [
          { v: root, lanes: lanesOf(root), i: 0 },
        ];
        while (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top.i < top.lanes.length) {
            const edge = top.lanes[top.i++].edge;
            if (!walkable(edge)) continue;
            const st = state.get(edge.target);
            if (st === 1) backEdges.add(edge);
            else if (st === undefined) {
              state.set(edge.target, 1);
              stack.push({
                v: edge.target,
                lanes: lanesOf(edge.target),
                i: 0,
              });
            }
          } else {
            state.set(top.v, 2);
            stack.pop();
          }
        }
      }
    }

    // Dominators: reducible loops.
    const idom = immediateDominators(ENTRY, (v) =>
      v === ENTRY ? treeRoots : targetsOf(v),
    );
    const dominates = (x: string, y: string): boolean => {
      for (let v: string | undefined = y; v !== undefined;) {
        if (v === x) return true;
        const up = idom.get(v);
        if (up === undefined || up === v) return false;
        v = up;
      }
      return false;
    };
    const loops = new Map<string, LoopInfo>();
    const loopBackEdges = new Set<Edge>();
    const preds = new Map<string, string[]>();
    for (const node of firstNodes) {
      for (const t of targetsOf(node.id)) {
        const list = preds.get(t);
        if (list) list.push(node.id);
        else preds.set(t, [node.id]);
      }
    }
    // File order, so a header's back edges are listed as the file has them.
    for (const edge of def.edges) {
      if (!backEdges.has(edge) || !dominates(edge.target, edge.source)) {
        continue;
      }
      loopBackEdges.add(edge);
      const header = edge.target;
      let info = loops.get(header);
      if (!info) {
        info = { body: new Set([header]), backEdges: [] };
        loops.set(header, info);
      }
      info.backEdges.push(edge);
      // The natural loop: everything that reaches the latch without the
      // header.
      const work = [edge.source];
      while (work.length > 0) {
        const v = work.pop()!;
        if (info.body.has(v)) continue;
        info.body.add(v);
        for (const p of preds.get(v) ?? []) work.push(p);
      }
    }
    return { backEdges, loops, loopBackEdges };
  };

  // A loop edge is structured when it is the one back edge of a natural
  // loop and its source's ordinary next edge (the way out) leaves that loop.
  // The others stay links; without them the loops are found again.
  let accepted = new Map(candidates);
  let found = findLoops(accepted);
  for (;;) {
    const kept = new Map<string, Edge>();
    for (const [source, edge] of accepted) {
      const info = found.loops.get(edge.target);
      const exit = liveLanes(source)[0]?.edge;
      if (
        found.loopBackEdges.has(edge) &&
        info?.backEdges.length === 1 &&
        !(exit && walkable(exit) && info.body.has(exit.target))
      ) {
        kept.set(source, edge);
      }
    }
    if (kept.size === accepted.size) break;
    accepted = kept;
    found = findLoops(accepted);
  }
  const { backEdges, loops, loopBackEdges } = found;
  /** The structured loop edges, by source and by header. */
  const latchOf = accepted;
  const boundedAt = new Map<string, Edge>();
  for (const edge of accepted.values()) boundedAt.set(edge.target, edge);

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
  // A bounded loop's way back is its loop edge, not a lane: it has no latch
  // node, and its source goes on along its ordinary edge.
  for (const header of loops.keys()) {
    if (!boundedAt.has(header)) forward.set(LATCH + header, [EXIT]);
  }
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
  // Loop edges (schema 1.10) the tree does not structure are kept as they
  // are.
  const structuredLoopEdges = new Set(latchOf.values());
  for (const edge of def.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) links.push({ edge, role: "dangling" });
    else if (isLoopEdge(edge)) {
      if (!structuredLoopEdges.has(edge))
        links.push({ edge, role: "loopEdge" });
    } else if (source !== origin && isTerminal(source)) {
      links.push({ edge, role: "outOfEnd" });
    }
  }
  const laneOf = new Map<Edge, LaneCondition>();
  for (const out of outs.values()) {
    for (const lane of out.lanes) laneOf.set(lane.edge, lane.condition);
  }
  // Timeout edges the executor never takes (no timeout to expire, not the
  // wait's first, no event edge, or out of a node that does not wait).
  for (const edges of program.timeoutEdges.values()) {
    for (const edge of edges) {
      if (laneOf.has(edge) || links.some((l) => l.edge === edge)) continue;
      links.push({ edge, role: "timeoutDead" });
    }
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
      const bounded = boundedAt.get(id);
      if (loop && bounded && !inLoop.has(id)) {
        // A bounded loop (a loop edge): the body runs to the loop edge's
        // source, which goes on along its ordinary edge once a bound fires.
        inLoop.add(id);
        const bodyStop = new Set(stop);
        bodyStop.add(id);
        const body = walkSeq(
          `${path}/${index}/body`,
          edge ? { edge } : { node: id },
          bodyStop,
          loop.body,
          id,
        );
        if (!drawnEdges.has(bounded.id)) {
          // Defensive: the walk never reached the latch. Keep the edge.
          links.push({ edge: bounded, role: "loopEdge" });
        }
        blocks.push({
          kind: "loop",
          headerId: id,
          body,
          backEdgeIds: [bounded.id],
          loopEdge: {
            edgeId: bounded.id,
            loop: (bounded as Edge & { loop?: unknown }).loop,
          },
        });
        const exitEdge = outs.get(bounded.source)?.lanes[0]?.edge;
        if (!exitEdge) {
          const dangling = (program.edgesFrom.get(bounded.source) ?? []).find(
            (e) => !nodesById.has(e.target),
          );
          return done(
            dangling
              ? { kind: "stop", reason: "dangling", edgeId: dangling.id }
              : { kind: "stop", reason: "noEdge" },
          );
        }
        edge = exitEdge;
        id = exitEdge.target;
        header = null;
        continue;
      }
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
          loopEdge: null,
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
        // The latch of a bounded loop: back to its header by the loop edge.
        const latch = latchOf.get(id);
        if (latch && stop.has(latch.target) && inLoop.has(latch.target)) {
          draw(latch);
          return done({
            kind: "fallthrough",
            to: latch.target,
            edgeId: latch.id,
          });
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
