import type React from "react";
import type { IndexMapping } from "./scenarioValue";

export type NodeFormData = Record<string, unknown>;

/** Where a `switch` / `choice` lane leads, as the inspector words it. */
export type LaneTarget = { kind: "step"; text: string } | { kind: "end" };

/**
 * What a form may know of the scenario around its step. Every field is
 * optional: a form rendered without it (or read-only) edits its own data.
 */
export interface NodeFormContext {
  /** Open this lane's row (`case-<n>`, `default`, `option-<n>`): scroll it
   *  into view, highlight it briefly and focus its field. `nonce` changes
   *  on every request, so asking for the same lane again repeats it. */
  focusLane?: { handle: string; nonce: number };
  /** The keys the scenario's setState steps store (`$from` `state.<key>`). */
  stateKeys?: readonly string[];
  /** Where the lane on `handle` (`case-<n>`, `default`, `option-<n>`) leads:
   *  the first edge out of the step with that handle; null: none yet. */
  laneTarget?: (handle: string) => LaneTarget | null;
  /** How many edges leave the step on `handle` (only the first runs; a
   *  removal takes them all). */
  laneEdgeCount?: (handle: string) => number;
  /** Stores `next` and moves the step's `case-<n>` / `option-<n>` edges
   *  with their items (`mapping`: old index → new index, null: removed,
   *  whose edges go too; an index past the old list names a handle with
   *  no item, null drops its edges), in one change. Absent: a plain
   *  `onChange`. */
  onReindex?: (next: NodeFormData, mapping: IndexMapping) => void;
}

export interface NodeFormComponentProps<
  TFormData extends NodeFormData = NodeFormData,
> {
  value: TFormData;
  onChange: (value: TFormData) => void;
  onOpenMeterCurve?: () => void;
  context?: NodeFormContext;
}

export type NodeFormComponent<TFormData extends NodeFormData = NodeFormData> =
  React.ComponentType<NodeFormComponentProps<TFormData>>;
