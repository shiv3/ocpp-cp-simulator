/**
 * The run views' layout as `deriveStepLayout` computed it before the block
 * tree (a walk over the raw edges), kept verbatim as the oracle the adapter
 * is compared with. Branch names are left out (`String(index)`): they are a
 * function of the same first step and index.
 */
import type { Edge } from "@xyflow/react";

import {
  type ScenarioDefinition,
  type ScenarioNode,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

import type { StepBranch, StepLayout, StepLink } from "../stepLayout";

const UNSUPPORTED: StepLayout = {
  supported: false,
  main: [],
  fork: null,
  links: [],
};

const linkOf = (edge: Edge): StepLink => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
});

export function legacyDeriveStepLayout(
  def: Pick<ScenarioDefinition, "nodes" | "edges">,
): StepLayout {
  const outgoing = new Map<string, Edge[]>();
  for (const edge of def.edges) {
    const list = outgoing.get(edge.source);
    if (list) list.push(edge);
    else outgoing.set(edge.source, [edge]);
  }

  const start = def.nodes.find((n) => n.type === ScenarioNodeType.START);
  if (!start) return { ...UNSUPPORTED };

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
    if (!target || target.id === start.id) return { ...UNSUPPORTED };
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
      if (visited.has(target.id) && steps.length === 0)
        return { ...UNSUPPORTED };
      visited.add(target.id);
      steps.push(target);
      edgeInto[target.id] = into.id;
      const out: Edge[] = outgoing.get(target.id) ?? [];
      if (out.length > 1) return { ...UNSUPPORTED }; // a second fork
      const next: ScenarioNode | undefined =
        out.length === 1 ? nodesById.get(out[0].target) : undefined;
      if (next && next.type !== ScenarioNodeType.END && visited.has(next.id)) {
        // A join of two branches, or a loop back: a link, the lane ends.
        if (next.id === start.id) return { ...UNSUPPORTED };
        links.push(linkOf(out[0]));
        break;
      }
      if (out.length === 1) into = out[0];
      target = next;
    }
    if (target?.type === ScenarioNodeType.END) branchEnd = into.id;
    branches.push({
      name: String(index),
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
  if (orphan) return { ...UNSUPPORTED };

  return {
    supported: true,
    main,
    fork: forkEdges ? { branches } : null,
    links,
    edgeInto,
    ...(endEdgeId ? { endEdgeId } : {}),
  };
}
