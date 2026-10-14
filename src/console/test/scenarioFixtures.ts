import type { Edge } from "@xyflow/react";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNode,
} from "../../cp/application/scenario/ScenarioTypes";

function node(
  id: string,
  type: ScenarioNodeType,
  label: string,
  data: Record<string, unknown> = {},
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label, ...data } as ScenarioNode["data"],
  };
}

/**
 * START → plug → status → (fork) ┬ charge → meter → END   ("Charge path")
 *                                └ wait                → END (Branch B)
 * Five steps: two in main (the fork node `status` last), then a branch of two
 * and a branch of one.
 */
export function forkScenario(
  overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
  const nodes = [
    node("start", ScenarioNodeType.START, "Start"),
    node("plug", ScenarioNodeType.CONNECTOR_PLUG, "Connector Plug", {
      action: "plugin",
    }),
    node("status", ScenarioNodeType.STATUS_CHANGE, "Status Change", {
      status: "Preparing",
    }),
    node("charge", ScenarioNodeType.TRANSACTION, "Charge path", {
      action: "start",
      tagId: "TAG1",
    }),
    node("meter", ScenarioNodeType.METER_VALUE, "Meter Value", {
      value: 100,
    }),
    node("wait", ScenarioNodeType.DELAY, "Delay", { delaySeconds: 5 }),
    node("end", ScenarioNodeType.END, "End"),
  ];
  const pairs: Array<[string, string]> = [
    ["start", "plug"],
    ["plug", "status"],
    ["status", "charge"],
    ["status", "wait"],
    ["charge", "meter"],
    ["meter", "end"],
    ["wait", "end"],
  ];
  const edges: Edge[] = pairs.map(([source, target]) => ({
    id: `${source}->${target}`,
    source,
    target,
  }));
  return {
    id: "s1",
    name: "Fork demo",
    targetType: "connector",
    targetId: 1,
    nodes,
    edges,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
