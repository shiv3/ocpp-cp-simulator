import type { ScenarioRunResult } from "../../application/verification/ScenarioAssertions";
import {
  matchesRunQuery,
  summarizeRun,
  type ScenarioRunPage,
  type ScenarioRunQuery,
} from "../../application/verification/ScenarioRunSummary";

/**
 * Scenario run history (#388): the finished-run reports `scenario_report`
 * serves, and the listing `scenario.runs.list` pages through.
 *
 * One store per daemon, shared by every charge point, so a listing can span
 * charge points. {@link InMemoryScenarioRunRepository} backs a daemon without
 * `--state-db`; `SqliteScenarioRunRepository` keeps the history across
 * restarts.
 *
 * Retention is per charge point: past {@link MAX_RUNS_PER_CP} runs, recording
 * a run evicts that charge point's oldest (by record order). A busy charge
 * point cannot push another one's history out. Deleting a charge point, or
 * `state.reset`, drops its runs.
 */
export const MAX_RUNS_PER_CP = 100;

export interface ScenarioRunRepository {
  /** Store a finished run; re-recording the same `runId` replaces it. */
  record(result: ScenarioRunResult): void;
  get(cpId: string, runId: string): ScenarioRunResult | null;
  /** The run of `scenarioId` recorded last on `cpId`. */
  latest(cpId: string, scenarioId: string): ScenarioRunResult | null;
  list(query: ScenarioRunQuery): ScenarioRunPage;
  deleteForChargePoint(cpId: string): void;
  clear(): void;
}

interface StoredRun {
  /** Record order: the tie-break for equal start times across charge points. */
  seq: number;
  result: ScenarioRunResult;
}

/** Bounded run history for a daemon without `--state-db`. */
export class InMemoryScenarioRunRepository implements ScenarioRunRepository {
  /** Per charge point, by runId. A Map keeps insertion order, and re-setting
   *  a key keeps its place, so each bucket is in record order: its first key
   *  is the one retention evicts. */
  private readonly byCp = new Map<string, Map<string, StoredRun>>();
  private nextSeq = 1;

  record(result: ScenarioRunResult): void {
    let runs = this.byCp.get(result.cpId);
    if (!runs) {
      runs = new Map();
      this.byCp.set(result.cpId, runs);
    }
    const seq = runs.get(result.runId)?.seq ?? this.nextSeq++;
    runs.set(result.runId, { seq, result });
    for (const runId of runs.keys()) {
      if (runs.size <= MAX_RUNS_PER_CP) break;
      runs.delete(runId);
    }
  }

  get(cpId: string, runId: string): ScenarioRunResult | null {
    return this.byCp.get(cpId)?.get(runId)?.result ?? null;
  }

  latest(cpId: string, scenarioId: string): ScenarioRunResult | null {
    let latest: ScenarioRunResult | null = null;
    for (const { result } of this.byCp.get(cpId)?.values() ?? []) {
      if (result.scenarioId === scenarioId) latest = result;
    }
    return latest;
  }

  list(query: ScenarioRunQuery): ScenarioRunPage {
    const buckets =
      query.cpId === undefined
        ? [...this.byCp.values()]
        : [this.byCp.get(query.cpId) ?? new Map<string, StoredRun>()];
    const matching = buckets
      .flatMap((runs) => [...runs.values()])
      .filter(({ result }) => matchesRunQuery(result, query))
      .sort(
        (a, b) =>
          b.result.startedAt.localeCompare(a.result.startedAt) || b.seq - a.seq,
      );
    const offset = query.offset ?? 0;
    const end = query.limit === undefined ? undefined : offset + query.limit;
    return {
      runs: matching
        .slice(offset, end)
        .map(({ result }) => summarizeRun(result)),
      total: matching.length,
    };
  }

  deleteForChargePoint(cpId: string): void {
    this.byCp.delete(cpId);
  }

  clear(): void {
    this.byCp.clear();
  }
}
