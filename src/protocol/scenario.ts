// Scenario vocabulary the control plane filters and reports on: the execution
// mode, the run verdicts and the run execution states. The scenario model
// (`cp/application/scenario/ScenarioTypes.ts`) re-exports the mode and is
// checked against these lists by `cp/shared/__tests__/protocolContract.test.ts`.

/**
 * Scenario execution mode
 */
export type ScenarioMode = "manual" | "scenario";

/** Every `ScenarioVerdict`, for filters and the control-plane enum. */
export const SCENARIO_VERDICTS = [
  "PASS",
  "FAIL",
  "BLOCKED",
  "SKIPPED",
] as const;

/** Every `ScenarioRunExecutionState`. */
export const SCENARIO_RUN_EXECUTION_STATES = ["completed", "error"] as const;
