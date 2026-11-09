import type { Edge } from "@xyflow/react";

import {
  NODE_FORM_REGISTRY,
  isScenarioNodeType,
} from "../../components/scenario/forms/nodeFormRegistry";
import {
  type ScenarioDefinition,
  type ScenarioNode,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { isLoopEdge } from "@ocpp-cp-simulator/core/scenario/scenarioGraph";
import i18n from "../../i18n";
import { recognizeBlockTree } from "./blockTree";
import { isLiveRunState } from "./scenarioRunState";
import { createDefaultNode } from "./scenarioSteps";

/** An edge that jumps back to (or joins) a step already drawn: a loop or a
 *  join. It leaves the last step of its lane, which ends there. */
export interface StepLink {
  id: string;
  source: string;
  target: string;
}

export interface StepBranch {
  name: string;
  /** `sourceHandle` of the fork edge into this branch: the lane a `switch`
   *  (`case-<n>`, `default`) or `choice` (`option-<n>`) runs (schema 1.6).
   *  `null` when that edge has none: the editor keeps it without one. */
  handle: string | null;
  steps: ScenarioNode[];
  /** The fork edge into this branch. */
  edgeId?: string;
  /** The edge from the branch's last step (the fork node for an empty
   *  branch: the fork edge) into END, when there is one. */
  endEdgeId?: string;
}

/**
 * The shape the run views (Steps and Graph) can draw: a chain, optionally
 * ending in one fork whose branches each run to their end, plus `links` for
 * loops and joins. Anything else (a second fork, a node no walk reaches) is
 * `supported: false`, and the caller falls back to a flat outline.
 */
export interface StepLayout {
  supported: boolean;
  /** START (excluded) → … → the fork node inclusive, or to the end. The fork
   *  node runs before its branches: the executor starts every outgoing edge
   *  at once after it. */
  main: ScenarioNode[];
  fork: null | { branches: StepBranch[] };
  /** Loops and joins; see `StepLink`. */
  links: StepLink[];
  /** The edge each step is drawn entered by (the previous step's, START's
   *  or the fork's edge), by step id. */
  edgeInto?: Readonly<Record<string, string>>;
  /** Without a fork: the edge from the chain's last step (or START) into
   *  END, when there is one. */
  endEdgeId?: string;
}

const UNSUPPORTED: StepLayout = {
  supported: false,
  main: [],
  fork: null,
  links: [],
};

const defaultLabels = new Map<string, Set<string>>();

/** The labels a node of `type` gets without the author naming it: the
 *  registry title and `createDefaultNode`'s label (they differ, e.g. "Status
 *  Trigger" vs "Wait for Status"). */
function isDefaultLabel(type: string | undefined, label: string): boolean {
  if (!type || !isScenarioNodeType(type)) return false;
  let labels = defaultLabels.get(type);
  if (!labels) {
    labels = new Set([
      i18n.getFixedT("en")(NODE_FORM_REGISTRY[type].title),
      String(createDefaultNode(type).data.label ?? ""),
    ]);
    defaultLabels.set(type, labels);
  }
  return labels.has(label);
}

function branchName(first: ScenarioNode | undefined, index: number): string {
  const label = String(first?.data.label ?? "").trim();
  if (first && label !== "" && !isDefaultLabel(first.type, label)) {
    return label;
  }
  return `Branch ${String.fromCharCode(65 + (index % 26))}`;
}

/**
 * The run views' layout, projected from the block tree
 * (`recognizeBlockTree`): supported when the tree is a chain plus at most
 * one fork (and links), with nothing detached. The projection walks the
 * edges the tree structures (drawn edges and links), never an edge the tree
 * keeps aside: a step that ends its branch but has edges (a legacy "End"
 * label) is unsupported. The result is the layout the views have always
 * read.
 */
export function deriveStepLayout(
  def: Pick<ScenarioDefinition, "nodes" | "edges">,
): StepLayout {
  // A loop edge (schema 1.10) is not an edge of the chain or the fork,
  // structured or not: this layout cannot show its bounds.
  if (def.edges.some(isLoopEdge)) return UNSUPPORTED;
  const tree = recognizeBlockTree(def);
  const start = tree.origin;
  if (!start || start.type !== ScenarioNodeType.START) return UNSUPPORTED;
  if (tree.detached.length > 0) return UNSUPPORTED;
  const structural = new Set<string>(tree.drawnEdges.keys());
  const placed = new Set<string>([start.id, ...tree.nodePath.keys()]);
  for (const link of tree.links) {
    if (link.role === "outOfEnd") {
      // Out of END: never walked. Out of a placed step that ends its
      // branch: the old layout walked on along it; not projectable.
      if (placed.has(link.edge.source)) return UNSUPPORTED;
    } else structural.add(link.edge.id);
  }
  const outgoing = new Map<string, Edge[]>();
  for (const edge of def.edges) {
    if (!structural.has(edge.id)) continue;
    const list = outgoing.get(edge.source);
    if (list) list.push(edge);
    else outgoing.set(edge.source, [edge]);
  }

  const nodesById = new Map(def.nodes.map((n) => [n.id, n]));
  const visited = new Set<string>([start.id]);
  const main: ScenarioNode[] = [];
  const links: StepLink[] = [];
  let current = start;
  let forkEdges: Edge[] | null = null;
  const edgeInto: Record<string, string> = {};
  let endEdgeId: string | undefined;

  for (;;) {
    const out = outgoing.get(current.id) ?? [];
    if (out.length === 0) break;
    if (out.length > 1) {
      forkEdges = out;
      break;
    }
    const target = nodesById.get(out[0].target);
    // A dangling edge, or an edge back into START.
    if (!target || target.id === start.id) return UNSUPPORTED;
    if (target.type === ScenarioNodeType.END) {
      endEdgeId = out[0].id;
      break;
    }
    if (visited.has(target.id)) {
      // A loop back into the chain: the chain ends here, drawn as a link.
      links.push(linkOf(out[0]));
      break;
    }
    visited.add(target.id);
    edgeInto[target.id] = out[0].id;
    main.push(target);
    current = target;
  }

  const branches: StepBranch[] = [];
  for (const [index, edge] of (forkEdges ?? []).entries()) {
    const steps: ScenarioNode[] = [];
    let target = nodesById.get(edge.target);
    let into: Edge = edge;
    let branchEnd: string | undefined;
    // A branch ends at END, at a node with no outgoing edge, or at a dangling
    // edge (the executor just stops that branch there).
    while (target && target.type !== ScenarioNodeType.END) {
      // The branch's first step is already placed: not an editable lane.
      if (visited.has(target.id) && steps.length === 0) return UNSUPPORTED;
      visited.add(target.id);
      steps.push(target);
      edgeInto[target.id] = into.id;
      const out: Edge[] = outgoing.get(target.id) ?? [];
      if (out.length > 1) return UNSUPPORTED; // a second fork
      const next: ScenarioNode | undefined =
        out.length === 1 ? nodesById.get(out[0].target) : undefined;
      if (next && next.type !== ScenarioNodeType.END && visited.has(next.id)) {
        // A join of two branches, or a loop back: a link, the lane ends.
        if (next.id === start.id) return UNSUPPORTED;
        links.push(linkOf(out[0]));
        break;
      }
      if (out.length === 1) into = out[0];
      target = next;
    }
    if (target?.type === ScenarioNodeType.END) branchEnd = into.id;
    branches.push({
      name: branchName(steps[0], index),
      handle: typeof edge.sourceHandle === "string" ? edge.sourceHandle : null,
      steps,
      edgeId: edge.id,
      ...(branchEnd ? { endEdgeId: branchEnd } : {}),
    });
  }

  // A step no walk reaches (END may stand alone: nothing leads there).
  const orphan = def.nodes.some(
    (n) => n.type !== ScenarioNodeType.END && !visited.has(n.id),
  );
  if (orphan) return UNSUPPORTED;

  return {
    supported: true,
    main,
    fork: forkEdges ? { branches } : null,
    links,
    edgeInto,
    ...(endEdgeId ? { endEdgeId } : {}),
  };
}

/** The ids of the edges the Graph view draws: into every step, into END,
 *  and the loop / join links. */
export function drawnEdgeIds(layout: StepLayout): Set<string> {
  const ids = new Set<string>(Object.values(layout.edgeInto ?? {}));
  if (layout.endEdgeId) ids.add(layout.endEdgeId);
  // A branch's fork edge is drawn as the edge into its first step (in
  // `edgeInto`) or, for an empty branch, as its edge to END (`endEdgeId`);
  // a fork edge to a missing node is not drawn at all.
  for (const branch of layout.fork?.branches ?? []) {
    if (branch.endEdgeId) ids.add(branch.endEdgeId);
  }
  for (const link of layout.links) ids.add(link.id);
  return ids;
}

const linkOf = (edge: Edge): StepLink => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
});

/** Every step of the layout in display order: main, then each branch. */
export function layoutSteps(layout: StepLayout): ScenarioNode[] {
  return [
    ...layout.main,
    ...(layout.fork?.branches.flatMap((branch) => branch.steps) ?? []),
  ];
}

/** The 1-based number a step's box shows (main first, then the branches in
 *  order), or null when the node is not a step of the layout. */
export function stepIndexOf(layout: StepLayout, nodeId: string): number | null {
  const index = layoutSteps(layout).findIndex((n) => n.id === nodeId);
  return index === -1 ? null : index + 1;
}

export type StepPhase = "done" | "current" | "todo";

/**
 * Where a step stands in a run. There is no node-complete event, so a step
 * is "done" once a later node-execute supersedes it as the current node, or
 * the run leaves the live states — then the last current node settles too.
 */
export function stepPhase(
  nodeId: string,
  currentNodeId: string | null,
  executedNodeIds: readonly string[],
  state: string,
): StepPhase {
  if (!executedNodeIds.includes(nodeId)) return "todo";
  if (nodeId === currentNodeId && isLiveRunState(state)) return "current";
  return "done";
}
