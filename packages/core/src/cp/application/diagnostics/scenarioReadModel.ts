import type {
  ActiveRunState,
  LastRunOutcome,
  ScenarioIntrospection,
  ScenarioRunView,
} from "../../domain/charge-point/DiagnosticsSources";

/**
 * The station-level scenario read model (#927), shared by the OCPP 1.6
 * `GetConfiguration` keys, the 2.x `SimulatorCtrlr` variables and the
 * diagnostic bundle (#925): one function, so no transport copies scenario
 * state.
 *
 * Vocabulary of {@link ScenarioSummary.status} (the station-level aggregate):
 *
 * - `idle`: no run is in progress. A finished run never shows here: it is
 *   `lastRun`.
 * - `running` / `waiting` / `paused` / `stepping`: exactly one run is in
 *   progress and it is in that state (`waiting`: parked on a wait node;
 *   `paused` / `stepping`: an operator control).
 * - `multiple`: more than one run is in progress (one per connector at most).
 * - `unavailable`: the host gave this station no scenario runtime (the
 *   browser's local mode; a bare core charge point).
 */
export type ScenarioAggregateStatus =
  "idle" | ActiveRunState | "multiple" | "unavailable";

export interface ScenarioSummary {
  readonly status: ScenarioAggregateStatus;
  /** The in-progress runs, ordered by connector. */
  readonly runs: ReadonlyArray<ScenarioRunView>;
  /** Selected scenario id: the simulator has no selection yet (#569), so ""
   *  (kept as a stable key for when it has). */
  readonly selectedScenarioId: string;
  readonly lastRun: {
    readonly runId: string;
    readonly scenarioId: string;
    readonly connectorId: number;
    readonly outcome: LastRunOutcome;
    readonly endedAt?: number;
  } | null;
  readonly installedCount: number;
}

export function summarizeScenarios(
  source: ScenarioIntrospection | undefined,
): ScenarioSummary {
  if (!source) {
    return {
      status: "unavailable",
      runs: [],
      selectedScenarioId: "",
      lastRun: null,
      installedCount: 0,
    };
  }
  const runs = [...source.activeRuns()].sort(
    (a, b) => a.connectorId - b.connectorId || a.runId.localeCompare(b.runId),
  );
  const status: ScenarioAggregateStatus =
    runs.length === 0
      ? "idle"
      : runs.length === 1
        ? runs[0]!.state
        : "multiple";
  return {
    status,
    runs,
    selectedScenarioId: "",
    lastRun: source.lastRun(),
    installedCount: source.installed().length,
  };
}
