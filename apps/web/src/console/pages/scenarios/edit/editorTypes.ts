import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

/** A connector that uses the Library scenario being edited. */
export interface LibraryEditorUser {
  cpId: string;
  connectorId: number | null;
  /** A run of the scenario is live there (a save stops it). */
  running: boolean;
}

/** What the Library editor adds to the plain editor: who uses the scenario,
 *  and a save that re-pushes it to them. */
export interface LibraryEditorBinding {
  users: LibraryEditorUser[];
  save: (scenario: ScenarioDefinition) => Promise<void>;
}

export type EditorView = "steps" | "graph";
