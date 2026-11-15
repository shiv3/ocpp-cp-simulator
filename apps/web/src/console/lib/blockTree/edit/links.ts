import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

import { editCapabilities } from "../capabilities";
import { commit } from "../rebuild";
import type { BlockTree } from "../types";
import { cloneTree, locate } from "./primitives";

/**
 * Makes the step `nodeId` (the last block of its sequence) jump to
 * `target`, a placed step other than START, or run to END with `null`.
 */
export function setLink(
  def: ScenarioDefinition,
  tree: BlockTree,
  nodeId: string,
  target: string | null,
): ScenarioDefinition {
  const caps = editCapabilities(tree, { kind: "node", nodeId });
  if (!caps.setLink.ok) return def;
  if (
    target !== null &&
    (target === tree.origin?.id || !tree.nodePath.has(target))
  ) {
    return def;
  }
  const t = cloneTree(tree);
  const { seq } = locate(t, nodeId)!;
  const current = seq.exit;
  const currentTarget =
    current.kind === "link"
      ? current.target
      : current.kind === "fallthrough"
        ? current.to
        : null;
  if (
    (current.kind === "end" && target === null) ||
    (current.kind !== "end" && target !== null && target === currentTarget)
  ) {
    return def; // Already there.
  }
  const edgeId = current.kind !== "stop" ? (current.edgeId ?? null) : null;
  seq.exit =
    target === null
      ? { kind: "end", edgeId }
      : { kind: "link", target, edgeId: edgeId ?? crypto.randomUUID() };
  return commit(def, t);
}
