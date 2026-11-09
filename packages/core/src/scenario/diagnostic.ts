/**
 * One shape for everything a check finds in a scenario: the graph validator
 * (`validateScenarioGraph`), the lowering of a scenario into the program the
 * executor walks (`lowerScenario`), and the loading gate
 * (`checkLoadableScenario`). Each check narrows `code` to its own set.
 */

/**
 * - `error`: the scenario cannot run (or load) as written;
 * - `warning`: part of it is ignored or will fail at run time;
 * - `info`: advisory only, e.g. a default filled in at load.
 */
export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic<Code extends string = string> {
  code: Code;
  severity: DiagnosticSeverity;
  /** The node the diagnostic is about, when it is about one. */
  nodeId?: string;
  /** The edge the diagnostic is about, when it is about one. */
  edgeId?: string;
  /** Code-specific detail (e.g. the value a default replaced). */
  data?: Record<string, unknown>;
}
