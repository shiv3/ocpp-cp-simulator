import type { Edge } from "@xyflow/react";

import {
  type ChoiceNodeData,
  type ScenarioNode,
  ScenarioNodeType,
  type SwitchNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { connectionRule } from "@ocpp-cp-simulator/core/scenario/scenarioConnectionRules";
import {
  isTerminal,
  nextStep,
  pickableHandles,
  timeoutStep,
  waitTimeoutSeconds,
} from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

import type { ForkKind, LaneCondition, Program } from "./types";

export const handleOf = (edge: Edge): string | null =>
  typeof edge.sourceHandle === "string" ? edge.sourceHandle : null;

/** A node of type END that is not the origin: never placed, an exit. */
export function isEndSink(
  node: ScenarioNode,
  origin: ScenarioNode | undefined,
) {
  return node !== origin && node.type === ScenarioNodeType.END;
}

// ---------------------------------------------------------------------------
// Structural successors (design §2)

export interface LaneEdge {
  edge: Edge;
  condition: LaneCondition;
}

export interface NodeOut {
  /** The edges the tree structures out of the node, in lane order. One
   *  edge: a chain; two or more: a fork of `forkKind`. */
  lanes: LaneEdge[];
  forkKind: ForkKind;
}

export function conditionOf(node: ScenarioNode, handle: string): LaneCondition {
  const data = node.data as Partial<SwitchNodeData & ChoiceNodeData>;
  if (handle === "default") return { kind: "default" };
  const caseMatch = /^case-(\d+)$/.exec(handle);
  if (caseMatch) {
    const index = Number(caseMatch[1]);
    return {
      kind: "case",
      index,
      value: Array.isArray(data.cases) ? data.cases[index] : undefined,
    };
  }
  const index = Number(/^option-(\d+)$/.exec(handle)?.[1] ?? 0);
  const option = Array.isArray(data.options) ? data.options[index] : undefined;
  return {
    kind: "option",
    index,
    weight: typeof option?.weight === "number" ? option.weight : 1,
    ...(typeof option?.label === "string" ? { label: option.label } : {}),
  };
}

/**
 * A trigger wait with a live timeout edge (schema 1.8) is a "timeout" fork:
 * the event lane (the wait's first ordinary edge) and the timeout lane (its
 * first timeout edge, taken only when `data.timeout` seconds pass). `null`
 * when the wait has no timeout that can expire, no timeout edge to an
 * existing node, or no event edge: its timeout edges are `timeoutDead`
 * links (the executor never takes them, or the wait has no other way on).
 */
function timeoutLanes(program: Program, node: ScenarioNode): NodeOut | null {
  const seconds = waitTimeoutSeconds(node);
  if (seconds === null || seconds <= 0) return null;
  const timeout = timeoutStep(program, node);
  if (!timeout) return null;
  const event = nextStep(program, node, null);
  if (event.kind !== "edge") return null;
  return {
    lanes: [
      { edge: event.edge, condition: { kind: "event" } },
      { edge: timeout.edge, condition: { kind: "timeout", seconds } },
      ...(program.outgoing.get(node.id) ?? [])
        .filter((e) => e !== event.edge)
        .map((edge) => ({ edge, condition: { kind: "ignored" } as const })),
    ],
    forkKind: "timeout",
  };
}

export function structuralOut(program: Program, node: ScenarioNode): NodeOut {
  const existing = program.outgoing.get(node.id) ?? [];
  if (node === program.origin) {
    return {
      lanes: existing.map((edge) => ({ edge, condition: { kind: "all" } })),
      forkKind: "start",
    };
  }
  if (isTerminal(node)) return { lanes: [], forkKind: "extra" };
  const timeout = timeoutLanes(program, node);
  if (timeout) return timeout;
  const out = connectionRule(node.type).out;
  if (out === "select") {
    const handles = pickableHandles(node) ?? [];
    const lanes: LaneEdge[] = [];
    const taken = new Set<Edge>();
    for (const handle of handles) {
      const first = existing.find((e) => handleOf(e) === handle);
      if (!first) continue;
      taken.add(first);
      lanes.push({ edge: first, condition: conditionOf(node, handle) });
    }
    for (const edge of existing) {
      if (taken.has(edge)) continue;
      const handle = handleOf(edge);
      lanes.push({
        edge,
        condition:
          handle !== null && handles.includes(handle)
            ? { kind: "ignored" }
            : { kind: "unpickable", handle },
      });
    }
    return {
      lanes,
      forkKind: node.type === ScenarioNodeType.CHOICE ? "choice" : "switch",
    };
  }
  // A `parallel` node (schema 1.9, `out: "fork"`) runs every ordinary edge,
  // each as its own branch, like the origin. A START that is not the origin
  // runs as a step, so `out === "parallel"` never matches here.
  if (
    out === "fork" ||
    (out === "parallel" && node.type !== ScenarioNodeType.START)
  ) {
    return {
      lanes: existing.map((edge) => ({ edge, condition: { kind: "all" } })),
      forkKind: "parallel",
    };
  }
  // `next` (and unknown types): the first edge to an existing node runs; the
  // others never do but stay lanes so no edge disappears.
  // A wait's `kind: "timeout"` edges are not in `program.outgoing`: they are
  // the timeout fork's own lanes (`timeoutLanes` above) or `timeoutDead`
  // links, never an "extra" fork's.
  // TODO(parallel): a parallel node's lanes are matched above; none of its
  // edges may reach this branch.
  // TODO(bounded loops, schema 1.7): on a latch with a `kind: "loop"` edge
  // and an ordinary exit edge, the loop edge is the back-edge lane and the
  // exit the step's chain edge (first-edge-wins among non-loop, non-timeout
  // edges), not an "extra" fork of two lanes.
  const step = nextStep(program, node, null);
  if (step.kind !== "edge") return { lanes: [], forkKind: "extra" };
  return {
    lanes: [
      { edge: step.edge, condition: { kind: "first" } },
      ...existing
        .filter((e) => e !== step.edge)
        .map((edge) => ({ edge, condition: { kind: "ignored" } as const })),
    ],
    forkKind: "extra",
  };
}

export const isLive = (condition: LaneCondition): boolean =>
  condition.kind !== "ignored" && condition.kind !== "unpickable";
