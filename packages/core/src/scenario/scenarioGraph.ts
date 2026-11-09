/**
 * The scenario graph as the executor walks it: where a run starts, where a
 * branch ends, and which edge it takes next. `ScenarioExecutor` and
 * `validateScenarioGraph` both read the graph through these functions, so the
 * validator cannot drift from what actually runs.
 *
 * {@link lowerScenario} bundles a definition into a {@link ScenarioProgram}:
 * an in-memory index, never persisted and never part of the file format. It
 * changes nothing about how a scenario runs; it only states it once. The
 * executor is deliberately tolerant (see "Tolerant contract" in
 * docs/concepts/scenario-format.md): an unknown node type is a plain step,
 * an edge to a missing node is skipped, an edge out of END is never
 * followed, an edge back into START runs it again as a step, a second START
 * starts nothing (it runs as a step only if an edge reaches it), a switch /
 * choice edge whose handle the node never picks is never followed, and nodes *labelled* "Start" / "End" act as such. Lowering
 * reports those as diagnostics and never rejects the graph.
 *
 * Schema 1.8: an edge with `kind: "timeout"` ({@link isTimeoutEdge}) is kept
 * apart from the ordinary edges. {@link nextStep}, {@link successors} and the
 * origin's fan-out never see it; only {@link timeoutStep} follows one, out of
 * a trigger wait whose timeout expired.
 */
import { ScenarioNodeType } from "../cp/application/scenario/ScenarioTypes";
import {
  connectionRule,
  type GraphIssue,
  type GraphIssueCode,
} from "./scenarioConnectionRules";

export interface GraphNodeLike {
  id: string;
  type?: string;
  data?: unknown;
}

export interface GraphEdgeLike {
  id: string;
  source: string;
  target: string;
  /** The handle a `switch` / `choice` picks (`case-N`, `default`, `option-N`). */
  sourceHandle?: string | null;
  /** `"timeout"` (schema 1.8): followed only when the source wait times out.
   *  Absent, or any other value: an ordinary edge. */
  kind?: unknown;
}

/** An edge taken only when its source wait times out (schema 1.8). */
export const isTimeoutEdge = (edge: GraphEdgeLike): boolean =>
  edge.kind === "timeout";

export interface GraphLike<
  N extends GraphNodeLike = GraphNodeLike,
  E extends GraphEdgeLike = GraphEdgeLike,
> {
  nodes: readonly N[];
  edges: readonly E[];
}

/** What lowering reports: the structure the executor ignores or cannot run. */
export type LoweringDiagnosticCode = Extract<
  GraphIssueCode,
  "missingStart" | "multipleStart" | "danglingEdge" | "edgeOutOfEnd"
>;

/** A lowering finding: a {@link GraphIssue} (so a `Diagnostic`) with one of
 *  the {@link LoweringDiagnosticCode}s. */
export type LoweringDiagnostic = GraphIssue & { code: LoweringDiagnosticCode };

export interface ScenarioProgram<
  N extends GraphNodeLike = GraphNodeLike,
  E extends GraphEdgeLike = GraphEdgeLike,
> {
  readonly nodes: readonly N[];
  readonly edges: readonly E[];
  /** By id; with duplicate ids the first node wins, as the executor's
   *  `nodes.find` does. */
  readonly nodesById: ReadonlyMap<string, N>;
  /** Every ordinary (not timeout) edge by source id, in file order, whether
   *  or not its target exists. */
  readonly edgesFrom: ReadonlyMap<string, readonly E[]>;
  /** By source id, in file order: the ordinary edges whose source and target
   *  both exist. Includes edges out of a terminal node (they are never
   *  followed; {@link successors} drops them). */
  readonly outgoing: ReadonlyMap<string, readonly E[]>;
  /** By source id, in file order: the timeout edges (schema 1.8) whose
   *  source and target both exist, out of any node. Only
   *  {@link timeoutStep} follows one. */
  readonly timeoutEdges: ReadonlyMap<string, readonly E[]>;
  /** Where a fresh run starts ({@link resolveOrigin}). */
  readonly origin: N | undefined;
  /** The origin first, then every other node of type `start`. Only the
   *  origin starts a run; another START runs as an ordinary step, and only
   *  when an edge reaches it. */
  readonly starts: readonly N[];
  readonly diagnostics: readonly LoweringDiagnostic[];
}

export const labelOf = (node: GraphNodeLike): unknown =>
  (node.data as { label?: unknown } | undefined)?.label;

/** A node a run may start from: type `start`, or (legacy) labelled "Start". */
export function isStartCandidate(node: GraphNodeLike): boolean {
  return node.type === ScenarioNodeType.START || labelOf(node) === "Start";
}

/**
 * Where a run starts (`executeFlow`): the first node, in file order, that is
 * of type `start` or labelled "Start". `undefined` when there is none; the
 * executor then throws "No start node found in scenario".
 */
export function resolveOrigin<N extends GraphNodeLike>(def: {
  nodes: readonly N[];
}): N | undefined {
  return def.nodes.find(isStartCandidate);
}

