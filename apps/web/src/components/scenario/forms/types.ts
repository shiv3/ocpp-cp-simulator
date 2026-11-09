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
  /** The keys the scenario's setState steps store (`$from` `state.<key>`). */
  stateKeys?: readonly string[];
  /** Where the lane on `handle` (`case-<n>`, `default`, `option-<n>`) leads:
   *  the first edge out of the step with that handle; null: none yet. */
  laneTarget?: (handle: string) => LaneTarget | null;
  /** Stores `next` and moves the step's `case-<n>` / `option-<n>` edges
   *  with their items (`mapping`: old index → new index, null: removed,
   *  whose edges go too), in one change. Absent: a plain `onChange`. */
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
