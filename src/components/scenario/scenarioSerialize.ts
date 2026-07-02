import type { Edge } from "@xyflow/react";
import type {
  ScenarioDefinition,
  ScenarioNode,
} from "../../cp/application/scenario/ScenarioTypes";

const RUNTIME_NODE_DATA_KEYS = new Set([
  "progress",
  "currentValue",
  "style",
  "className",
]);

const RUNTIME_EDGE_KEYS = new Set([
  "selected",
  "style",
  "className",
  "interactionWidth",
  "ariaLabel",
  "domAttributes",
]);

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, deepClone(child)]),
    ) as T;
  }

  return value;
}

type SerializableNode = {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: object;
};

function serializeNodeData(
  data: SerializableNode["data"],
): ScenarioNode["data"] {
  return Object.fromEntries(
    Object.entries(data).flatMap(([key, value]) =>
      RUNTIME_NODE_DATA_KEYS.has(key) ? [] : [[key, deepClone(value)]],
    ),
  ) as unknown as ScenarioNode["data"];
}

function serializeNode(node: SerializableNode): ScenarioNode {
  return {
    id: node.id,
    type: node.type,
    position: deepClone(node.position),
    data: serializeNodeData(node.data),
  } as ScenarioNode;
}

function serializeEdge(edge: Edge): Edge {
  return Object.fromEntries(
    Object.entries(edge).flatMap(([key, value]) =>
      RUNTIME_EDGE_KEYS.has(key) ? [] : [[key, deepClone(value)]],
    ),
  ) as Edge;
}

export function serializeScenarioGraph(
  nodes: readonly SerializableNode[],
  edges: readonly Edge[],
): Pick<ScenarioDefinition, "nodes" | "edges"> {
  return {
    nodes: nodes.map(serializeNode),
    edges: edges.map(serializeEdge),
  };
}

export function deserializeScenarioGraph(
  nodes: readonly ScenarioNode[],
  edges: readonly Edge[],
): Pick<ScenarioDefinition, "nodes" | "edges"> {
  return {
    nodes: nodes.map((node) => deepClone(node)),
    edges: edges.map((edge) => deepClone(edge)),
  };
}
