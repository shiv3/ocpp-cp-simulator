import type {
  ActiveRunState,
  LastRunOutcome,
  ScenarioIntrospection,
  ScenarioRunView,
} from "./DiagnosticsSources";

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

/**
 * The OCPP surface of the read model (#927): 1.6 `GetConfiguration` keys and
 * the 2.x `SimulatorCtrlr` variables of the same names minus the `Sim` prefix
 * (`SimScenarioStatus` is `SimulatorCtrlr.ScenarioStatus`). All values are
 * strings, read-only, bounded and carry no scenario definition, path or
 * secret.
 */
export const SCENARIO_CONFIG_KEYS = [
  "SimScenarioId",
  "SimScenarioStatus",
  "SimScenarioRunCount",
  "SimScenarioRunId",
  "SimScenarioStep",
  "SimScenarioConnectorId",
  "SimScenarioRuns",
  "SimScenarioLastRunId",
  "SimScenarioLastStatus",
] as const;

export type ScenarioConfigKey = (typeof SCENARIO_CONFIG_KEYS)[number];

/** Longest `SimScenarioRuns` value (a 1.6 configuration value is at most 500). */
export const SCENARIO_RUNS_MAX_CHARS = 500;

export function scenarioConfigValues(
  summary: ScenarioSummary,
): Record<ScenarioConfigKey, string> {
  const one = summary.runs.length === 1 ? summary.runs[0]! : null;
  let runs = "";
  for (const r of summary.runs) {
    const item = `${r.connectorId}:${r.runId}:${r.state}`;
    const next = runs === "" ? item : `${runs},${item}`;
    if (next.length > SCENARIO_RUNS_MAX_CHARS) break;
    runs = next;
  }
  return {
    SimScenarioId: summary.selectedScenarioId,
    SimScenarioStatus: summary.status,
    SimScenarioRunCount: String(summary.runs.length),
    SimScenarioRunId: one?.runId ?? "",
    SimScenarioStep: one?.stepNodeId ?? "",
    SimScenarioConnectorId: one ? String(one.connectorId) : "",
    SimScenarioRuns: runs,
    SimScenarioLastRunId: summary.lastRun?.runId ?? "",
    SimScenarioLastStatus: summary.lastRun?.outcome ?? "none",
  };
}
