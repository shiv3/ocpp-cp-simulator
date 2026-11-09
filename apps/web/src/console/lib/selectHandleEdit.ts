import type {
  ScenarioDefinition,
  ScenarioNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { IndexMapping } from "../../components/scenario/forms/scenarioValue";

export type IndexedHandlePrefix = "case" | "option";

/** `<prefix>-<n>` as the executor writes it (no leading zero), or null. */
function handleIndex(
  handle: unknown,
  prefix: IndexedHandlePrefix,
): number | null {
  if (typeof handle !== "string") return null;
  const match = new RegExp(`^${prefix}-(0|[1-9][0-9]*)$`).exec(handle);
  return match ? Number(match[1]) : null;
}

/** The ids of the edges out of `nodeId` whose `<prefix>-<n>` item the edit
 *  removes (`mapping[n] === null`): the lanes that would lose their way in. */
export function edgesRemovedBy(
  def: Pick<ScenarioDefinition, "edges">,
  nodeId: string,
  prefix: IndexedHandlePrefix,
  mapping: IndexMapping,
): string[] {
  return def.edges
    .filter((edge) => {
      if (edge.source !== nodeId) return false;
      const index = handleIndex(edge.sourceHandle, prefix);
      return (
        index !== null && index < mapping.length && mapping[index] === null
      );
    })
    .map((edge) => edge.id);
}

/**
 * Stores `data` on `nodeId` and moves its `<prefix>-<n>` edges with their
 * items (`mapping`: old index → new index, `null`: removed). An edge on a
 * removed item is removed; every other edge keeps its id, its place in the
 * list and every field but the rewritten `sourceHandle`. Edges on other
 * handles (`default`, none) or on an index past the old list (a handle the
 * step could never pick) are left as they are: the edit changes nothing
 * the user did not touch.
 */
export function applySelectHandleEdit(
  def: ScenarioDefinition,
  nodeId: string,
  data: ScenarioNodeData,
  prefix: IndexedHandlePrefix,
  mapping: IndexMapping,
): ScenarioDefinition {
  const nodes = def.nodes.map((n) => (n.id === nodeId ? { ...n, data } : n));
  const edges = def.edges.flatMap((edge) => {
    if (edge.source !== nodeId) return [edge];
    const index = handleIndex(edge.sourceHandle, prefix);
    if (index === null || index >= mapping.length) return [edge];
    const next = mapping[index];
    if (next === null || next === undefined) return [];
    return next === index
      ? [edge]
      : [{ ...edge, sourceHandle: `${prefix}-${next}` }];
  });
  return { ...def, nodes, edges, updatedAt: new Date().toISOString() };
}

/** A switch's cases edited as a list: `nextCases` stored, `case-<n>` edges
 *  moved with their cases. */
export function applySwitchCaseEdit(
  def: ScenarioDefinition,
  nodeId: string,
  nextCases: unknown[],
  mapping: IndexMapping,
): ScenarioDefinition {
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) return def;
  return applySelectHandleEdit(
    def,
    nodeId,
    { ...node.data, cases: nextCases } as ScenarioNodeData,
    "case",
    mapping,
  );
}

/** A choice's options edited as a list: `nextOptions` stored, `option-<n>`
 *  edges moved with their options. */
export function applyChoiceOptionEdit(
  def: ScenarioDefinition,
  nodeId: string,
  nextOptions: Array<{ weight?: number; label?: string }>,
  mapping: IndexMapping,
): ScenarioDefinition {
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) return def;
  return applySelectHandleEdit(
    def,
    nodeId,
    { ...node.data, options: nextOptions } as ScenarioNodeData,
    "option",
    mapping,
  );
}
