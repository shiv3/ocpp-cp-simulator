/**
 * Which nodes a scenario graph may connect, and how many edges each node type
 * may have. The edge type itself (`id` / `source` / `target`) says nothing:
 * these rules are what `ScenarioExecutor` actually honours.
 *
 * - Only START runs several outgoing edges in parallel (`executeParallelBranches`).
 *   From any other node the executor follows the first edge that points at an
 *   existing node and ignores the rest, so `maxOut` of every other type is 1.
 * - START is where a run begins: nothing leads into it. END stops a branch:
 *   nothing leaves it.
 * - Loops (an edge back to an earlier node) are allowed on purpose; Stop ends
 *   an endless one. Joins (several edges into one node) are allowed too.
 *
 * Advisory like the JSON schema: callers report the issues and keep loading
 * the scenario.
 */
import { ScenarioNodeType } from "../cp/application/scenario/ScenarioTypes";

export interface ConnectionRule {
  /** Most edges that may lead into a node of this type. */
  maxIn: number;
  /** Most edges that may leave a node of this type (they all run only for START). */
  maxOut: number;
}

const DEFAULT_RULE: ConnectionRule = { maxIn: Infinity, maxOut: 1 };

/** Types that differ from {@link DEFAULT_RULE}. */
const RULES: Partial<Record<ScenarioNodeType, ConnectionRule>> = {
  [ScenarioNodeType.START]: { maxIn: 0, maxOut: Infinity },
  [ScenarioNodeType.END]: { maxIn: Infinity, maxOut: 0 },
};

export function connectionRule(type: string | undefined): ConnectionRule {
  return RULES[type as ScenarioNodeType] ?? DEFAULT_RULE;
}

export type GraphIssueCode =
  /** No START node: the executor throws "No start node found". */
  | "missingStart"
  /** More than one START: only the first is run. */
  | "multipleStart"
  /** An edge points at START. */
  | "edgeIntoStart"
  /** An edge leaves END: it is never followed. */
  | "edgeOutOfEnd"
  /** A node other than START has several outgoing edges: only the first runs. */
  | "extraOutgoing"
  /** An edge's source or target is not a node of the scenario. */
  | "danglingEdge"
  /** No path from START reaches the node: it never runs. */
  | "unreachable";

export interface GraphIssue {
  code: GraphIssueCode;
  /** The node the issue is about (all codes but `missingStart` / `danglingEdge`). */
  nodeId?: string;
  edgeId?: string;
  /** `error`: the scenario cannot run as drawn; `warning`: part of it is ignored. */
  severity: "error" | "warning";
}

interface GraphNodeLike {
  id: string;
  type?: string;
}
interface GraphEdgeLike {
  id: string;
  source: string;
  target: string;
}

export function validateScenarioGraph(def: {
  nodes: readonly GraphNodeLike[];
  edges: readonly GraphEdgeLike[];
}): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const nodesById = new Map(def.nodes.map((n) => [n.id, n]));
  const starts = def.nodes.filter((n) => n.type === ScenarioNodeType.START);

  if (starts.length === 0) {
    issues.push({ code: "missingStart", severity: "error" });
  }
  for (const extra of starts.slice(1)) {
    issues.push({
      code: "multipleStart",
      nodeId: extra.id,
      severity: "warning",
    });
  }

  const outgoing = new Map<string, GraphEdgeLike[]>();
  for (const edge of def.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) {
      issues.push({
        code: "danglingEdge",
        edgeId: edge.id,
        severity: "warning",
      });
      continue;
    }
    if (connectionRule(target.type).maxIn === 0) {
      issues.push({
        code: "edgeIntoStart",
        nodeId: target.id,
        edgeId: edge.id,
        severity: "warning",
      });
    }
    if (connectionRule(source.type).maxOut === 0) {
      issues.push({
        code: "edgeOutOfEnd",
        nodeId: source.id,
        edgeId: edge.id,
        severity: "warning",
      });
      continue; // never followed: not part of the graph that runs
    }
    const list = outgoing.get(source.id);
    if (list) list.push(edge);
    else outgoing.set(source.id, [edge]);
  }

  for (const [nodeId, edges] of outgoing) {
    const max = connectionRule(nodesById.get(nodeId)?.type).maxOut;
    if (edges.length > max) {
      issues.push({ code: "extraOutgoing", nodeId, severity: "warning" });
    }
  }

  // Reachability from START (every outgoing edge counts: an ignored branch
  // is reported by `extraOutgoing`, not twice here).
  if (starts.length > 0) {
    const seen = new Set<string>(starts.map((s) => s.id));
    const queue = [...seen];
    while (queue.length > 0) {
      const id = queue.pop()!;
      for (const edge of outgoing.get(id) ?? []) {
        if (!seen.has(edge.target) && nodesById.has(edge.target)) {
          seen.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    for (const node of def.nodes) {
      if (!seen.has(node.id) && node.type !== ScenarioNodeType.END) {
        issues.push({
          code: "unreachable",
          nodeId: node.id,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}
