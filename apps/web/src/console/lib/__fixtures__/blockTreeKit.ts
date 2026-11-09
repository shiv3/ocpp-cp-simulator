/**
 * Shared by the block-tree tests: scenario fixtures (every shipped template
 * and docs example), a builder for hand-written graphs, the executor's view
 * of a graph for semantic comparison, and a seeded fuzz generator.
 */
import { readdirSync, readFileSync } from "node:fs";
import type { Edge } from "@xyflow/react";

import {
  type ScenarioDefinition,
  type ScenarioNode,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  lowerScenario,
  nextStep,
  pickableHandles,
  successors,
} from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

const repo = new URL("../../../../../../", import.meta.url);

function loadDir(rel: string): Array<[string, ScenarioDefinition]> {
  const dir = new URL(rel, repo);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [
      `${rel}${f}`,
      JSON.parse(readFileSync(new URL(f, dir), "utf8")) as ScenarioDefinition,
    ]);
}

/** Every shipped template (packages/core/src/utils/scenarios) and every
 *  docs example scenario, by repo-relative path. */
export function shippedScenarios(): Array<[string, ScenarioDefinition]> {
  return [
    ...loadDir("packages/core/src/utils/scenarios/"),
    ...loadDir("docs/examples/scenarios/"),
  ];
}

export function node(
  id: string,
  type: ScenarioNodeType = ScenarioNodeType.DELAY,
  data: Record<string, unknown> = { label: "Delay" },
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: data as unknown as ScenarioNode["data"],
  };
}

export const start = (id = "start") =>
  node(id, ScenarioNodeType.START, { label: "Start" });
export const end = (id = "end") =>
  node(id, ScenarioNodeType.END, { label: "End" });
export const sw = (id: string, cases: unknown[] = ["a", "b"]) =>
  node(id, ScenarioNodeType.SWITCH, { label: "Switch", value: 1, cases });
export const choice = (id: string, n = 2) =>
  node(id, ScenarioNodeType.CHOICE, {
    label: "Choice",
    options: Array.from({ length: n }, () => ({})),
  });

/** `[source, target]` or `[source, target, handle]`; ids `source->target`
 *  (with `#n` for repeats). */
export function graph(
  nodes: ScenarioNode[],
  pairs: Array<[string, string] | [string, string, string]>,
): ScenarioDefinition {
  const seen = new Map<string, number>();
  const edges: Edge[] = pairs.map(([source, target, handle]) => {
    const base = `${source}->${target}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return {
      id: n === 0 ? base : `${base}#${n}`,
      source,
      target,
      ...(handle !== undefined ? { sourceHandle: handle } : {}),
    };
  });
  return {
    id: "t",
    name: "t",
    targetType: "connector",
    nodes,
    edges,
    trigger: { type: "manual" },
    defaultExecutionMode: "oneshot",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ScenarioDefinition;
}

/**
 * What the executor does from every node: the edges it follows
 * (`successors`, as origin too), and per handle the node can pick the edge
 * `nextStep` takes. Two graphs with the same semantics run the same.
 */
export function semantics(def: Pick<ScenarioDefinition, "nodes" | "edges">) {
  const program = lowerScenario<ScenarioNode, Edge>(def);
  const out: Record<string, unknown> = {};
  for (const n of program.nodesById.values()) {
    const step = (h: string | null) => {
      const s = nextStep(program, n, h);
      return s.kind === "edge" ? `${s.edge.id}>${s.edge.target}` : s.kind;
    };
    out[n.id] = {
      successors: successors(program, n).map((e) => `${e.id}>${e.target}`),
      asOrigin:
        n === program.origin
          ? successors(program, n, { asOrigin: true }).map(
              (e) => `${e.id}>${e.target}`,
            )
          : null,
      next: step(null),
      handles: (pickableHandles(n) ?? []).map((h) => [h, step(h)]),
    };
  }
  return out;
}

/** Which edges the executor follows (as the origin: all of them), by id. */
export function liveEdgeIds(
  def: Pick<ScenarioDefinition, "nodes" | "edges">,
): Set<string> {
  const program = lowerScenario<ScenarioNode, Edge>(def);
  const live = new Set<string>();
  for (const n of program.nodesById.values()) {
    const followed =
      n === program.origin
        ? successors(program, n, { asOrigin: true })
        : successors(program, n);
    for (const e of followed) live.add(e.id);
  }
  return live;
}

