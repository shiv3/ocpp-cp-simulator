import type {
  CompatibilityVerdict,
  ScenarioVerdict,
} from "../scenario/ScenarioTypes";
import type { ScenarioRunResult } from "./ScenarioAssertions";

/**
 * The read side of the scenario run history (#388): what `scenario.runs.list`
 * returns and filters on. Shared by the daemon, the control plane and the
 * console; the stores live in `cp/domain/persistence/ScenarioRunRepository`.
 */

export type ScenarioRunExecutionState = ScenarioRunResult["executionState"];

/** Every {@link ScenarioVerdict}, for filters and the control-plane enum. */
export const SCENARIO_VERDICTS = [
  "PASS",
  "FAIL",
  "BLOCKED",
  "SKIPPED",
] as const satisfies readonly ScenarioVerdict[];

/** Every {@link ScenarioRunExecutionState}. */
export const SCENARIO_RUN_EXECUTION_STATES = [
  "completed",
  "error",
] as const satisfies readonly ScenarioRunExecutionState[];

/** One row of the run listing: the report minus the transcript, snapshots
 *  and per-assertion detail, which `scenario_report` returns on demand. */
export interface ScenarioRunSummary {
  runId: string;
  cpId: string;
  connectorId: number;
  scenarioId: string;
  scenarioName?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  executionState: ScenarioRunExecutionState;
  stopped: boolean;
  verdict: ScenarioVerdict;
  conformanceVerdict: ScenarioVerdict;
  compatibilityVerdict: CompatibilityVerdict;
  /** The node the run timed out on, if it did. */
  timeoutNodeId: string | null;
  errorCount: number;
  assertions: { total: number; failed: number };
}

/** Filters are exact matches, and all of them apply. */
export interface ScenarioRunQuery {
  /** One run, wherever it sits in the history (unique per charge point). */
  runId?: string;
  cpId?: string;
  connectorId?: number;
  scenarioId?: string;
  verdict?: ScenarioVerdict;
  executionState?: ScenarioRunExecutionState;
  /** Page size. Omitted = every matching run (`scenario.runs.list` defaults
   *  it to `SCENARIO_RUNS_PAGE_DEFAULT`). */
  limit?: number;
  /** How many of the newest matching runs to skip. */
  offset?: number;
}

/** Newest first (by start time), plus the filtered count before paging. */
export interface ScenarioRunPage {
  runs: ScenarioRunSummary[];
  total: number;
}

export function summarizeRun(result: ScenarioRunResult): ScenarioRunSummary {
  return {
    runId: result.runId,
    cpId: result.cpId,
    connectorId: result.connectorId,
    scenarioId: result.scenarioId,
    scenarioName: result.scenarioName,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: result.durationMs,
    executionState: result.executionState,
    stopped: result.stopped === true,
    verdict: result.verdict,
    conformanceVerdict: result.conformanceVerdict,
    compatibilityVerdict: result.compatibilityVerdict,
    timeoutNodeId: result.timeout?.nodeId ?? null,
    errorCount: result.errors.length,
    assertions: {
      total: result.assertions.length,
      failed: result.assertions.filter((a) => a.status === "failed").length,
    },
  };
}

/** Whether a run passes every filter of `query` (paging aside). */
export function matchesRunQuery(
  run: Pick<
    ScenarioRunSummary,
    | "runId"
    | "cpId"
    | "connectorId"
    | "scenarioId"
    | "verdict"
    | "executionState"
  >,
  query: ScenarioRunQuery,
): boolean {
  return (
    (query.runId === undefined || run.runId === query.runId) &&
    (query.cpId === undefined || run.cpId === query.cpId) &&
    (query.connectorId === undefined ||
      run.connectorId === query.connectorId) &&
    (query.scenarioId === undefined || run.scenarioId === query.scenarioId) &&
    (query.verdict === undefined || run.verdict === query.verdict) &&
    (query.executionState === undefined ||
      run.executionState === query.executionState)
  );
}
