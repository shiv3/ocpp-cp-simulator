import type { Edge } from "@xyflow/react";

import type {
  ScenarioDefinition,
  ScenarioNode,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  loopBounds,
  type ReadLoopBounds,
  type ScenarioProgram,
} from "@ocpp-cp-simulator/core/scenario/scenarioGraph";

// ---------------------------------------------------------------------------
// Types (design §1)

/** A stable key of a sequence: `root`, `detached/<k>`, then per level
 *  `/<block index>/lanes/<lane index>` or `/<block index>/body`. */
export type SeqPath = string;

export interface Seq {
  path: SeqPath;
  blocks: Block[];
  exit: SeqExit;
}

export type SeqExit =
  /** To END (`edgeId` null: a new edge to END is made). */
  | { kind: "end"; edgeId: string | null }
  /** The branch ends: no edge, only edges to missing nodes, a step that
   *  ends its branch, or a last block that ends every path itself. */
  | {
      kind: "stop";
      reason: "noEdge" | "dangling" | "terminalStep" | "blockEnds";
      edgeId?: string;
    }
  /** On to the parent's merge, a loop's header or a loop's continuation
   *  (the parent draws that node). */
  | { kind: "fallthrough"; to: string; edgeId?: string | null }
  /** A goto: a join into a step placed elsewhere, a loop back edge that is
   *  not structured, an edge into START. */
  | { kind: "link"; edgeId: string; target: string };

export type Block = StepBlock | ForkBlock | LoopBlock;

export interface StepBlock {
  kind: "step";
  node: ScenarioNode;
  /** The edge from the previous step (or the lane / START) into it; null
   *  when several edges join here (a merge) or it starts a detached island. */
  edgeIn: string | null;
}

/** `timeout` (a wait's event / timeout lanes, schema 1.7) and `parallel`
 *  (a parallel node with a join) are extension points: nothing recognizes
 *  them until the core has them. */
export type ForkKind =
  "start" | "parallel" | "switch" | "choice" | "timeout" | "extra";

export type LaneCondition =
  | { kind: "case"; index: number; value: unknown }
  | { kind: "default" }
  | { kind: "option"; index: number; weight: number; label?: string }
  | { kind: "all" }
  | { kind: "first" }
  | { kind: "event" }
  | { kind: "timeout"; seconds: number }
  | { kind: "ignored" }
  | { kind: "unpickable"; handle: string | null };

export interface Lane {
  edgeId: string;
  handle: string | null;
  condition: LaneCondition;
  body: Seq;
}

export interface ForkBlock {
  kind: "fork";
  forkKind: ForkKind;
  node: ScenarioNode;
  edgeIn: string | null;
  lanes: Lane[];
  /** Where the lanes meet again (the next block of the parent sequence, or
   *  the node the parent falls through to); null when they never do.
   *  `join` is the parallel extension point. */
  merge:
    | { kind: "node"; nodeId: string }
    | { kind: "join"; nodeId: string; mode: "all" | "any" }
    | null;
}

export interface LoopBlock {
  kind: "loop";
  /** The loop's first node: `body.blocks[0]`'s node. */
  headerId: string;
  body: Seq;
  backEdgeIds: string[];
  /** A loop drawn by a loop edge (schema 1.10): its id and `loop` bounds as
   *  the file has them. Null: a plain back edge (repeats until the run
   *  stops). */
  loopEdge: LoopEdgeRef | null;
}

/** The loop edge of a bounded {@link LoopBlock}. */
export interface LoopEdgeRef {
  edgeId: string;
  /** The edge's `loop`, unvalidated; undefined: none (loops forever). */
  loop: unknown;
}

/** The bounds of a loop as the editor shows them: `null` when the loop
 *  repeats forever (a plain back edge, or a loop edge without bounds),
 *  `{ problem }` when its `loop` is malformed. */
export function loopBlockBounds(
  loop: Pick<LoopBlock, "loopEdge">,
): ReadLoopBounds | null | { problem: string } {
  if (!loop.loopEdge) return null;
  const read = loopBounds({
    id: loop.loopEdge.edgeId,
    source: "",
    target: "",
    loop: loop.loopEdge.loop,
  });
  if ("problem" in read) return read;
  return hasBounds(read.bounds) ? read.bounds : null;
}

/** Whether `bounds` has at least one bound (else the loop never exits). */
export function hasBounds(bounds: ReadLoopBounds | null | undefined): boolean {
  return (
    !!bounds &&
    (bounds.times !== undefined ||
      bounds.forSeconds !== undefined ||
      bounds.until !== undefined)
  );
}

export interface LinkEdge {
  edge: Edge;
  role:
    | "back"
    | "join"
    | "dead"
    | "dangling"
    | "intoStart"
    | "outOfEnd"
    | "timeoutDead"
    /** A loop edge (`kind: "loop"`, schema 1.10): not an ordinary edge, so no
     *  block draws it yet (the Steps view has no bounds form). It stays in
     *  the file exactly as it is while the steps around it are edited. */
    | "loopEdge";
}

export interface BlockTree {
  root: Seq;
  detached: Seq[];
  links: LinkEdge[];
  /** Every edge the tree draws structurally, by id. */
  drawnEdges: ReadonlyMap<string, { source: string; target: string }>;
  /** Where each placed node is: its sequence and block index. A loop
   *  header is at index 0 of its loop's body. */
  nodePath: ReadonlyMap<string, { path: SeqPath; index: number }>;
  /** The node a run starts from; null without one. */
  origin: ScenarioNode | null;
}

export type Def = Pick<ScenarioDefinition, "nodes" | "edges">;
export type Program = ScenarioProgram<ScenarioNode, Edge>;