/**
 * What an edit changed beyond what it touched, as messages (empty: nothing).
 * - A node whose outgoing edges (id, target, handle, in file order) are the
 *   same before and after must run the same (`semantics`).
 * - An edge the edit kept as it was (same id, source, target, handle) must
 *   keep running, or keep never running: an edit must not revive a dead
 *   edge or kill a live one it did not touch. `promoted` names the edges an
 *   edit may make run on purpose (removing a step's first edge runs its
 *   next one).
 */
export function semanticDrift(
  before: Pick<ScenarioDefinition, "nodes" | "edges">,
  after: Pick<ScenarioDefinition, "nodes" | "edges">,
  promoted: ReadonlySet<string> = new Set(),
): string[] {
  const problems: string[] = [];
  const outOf = (def: typeof before, id: string) =>
    JSON.stringify(
      def.edges
        .filter((e) => e.source === id)
        .map((e) => [e.id, e.target, e.sourceHandle ?? null]),
    );
  const semBefore = semantics(before);
  const semAfter = semantics(after);
  for (const id of Object.keys(semBefore)) {
    if (!(id in semAfter) || outOf(before, id) !== outOf(after, id)) continue;
    if (JSON.stringify(semBefore[id]) !== JSON.stringify(semAfter[id])) {
      problems.push(`untouched node ${id} runs differently`);
    }
  }
  const liveBefore = liveEdgeIds(before);
  const liveAfter = liveEdgeIds(after);
  const afterById = new Map(after.edges.map((e) => [e.id, e]));
  for (const e of before.edges) {
    const now = afterById.get(e.id);
    if (
      !now ||
      now.source !== e.source ||
      now.target !== e.target ||
      (now.sourceHandle ?? null) !== (e.sourceHandle ?? null) ||
      promoted.has(e.id)
    ) {
      continue;
    }
    if (liveBefore.has(e.id) !== liveAfter.has(e.id)) {
      problems.push(
        `untouched edge ${e.id} ${liveBefore.has(e.id) ? "stops" : "starts"} running`,
      );
    }
  }
  return problems;
}

