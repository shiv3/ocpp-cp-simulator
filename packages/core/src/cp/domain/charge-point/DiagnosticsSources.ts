/**
 * What the host (the daemon) hands a charge point so that its diagnostic
 * snapshot (#925) and its read-only scenario introspection (#927) can name
 * things the core does not own: the scenario runs live in the host's service
 * layer, not in the domain. Every member is optional; a part that has no
 * source is reported as not available, never invented.
 */

/** The states of a run in progress, as `ScenarioExecutionState` names them. */
export type ActiveRunState = "running" | "waiting" | "paused" | "stepping";

/** One scenario run that has started and not finished. */
export interface ScenarioRunView {
  readonly runId: string;
  readonly scenarioId: string;
  readonly scenarioName?: string;
  /** Connector the run is bound to (scenarios are connector-scoped). */
  readonly connectorId: number;
  readonly state: ActiveRunState;
  /** The node being executed or waited on; null between nodes. */
  readonly stepNodeId: string | null;
  /** Epoch ms the run started, when known. */
  readonly startedAt?: number;
  /** Epoch ms a parked wait times out, when one is parked and bounded. */
  readonly waitDeadlineAt?: number | null;
}

/** How the most recent finished run ended. */
export type LastRunOutcome = "passed" | "failed" | "error" | "stopped";

/** The most recent run that has finished (never an active one). */
export interface ScenarioLastRunView {
  readonly runId: string;
  readonly scenarioId: string;
  readonly connectorId: number;
  readonly outcome: LastRunOutcome;
  /** Epoch ms the run ended, when known. */
  readonly endedAt?: number;
}

/** A scenario installed on the station. */
export interface InstalledScenarioView {
  readonly id: string;
  readonly name: string;
  readonly connectorId: number;
  /** Disabled scenarios never start on their own. */
  readonly enabled: boolean;
}

/** The scenario runtime's read model (the host implements it). */
export interface ScenarioIntrospection {
  installed(): ReadonlyArray<InstalledScenarioView>;
  /** Every active run: a station can run one scenario per connector. */
  activeRuns(): ReadonlyArray<ScenarioRunView>;
  lastRun(): ScenarioLastRunView | null;
  /**
   * The definition of an installed scenario, for the diagnostic bundle. The
   * snapshot redacts it; it is never put in a configuration answer.
   */
  definition(scenarioId: string): unknown | undefined;
}

export interface DiagnosticsSources {
  /** The simulator's version, for the manifest. */
  readonly simulatorVersion?: string;
  readonly scenarios?: ScenarioIntrospection;
  /**
   * OCPP-J trace records of this station as JSON-lines text (the Open OCPP
   * Trace SDK contract), oldest first. Absent: the trace part is omitted.
   */
  readonly traceLines?: () => ReadonlyArray<string>;
}
