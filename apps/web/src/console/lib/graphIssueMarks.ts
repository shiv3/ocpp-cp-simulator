import type {
  Diagnostic,
  DiagnosticSeverity,
} from "@ocpp-cp-simulator/core/scenario/diagnostic";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

/** One diagnostic as it shows on a mark. */
export interface IssueMarkEntry {
  /** The diagnostic's index in the list the warning box shows. */
  index: number;
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  /** Marked on the edge's source step: the view does not draw the edge. */
  viaEdge: boolean;
}

/** Everything marked on one step card or one drawn edge. */
export interface IssueMark {
  /** The most severe of `entries`. */
  severity: DiagnosticSeverity;
  entries: IssueMarkEntry[];
}

/** What one diagnostic marks in a view. */
export interface IssueTarget {
  nodeIds: string[];
  edgeIds: string[];
  /** The step its warning line selects (never START / END), or null. */
  stepId: string | null;
}

export interface IssueMarks {
  /** By node id; START and END only when the diagnostic is about them. */
  nodes: ReadonlyMap<string, IssueMark>;
  /** By edge id; only edges the view draws. */
  edges: ReadonlyMap<string, IssueMark>;
  /** By diagnostic index. */
  targets: readonly IssueTarget[];
  /** The marks on START / END (the Graph view's start dot and end rings). */
  start: IssueMark | null;
  end: IssueMark | null;
}

const RANK: Record<DiagnosticSeverity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

export function worstSeverity(
  severities: Iterable<DiagnosticSeverity>,
): DiagnosticSeverity {
  let worst: DiagnosticSeverity = "info";
  for (const s of severities) if (RANK[s] > RANK[worst]) worst = s;
  return worst;
}

const EMPTY: IssueMarks = {
  nodes: new Map(),
  edges: new Map(),
  targets: [],
  start: null,
  end: null,
};

/**
 * Where each diagnostic of `validateScenarioGraph` shows in a view: on the
 * node it names (`nodeId`), on the edge it names when the view draws that
 * edge (`drawnEdges`), and otherwise on the edge's source step as an "edge
 * issue" (an unpickable or dangling edge the view leaves out, an edge out of
 * END, a loop the Steps view draws as a block). START and END are marked
 * only by a diagnostic about them; one with neither (`missingStart`) marks
 * nothing and stays in the warning box only.
 */
export function issueMarks(
  issues: readonly Diagnostic[],
  def: Pick<ScenarioDefinition, "nodes" | "edges">,
  drawnEdges: ReadonlySet<string>,
  describe: (issue: Diagnostic) => string,
): IssueMarks {
  if (issues.length === 0) return EMPTY;
  const nodesById = new Map(def.nodes.map((n) => [n.id, n]));
  const edgesById = new Map(def.edges.map((e) => [e.id, e]));
  const isStep = (id: string | undefined): id is string => {
    const type = id === undefined ? undefined : nodesById.get(id)?.type;
    return (
      type !== undefined &&
      type !== ScenarioNodeType.START &&
      type !== ScenarioNodeType.END
    );
  };

  const nodes = new Map<string, IssueMarkEntry[]>();
  const edges = new Map<string, IssueMarkEntry[]>();
  const add = (
    map: Map<string, IssueMarkEntry[]>,
    id: string,
    entry: IssueMarkEntry,
  ) => {
    const list = map.get(id);
    if (list) list.push(entry);
    else map.set(id, [entry]);
  };

  const targets = issues.map((issue, index): IssueTarget => {
    const entry = (viaEdge: boolean): IssueMarkEntry => ({
      index,
      code: issue.code,
      severity: issue.severity,
      message: describe(issue),
      viaEdge,
    });
    const target: IssueTarget = { nodeIds: [], edgeIds: [], stepId: null };
    if (issue.nodeId !== undefined && nodesById.has(issue.nodeId)) {
      add(nodes, issue.nodeId, entry(false));
      target.nodeIds.push(issue.nodeId);
    }
    const edge =
      issue.edgeId !== undefined ? edgesById.get(issue.edgeId) : undefined;
    if (edge && drawnEdges.has(edge.id)) {
      add(edges, edge.id, entry(false));
      target.edgeIds.push(edge.id);
    } else if (
      edge &&
      edge.source !== issue.nodeId &&
      nodesById.has(edge.source)
    ) {
      // An edge the view does not draw marks the node it leaves: a step, or
      // START / END (their marks sit by the start dot and the end ring).
      add(nodes, edge.source, entry(true));
      target.nodeIds.push(edge.source);
    }
    target.stepId =
      target.nodeIds.find(isStep) ??
      (edge && isStep(edge.source) ? edge.source : null);
    return target;
  });

  const toMark = (entries: IssueMarkEntry[]): IssueMark => ({
    severity: worstSeverity(entries.map((e) => e.severity)),
    entries,
  });
  const nodeMarks = new Map(
    [...nodes].map(([id, entries]) => [id, toMark(entries)]),
  );
  const marksOfType = (type: ScenarioNodeType) => {
    const entries = def.nodes
      .filter((n) => n.type === type)
      .flatMap((n) => nodes.get(n.id) ?? []);
    return entries.length > 0 ? toMark(entries) : null;
  };
  return {
    nodes: nodeMarks,
    edges: new Map([...edges].map(([id, entries]) => [id, toMark(entries)])),
    targets,
    start: marksOfType(ScenarioNodeType.START),
    end: marksOfType(ScenarioNodeType.END),
  };
}

/** What a hovered or focused warning line highlights in a view. */
export function highlightedBy(
  marks: IssueMarks | undefined,
  index: number | null | undefined,
): IssueTarget | null {
  if (!marks || index === null || index === undefined) return null;
  return marks.targets[index] ?? null;
}