/** xorshift32: a small seeded generator, so a failing case can be replayed. */
export function xorshift(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/**
 * A random graph: 2–12 nodes of START (often first, sometimes several or
 * none), END, step, wait, switch (cases possibly not an array) and choice
 * (possibly too few options or a zero weight); edges with duplicate and
 * unpickable handles, dangling targets, edges out of END and into START,
 * back edges and reconverging branches all occur.
 */
export function randomScenario(rand: () => number): ScenarioDefinition {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const count = 2 + Math.floor(rand() * 11);
  const nodes: ScenarioNode[] = [];
  for (let i = 0; i < count; i++) {
    const id = `n${i}`;
    const r = rand();
    if (i === 0 && rand() < 0.9) nodes.push(start(id));
    else if (r < 0.06) nodes.push(start(id));
    else if (r < 0.2) nodes.push(end(id));
    else if (r < 0.36) {
      const k = Math.floor(rand() * 4);
      nodes.push(
        sw(
          id,
          rand() < 0.08
            ? ("x" as unknown as unknown[])
            : [..."abc"].slice(0, k),
        ),
      );
    } else if (r < 0.46) {
      const k = Math.floor(rand() * 4);
      nodes.push(
        node(id, ScenarioNodeType.CHOICE, {
          label: "Choice",
          options: Array.from({ length: k }, () =>
            rand() < 0.1
              ? { weight: 0 }
              : { weight: 1 + Math.floor(rand() * 3) },
          ),
        }),
      );
    } else if (r < 0.56) {
      nodes.push(
        node(id, ScenarioNodeType.STATUS_TRIGGER, {
          label: "Wait for Status",
          timeout: 0,
        }),
      );
    } else nodes.push(node(id));
    nodes[i] = {
      ...nodes[i],
      position: { x: Math.floor(rand() * 500), y: Math.floor(rand() * 900) },
    };
  }
  const edges: Edge[] = [];
  for (const source of nodes) {
    const k = Math.floor(
      rand() * (source.type === ScenarioNodeType.END ? 2 : 4),
    );
    for (let j = 0; j < k; j++) {
      const target = rand() < 0.05 ? "missing" : pick(nodes).id;
      let handle: string | undefined;
      if (
        source.type === ScenarioNodeType.SWITCH ||
        source.type === ScenarioNodeType.CHOICE
      ) {
        const handles = [
          ...(pickableHandles(source) ?? []),
          "case-7",
          "option-0",
          "default",
        ];
        handle = rand() < 0.1 ? undefined : pick(handles);
      } else if (rand() < 0.05) handle = "default";
      edges.push({
        id: `e${edges.length}`,
        source: rand() < 0.02 ? "ghost" : source.id,
        target,
        ...(handle !== undefined ? { sourceHandle: handle } : {}),
      });
    }
  }
  // Shuffle edge order a little: file order matters (first edge wins).
  for (let i = edges.length - 1; i > 0; i--) {
    if (rand() < 0.3) {
      const j = Math.floor(rand() * (i + 1));
      [edges[i], edges[j]] = [edges[j], edges[i]];
    }
  }
  return { ...graph(nodes, []), edges };
}

/**
 * A random graph of the shape the run views have always drawn: a chain from
 * START, maybe one fork (START fan-out, a switch, a choice, or a step with
 * several edges), branches of steps that end at END, nowhere, on a dangling
 * edge, or jump back / join with a link. Exercises the StepLayout adapter
 * and the operations on editor-made graphs.
 */
export function randomLayoutScenario(rand: () => number): ScenarioDefinition {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const nodes: ScenarioNode[] = [start("s")];
  const edges: Edge[] = [];
  const endNode = end("end");
  const add = (source: string, target: string, handle?: string) =>
    edges.push({
      id: `e${edges.length}`,
      source,
      target,
      ...(handle !== undefined ? { sourceHandle: handle } : {}),
    });
  const step = (id: string) => {
    const n =
      rand() < 0.2
        ? node(id, ScenarioNodeType.STATUS_TRIGGER, {
            label: "Wait",
            timeout: 0,
          })
        : node(id);
    nodes.push(n);
    return n.id;
  };
  let prev = "s";
  const chainLength = Math.floor(rand() * 4);
  for (let i = 0; i < chainLength; i++) {
    const id = step(`m${i}`);
    add(prev, id);
    prev = id;
  }
  const forkKind = pick([
    "none",
    "start",
    "switch",
    "choice",
    "extra",
  ] as const);
  const ending = (from: string, placed: string[]) => {
    const r = rand();
    if (r < 0.5) add(from, "end");
    else if (r < 0.75 && placed.length > 0) add(from, pick(placed));
    else if (r < 0.85) add(from, "missing");
  };
  if (forkKind === "none") {
    ending(
      prev,
      nodes.slice(1).map((n) => n.id),
    );
  } else {
    let forkId = prev;
    if (forkKind === "switch" || forkKind === "choice") {
      const f = forkKind === "switch" ? sw("f", ["a", "b"]) : choice("f", 3);
      nodes.push(f);
      add(prev, f.id);
      forkId = f.id;
    } else if (forkKind === "extra" && prev === "s") {
      forkId = step("f");
      add("s", forkId);
    } else if (forkKind === "start") forkId = "s";
    const handles =
      forkKind === "switch"
        ? ["case-0", "case-1", "default"]
        : forkKind === "choice"
          ? ["option-0", "option-1", "option-2"]
          : [];
    const lanes = 2 + Math.floor(rand() * 2);
    const placed = nodes.slice(1).map((n) => n.id);
    for (let b = 0; b < lanes; b++) {
      const handle = handles[b];
      const len = Math.floor(rand() * 3);
      let from = forkId;
      let first = true;
      for (let i = 0; i < len; i++) {
        const id = step(`b${b}_${i}`);
        add(from, id, first ? handle : undefined);
        first = false;
        placed.push(id);
        from = id;
      }
      if (first) add(from, "end", handle);
      else ending(from, placed);
    }
  }
  nodes.push(endNode);
  return { ...graph(nodes, []), edges };
}
