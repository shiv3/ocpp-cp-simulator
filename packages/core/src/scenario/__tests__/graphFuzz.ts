/**
 * Seeded random scenario graphs for the equivalence tests of the lowered
 * program (`scenarioGraph.ts`): the validator's diagnostics and the
 * executor's traces over these graphs were recorded before the validator and
 * the executor moved onto it, and must not change.
 *
 * The graphs are deliberately messy: dangling edges, edges out of END and
 * into START, nodes only *labelled* Start / End, several STARTs, unknown node
 * types, switch / choice edges with and without the handle they pick, loops.
 * Changing anything here changes the recorded corpus: re-record both
 * baselines from the code *before* a behaviour change, never after.
 */

/** mulberry32: small, fast and the same on every platform. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FuzzNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface FuzzEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export interface FuzzGraph {
  nodes: FuzzNode[];
  edges: FuzzEdge[];
}

export interface FuzzOptions {
  /** Node types to draw from (besides start / end, which are always in). */
  types: readonly string[];
  /** Data for a node of `type`, drawn with `rand`. */
  dataFor: (type: string, rand: () => number) => Record<string, unknown>;
  /** Allow two nodes with the same id. */
  duplicateIds?: boolean;
}

const HANDLES = [
  undefined,
  null,
  "case-0",
  "case-1",
  "default",
  "option-0",
  "option-1",
];

const pick = <T>(rand: () => number, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)]!;

/** One messy graph of 2–8 nodes and up to twice as many edges. */
export function fuzzGraph(rand: () => number, opts: FuzzOptions): FuzzGraph {
  const count = 2 + Math.floor(rand() * 7);
  const nodes: FuzzNode[] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rand();
    // Mostly one START first, sometimes none, sometimes a second one later.
    const type =
      (i === 0 && roll < 0.8) || (i > 0 && roll < 0.06)
        ? "start"
        : roll < 0.18
          ? "end"
          : pick(rand, opts.types);
    const data: Record<string, unknown> = {
      ...opts.dataFor(type, rand),
      label: `n${i}`,
    };
    const labelRoll = rand();
    if (labelRoll < 0.07) data.label = "Start";
    else if (labelRoll < 0.14) data.label = "End";
    const id =
      opts.duplicateIds && i > 0 && rand() < 0.15
        ? nodes[Math.floor(rand() * i)]!.id
        : `n${i}`;
    nodes.push({ id, type, position: { x: 0, y: i * 100 }, data });
  }
  const ids = nodes.map((n) => n.id);
  const edgeCount = Math.floor(rand() * (count * 2 + 1));
  const edges: FuzzEdge[] = [];
  for (let i = 0; i < edgeCount; i += 1) {
    const source = rand() < 0.04 ? "ghost-src" : pick(rand, ids);
    const target = rand() < 0.08 ? "ghost" : pick(rand, ids);
    const handle = pick(rand, HANDLES);
    edges.push({
      id: `e${i}`,
      source,
      target,
      ...(handle === undefined ? {} : { sourceHandle: handle }),
    });
  }
  return { nodes, edges };
}

/** `count` graphs from one seed. */
export function fuzzGraphs(
  count: number,
  seed: number,
  opts: FuzzOptions,
): FuzzGraph[] {
  const rand = seededRandom(seed);
  return Array.from({ length: count }, () => fuzzGraph(rand, opts));
}
