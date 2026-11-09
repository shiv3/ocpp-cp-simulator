import type {
  ScenarioDefinition,
  ScenarioNode,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { ScenarioNodeType } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

export interface OutlineStep {
  /** 1-based position in the outline. */
  number: number;
  node: ScenarioNode;
  /**
   * Numbers of the steps this one leads to, only when that is not simply the
   * next line: a fork, a join, a loop back. `endsHere` is set when it leads to END.
   */
  jumps: number[];
  endsHere: boolean;
}

/**
 * A read-only, shape-agnostic outline of a scenario: its steps (START and END
 * left out) in depth-first order from START, each with where it jumps to when
 * that is not the next line. Unlike the card layout it never gives up, so it
 * also shows scenarios with loops, joins and several forks.
 */
export function outlineScenario(
  def: Pick<ScenarioDefinition, "nodes" | "edges">,
): OutlineStep[] {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const next = new Map<string, string[]>();
  for (const e of def.edges) {
    const list = next.get(e.source);
    if (list) list.push(e.target);
    else next.set(e.source, [e.target]);
  }

  const order: ScenarioNode[] = [];
  const numberOf = new Map<string, number>();
  const visit = (id: string) => {
    const node = byId.get(id);
    if (!node || numberOf.has(id)) return;
    if (
      node.type !== ScenarioNodeType.START &&
      node.type !== ScenarioNodeType.END
    ) {
      order.push(node);
      numberOf.set(id, order.length);
    } else {
      numberOf.set(id, 0);
    }
    for (const target of next.get(id) ?? []) visit(target);
  };
  for (const start of def.nodes.filter(
    (n) => n.type === ScenarioNodeType.START,
  )) {
    visit(start.id);
  }
  // Steps START never reaches still belong to the scenario.
  for (const n of def.nodes) visit(n.id);

  return order.map((node, index) => {
    const number = index + 1;
    const targets = next.get(node.id) ?? [];
    const endsHere = targets.some(
      (t) => byId.get(t)?.type === ScenarioNodeType.END,
    );
    const steps = targets.map((t) => numberOf.get(t) ?? 0).filter((n) => n > 0);
    const plain = steps.length === 1 && steps[0] === number + 1 && !endsHere;
    return { number, node, jumps: plain ? [] : steps, endsHere };
  });
}
