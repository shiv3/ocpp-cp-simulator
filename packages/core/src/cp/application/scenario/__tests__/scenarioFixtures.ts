import {
  ScenarioDefinition,
  ScenarioNode,
  ScenarioNodeData,
  ScenarioNodeType,
} from "../ScenarioTypes";

/** A graph node at the origin — position is irrelevant to the executor. */
export function node(
  id: string,
  type: ScenarioNodeType,
  data: ScenarioNodeData,
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
  };
}

/** start → `middleNodes` in order → end, on connector 1. */
export function linearScenario(
  id: string,
  middleNodes: ScenarioNode[],
): ScenarioDefinition {
  const nodes = [
    node("start", ScenarioNodeType.START, { label: "Start" }),
    ...middleNodes,
    node("end", ScenarioNodeType.END, { label: "End" }),
  ];

  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    nodes,
    edges: nodes.slice(0, -1).map((source, index) => ({
      id: `e-${source.id}`,
      source: source.id,
      target: nodes[index + 1]!.id,
    })),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  };
}
