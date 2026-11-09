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
import i18n from "../../i18n";
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
   *  (`case-<n>`, `default`) or `choice` (`option-<n>`) runs (schema 1.6). */
  handle?: string;
  steps: ScenarioNode[];
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

export function deriveStepLayout(
  def: Pick<ScenarioDefinition, "nodes" | "edges">,
): StepLayout {
  const outgoing = new Map<string, Edge[]>();
  for (const edge of def.edges) {
    const list = outgoing.get(edge.source);
    if (list) list.push(edge);
    else outgoing.set(edge.source, [edge]);
  }

  // An edge picked by its handle (a switch or choice, schema 1.6) means
  // something the lanes cannot say: rebuilding the edges would drop the
  // handle and change which branch runs. Keep such a scenario as it is.
  if (def.edges.some((edge) => edge.sourceHandle != null)) return UNSUPPORTED;

  const start = def.nodes.find((n) => n.type === ScenarioNodeType.START);
  if (!start) return UNSUPPORTED;

  const nodesById = new Map(def.nodes.map((n) => [n.id, n]));
  const visited = new Set<string>([start.id]);
  const main: ScenarioNode[] = [];
  const links: StepLink[] = [];
  let current = start;
  let forkEdges: Edge[] | null = null;

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
    if (target.type === ScenarioNodeType.END) break;
    if (visited.has(target.id)) {
      // A loop back into the chain: the chain ends here, drawn as a link.
      links.push(linkOf(out[0]));
      break;
    }
    visited.add(target.id);
    main.push(target);
    current = target;
  }

  const branches: StepBranch[] = [];
  for (const [index, edge] of (forkEdges ?? []).entries()) {
    const steps: ScenarioNode[] = [];
    let target = nodesById.get(edge.target);
    // A branch ends at END, at a node with no outgoing edge, or at a dangling
    // edge (the executor just stops that branch there).
    while (target && target.type !== ScenarioNodeType.END) {
      // The branch's first step is already placed: not an editable lane.
      if (visited.has(target.id) && steps.length === 0) return UNSUPPORTED;
      visited.add(target.id);
      steps.push(target);
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
      target = next;
    }
    branches.push({
      name: branchName(steps[0], index),
      ...(edge.sourceHandle ? { handle: edge.sourceHandle } : {}),
      steps,
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
  };
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
