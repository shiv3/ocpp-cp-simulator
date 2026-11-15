import type { MessageKey } from "../../../../i18n";
import {
  type AnyScenarioNodeType,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { isTerminal } from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

import { createDefaultNode } from "../../scenarioSteps";
import {
  canInsertAt,
  canMove,
  canWrapInLoop,
  editCapabilities,
  no,
  OK,
  type Capability,
} from "../capabilities";
import { recognizeBlockTree } from "../recognize";
import { boundedLoopProblem, commit } from "../rebuild";
import type { BlockTree, Seq, SeqPath } from "../types";
import {
  applyMoveStep,
  applyRemoveStep,
  applyWrapInLoop,
  removeStepBlockAt,
  repath,
} from "./applies";
import { canInsertLoopAt } from "./loops";
import { cloneTree, insertBlockAt, locate, seqAt } from "./primitives";

/** Inserts a new step of `type` at slot `index` of the sequence at `path`. */
export function insertStep(
  def: ScenarioDefinition,
  tree: BlockTree,
  path: SeqPath,
  index: number,
  type: AnyScenarioNodeType,
): ScenarioDefinition {
  if (!canInsertAt(tree, path, index).ok) return def;
  const t = cloneTree(tree);
  const seq = seqAt(t, path)!;
  insertBlockAt(t, seq, index, {
    kind: "step",
    node: createDefaultNode(type),
    edgeIn: null,
  });
  return commit(def, t);
}

/** Removes the step `nodeId`. A fork node with two or more lanes and the
 *  origin cannot be removed; a fork with one lane folds into its parent. */
export function removeStep(
  def: ScenarioDefinition,
  tree: BlockTree,
  nodeId: string,
): ScenarioDefinition {
  if (!editCapabilities(tree, { kind: "node", nodeId }).removeStep.ok) {
    return def;
  }
  const t = cloneTree(tree);
  applyRemoveStep(t, nodeId);
  return commit(def, t);
}

/** Moves the step at `from` of the sequence at `path` to slot `to` (an
 *  index in the sequence without it). A move never leaves its sequence. */
export function moveStep(
  def: ScenarioDefinition,
  tree: BlockTree,
  path: SeqPath,
  from: number,
  to: number,
): ScenarioDefinition {
  if (from === to) return def;
  if (!canMove(tree, path, from, to).ok) return def;
  const t = cloneTree(tree);
  applyMoveStep(t, path, from, to);
  return commit(def, t);
}

/** Takes the step `nodeId` out of where it is and puts it at slot `index`
 *  of the sequence at `path` (`loop`: as the first step of a new Repeat
 *  block there). The tree is a clone; null when refused, with the reason. */
function simulateMoveTo(
  tree: BlockTree,
  nodeId: string,
  path: SeqPath,
  index: number,
  loop: boolean,
): { t: BlockTree; target: Seq; at: number } | { reason: MessageKey } {
  const found = locate(tree, nodeId);
  if (!found) return { reason: "scenarios.editor.cannot.notInTree" };
  if (found.block.kind !== "step") {
    return { reason: "scenarios.editor.cannot.notAStep" };
  }
  if (isTerminal(found.block.node)) {
    return { reason: "scenarios.editor.cannot.terminalStep" };
  }
  const removal = editCapabilities(tree, { kind: "node", nodeId }).removeStep;
  if (!removal.ok) return { reason: removal.reason };
  if (!seqAt(tree, path))
    return { reason: "scenarios.editor.cannot.notInTree" };
  const t = cloneTree(tree);
  const src = locate(t, nodeId)!;
  const target = seqAt(t, path)!;
  if (src.seq === target) {
    const n = target.blocks.length;
    // The loop closes the sequence: the step itself being last is a wrap.
    if (!(loop && src.index === n - 1 && index === n)) {
      if (index === src.index || index === src.index + 1) {
        return { reason: "scenarios.editor.cannot.samePlace" };
      }
    }
  }
  if (src.seq === target && loop && src.index === target.blocks.length - 1) {
    // Wrapping the last step of its own sequence where it stands.
    const cap = canWrapInLoop(t, path, src.index, src.index);
    if (!cap.ok) return { reason: cap.reason };
    applyWrapInLoop(target, src.index, src.index);
    [t.root, ...t.detached].forEach(repath);
    return { t, target, at: src.index };
  }
  const block = removeStepBlockAt(t, src.seq, src.index, true);
  [t.root, ...t.detached].forEach(repath);
  // `index` counts the slots as they were: a step taken out above the slot
  // moves it up by one.
  const at = src.seq === target && src.index < index ? index - 1 : index;
  const slot = loop
    ? canInsertLoopAt(t, target.path, at)
    : canInsertAt(t, target.path, at);
  if (!slot.ok) return { reason: slot.reason };
  insertBlockAt(t, target, at, {
    kind: "step",
    node: block.node,
    edgeIn: null,
  });
  if (loop) {
    const cap = canWrapInLoop(t, target.path, at, at);
    if (!cap.ok) return { reason: cap.reason };
    applyWrapInLoop(target, at, at);
  }
  [t.root, ...t.detached].forEach(repath);
  if (boundedLoopProblem(t) !== null) {
    return { reason: "scenarios.editor.cannot.breaksLoopBounds" };
  }
  return { t, target, at };
}

/**
 * Whether the step `nodeId` can be dropped at slot `index` of the sequence at
 * `path` (any sequence: a drag across lanes and into or out of loops is a
 * remove and an insert). `loop`: into a new Repeat block at that slot.
 */
export function canMoveStepTo(
  tree: BlockTree,
  nodeId: string,
  path: SeqPath,
  index: number,
  loop = false,
): Capability {
  const out = simulateMoveTo(tree, nodeId, path, index, loop);
  return "reason" in out ? no(out.reason) : OK;
}

/**
 * Moves the step `nodeId` to slot `index` of the sequence at `path`, across
 * sequences if need be. Returns `def` itself when refused (see
 * {@link canMoveStepTo}) or when the result would not read back as asked.
 */
export function moveStepTo(
  def: ScenarioDefinition,
  tree: BlockTree,
  nodeId: string,
  path: SeqPath,
  index: number,
  loop = false,
): ScenarioDefinition {
  const out = simulateMoveTo(tree, nodeId, path, index, loop);
  if ("reason" in out) return def;
  const next = commit(def, out.t);
  // Safety net: the file must read back with the step where it was dropped.
  const back = recognizeBlockTree(next);
  const place = back.nodePath.get(nodeId);
  const want = loop ? `${out.target.path}/${out.at}/body` : out.target.path;
  if (!place || place.path !== want) return def;
  return next;
}