/** A node that ends its branch (`executeSequentialFlow`): type `end` or
 *  (legacy) labelled "End". Nothing after it runs. */
export function isTerminal(node: GraphNodeLike): boolean {
  return connectionRule(node.type).out === "none" || labelOf(node) === "End";
}

/** Index a scenario for the executor and the validator. Never throws. */
export function lowerScenario<N extends GraphNodeLike, E extends GraphEdgeLike>(
  def: GraphLike<N, E>,
): ScenarioProgram<N, E> {
  const diagnostics: LoweringDiagnostic[] = [];
  const nodesById = new Map<string, N>();
  for (const node of def.nodes) {
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  }
  const origin = resolveOrigin(def);
  const starts = def.nodes.filter(
    (n) => n === origin || n.type === ScenarioNodeType.START,
  );

  if (!origin) diagnostics.push({ code: "missingStart", severity: "error" });
  for (const extra of starts.slice(1)) {
    diagnostics.push({
      code: "multipleStart",
      nodeId: extra.id,
      severity: "warning",
    });
  }

  const edgesFrom = new Map<string, E[]>();
  const outgoing = new Map<string, E[]>();
  const timeoutEdges = new Map<string, E[]>();
  const add = (map: Map<string, E[]>, edge: E) => {
    const list = map.get(edge.source);
    if (list) list.push(edge);
    else map.set(edge.source, [edge]);
  };
  for (const edge of def.edges) {
    const timeout = isTimeoutEdge(edge);
    if (!timeout) add(edgesFrom, edge);
    const source = nodesById.get(edge.source);
    if (!source || !nodesById.has(edge.target)) {
      diagnostics.push({
        code: "danglingEdge",
        edgeId: edge.id,
        severity: "warning",
      });
      continue;
    }
    if (timeout) {
      // Reported by the validator (timeoutEdgeOnNonWait), not as edgeOutOfEnd.
      add(timeoutEdges, edge);
      continue;
    }
    // The origin's edges are run by executeFlow whatever the origin is.
    if (source !== origin && isTerminal(source)) {
      diagnostics.push({
        code: "edgeOutOfEnd",
        nodeId: source.id,
        edgeId: edge.id,
        severity: "warning",
      });
    }
    add(outgoing, edge);
  }

  return {
    nodes: def.nodes,
    edges: def.edges,
    nodesById,
    edgesFrom,
    outgoing,
    timeoutEdges,
    origin,
    starts,
    diagnostics,
  };
}

/**
 * What the executor does after a node ran in a branch
 * (`executeSequentialFlow`):
 * - `end`: the node is terminal, the branch ends;
 * - `noEdgeForHandle`: a switch / choice picked `handle` and no edge has it,
 *   the branch ends (logged);
 * - `noEdge`: the node has no outgoing edge, the branch ends;
 * - `missingTargets`: every candidate edge points at a missing node, the
 *   branch ends (warned);
 * - `edge`: the branch goes on to `target` along `edge`.
 */
export type NextStep<N, E> =
  | { kind: "end" }
  | { kind: "noEdgeForHandle"; handle: string }
  | { kind: "noEdge" }
  | { kind: "missingTargets" }
  | { kind: "edge"; edge: E; target: N };

/**
 * The step after `node` in a branch. `handle` is what a switch / choice just
 * picked (`null` for every other node): only the edges with that
 * `sourceHandle` are candidates. Of the candidates the first one whose target
 * exists is taken; the rest are ignored.
 */
export function nextStep<N extends GraphNodeLike, E extends GraphEdgeLike>(
  program: ScenarioProgram<N, E>,
  node: N,
  handle: string | null,
): NextStep<N, E> {
  if (isTerminal(node)) return { kind: "end" };
  let candidates = program.edgesFrom.get(node.id) ?? [];
  if (handle !== null) {
    candidates = candidates.filter((e) => e.sourceHandle === handle);
    if (candidates.length === 0) return { kind: "noEdgeForHandle", handle };
  }
  if (candidates.length === 0) return { kind: "noEdge" };
  for (const edge of candidates) {
    const target = program.nodesById.get(edge.target);
    if (target) return { kind: "edge", edge, target };
  }
  return { kind: "missingTargets" };
}

/**
 * How long a trigger wait parks before it expires, as the executor reads
 * `data.timeout` (`runTriggerWait`): seconds above 0, or 0 when it waits
 * forever (0, absent, negative or not a number). `null` for a node that is
 * not a trigger wait (its rule has no `waits`).
 */
export function waitTimeoutSeconds(node: GraphNodeLike): number | null {
  if (!connectionRule(node.type).waits) return null;
  const timeout = (node.data as { timeout?: unknown } | undefined)?.timeout;
  const seconds = Math.max(0, (timeout as number) || 0);
  return Number.isNaN(seconds) ? 0 : seconds;
}

/**
 * Where a branch goes when `node`'s wait timed out (schema 1.8): along its
 * first timeout edge to an existing node. `null` when there is none, or when
 * the node is not a trigger wait or ends its branch; the run then fails with
 * the timeout, as it always did. Called by the executor only once the wait
 * really expired, so it does not look at the timeout's length.
 */
export function timeoutStep<N extends GraphNodeLike, E extends GraphEdgeLike>(
  program: ScenarioProgram<N, E>,
  node: N,
): { edge: E; target: N } | null {
  if (!connectionRule(node.type).waits || isTerminal(node)) return null;
  const edge = program.timeoutEdges.get(node.id)?.[0];
  return edge ? { edge, target: program.nodesById.get(edge.target)! } : null;
}

export interface SuccessorOptions {
  /**
   * The node is where the run starts or resumes (`executeFlow`): every edge
   * to an existing node runs, each as its own branch, terminal or not.
   */
  asOrigin?: boolean;
  /**
   * What a switch / choice picked. Omitted on a switch / choice: every edge
   * it may take (for analysis). Omitted elsewhere: `null`.
   */
  handle?: string | null;
}

/**
 * The edges the executor follows out of `node`:
 * - as the origin (`asOrigin`): all of them, in parallel;
 * - from a terminal node: none;
 * - from a switch / choice with no `handle` given: for every handle it can
 *   pick ({@link pickableHandles}), the one edge {@link nextStep} takes;
 * - otherwise: the one edge {@link nextStep} takes, if any.
 */
export function successors<N extends GraphNodeLike, E extends GraphEdgeLike>(
  program: ScenarioProgram<N, E>,
  node: N,
  opts: SuccessorOptions = {},
): readonly E[] {
  if (opts.asOrigin) return program.outgoing.get(node.id) ?? [];
  if (opts.handle === undefined && connectionRule(node.type).out === "select") {
    if (isTerminal(node)) return [];
    const followed: E[] = [];
    for (const handle of pickableHandles(node) ?? []) {
      const step = nextStep(program, node, handle);
      if (step.kind === "edge") followed.push(step.edge);
    }
    return followed;
  }
  const step = nextStep(program, node, opts.handle ?? null);
  return step.kind === "edge" ? [step.edge] : [];
}

/**
 * The `sourceHandle`s a switch / choice can pick, derived from its data as
 * the executor does (`executeSwitch` / `executeChoice` always set
 * `flow.handle`, and `nextStep` then keeps only the edges with that handle):
 *
 * - `switch`: `case-0` … `case-<n-1>` for its `n` cases, then `default`;
 * - `choice`: `option-0` … `option-<n-1>` for its `n` options.
 *
 * Empty when the node fails the run before it picks (`cases` not an array;
 * fewer than two options, or a weight that is not a number above 0). A
 * switch case that is not a JSON constant also fails the run; that is left
 * to the schema. `null` for a node that does not pick a handle.
 */
export function pickableHandles(node: GraphNodeLike): readonly string[] | null {
  const data = node.data as Record<string, unknown> | undefined;
  if (node.type === ScenarioNodeType.SWITCH) {
    const cases = data?.cases;
    if (!Array.isArray(cases)) return [];
    return [...cases.map((_, i) => `case-${i}`), "default"];
  }
  if (node.type === ScenarioNodeType.CHOICE) {
    const options = data?.options;
    if (!Array.isArray(options) || options.length < 2) return [];
    const weighted = options.every((option: unknown) => {
      const weight =
        (option as { weight?: unknown } | null | undefined)?.weight ?? 1;
      return (
        typeof weight === "number" && Number.isFinite(weight) && weight > 0
      );
    });
    return weighted ? options.map((_, i) => `option-${i}`) : [];
  }
  return null;
}

export interface HandleEdges<E> {
  /** Per handle the node can pick, in {@link pickableHandles} order: its
   *  edges to existing nodes, in file order (the first one runs). A handle
   *  without an edge is absent: picking it ends the branch. */
  readonly pickable: ReadonlyMap<string, readonly E[]>;
  /** Edges to existing nodes whose handle the node never picks (none at
   *  all, `case-N` beyond the cases, `option-N` beyond the options, a
   *  handle of the other node type): never followed. */
  readonly unpickable: readonly E[];
}

/**
 * A switch / choice's edges to existing nodes, split by whether the node can
 * pick their `sourceHandle` ({@link pickableHandles}). For any other node
 * every edge is `unpickable`.
 */
export function edgesByHandle<N extends GraphNodeLike, E extends GraphEdgeLike>(
  program: ScenarioProgram<N, E>,
  node: N,
): HandleEdges<E> {
  const handles = pickableHandles(node) ?? [];
  const pickable = new Map<string, E[]>();
  const unpickable: E[] = [];
  for (const handle of handles) pickable.set(handle, []);
  for (const edge of program.outgoing.get(node.id) ?? []) {
    const list =
      typeof edge.sourceHandle === "string"
        ? pickable.get(edge.sourceHandle)
        : undefined;
    if (list) list.push(edge);
    else unpickable.push(edge);
  }
  for (const handle of handles) {
    if (pickable.get(handle)!.length === 0) pickable.delete(handle);
  }
  return { pickable, unpickable };
}
