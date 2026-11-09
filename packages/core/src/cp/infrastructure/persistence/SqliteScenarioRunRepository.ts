import type { ScenarioRunResult } from "../../application/verification/ScenarioAssertions";
import type { Database, SqlParam } from "../../domain/persistence/Database";
import { parseStoredJson } from "./parseStoredJson";
import { buildUpsert } from "./upsert";
import {
  summarizeRun,
  type ScenarioRunPage,
  type ScenarioRunQuery,
  type ScenarioRunSummary,
} from "../../application/verification/ScenarioRunSummary";
import {
  MAX_RUNS_PER_CP,
  type ScenarioRunRepository,
} from "../../application/verification/ScenarioRunRepository";

/**
 * `scenario_runs`-backed run history (#388), for a daemon started with
 * `--state-db`: the history and every report survive a restart.
 *
 * A row whose JSON no longer parses is skipped rather than thrown, so one bad
 * row cannot make the whole listing fail (the `BlueprintRepository` rule).
 * The listing's `total` still counts it.
 */
export class SqliteScenarioRunRepository implements ScenarioRunRepository {
  constructor(private readonly db: Database) {}

  record(result: ScenarioRunResult): void {
    // One transaction for the write and its retention sweep: one commit per
    // recorded run, and never a charge point left past the cap.
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      // Upsert rather than INSERT OR REPLACE: a replace deletes the row and
      // hands it a new `seq`, which would move it to the back of the
      // eviction queue.
      const { sql, params } = buildUpsert(
        "scenario_runs",
        [
          ["cp_id", result.cpId],
          ["run_id", result.runId],
          ["connector_id", result.connectorId],
          ["scenario_id", result.scenarioId],
          ["started_at", result.startedAt],
          ["ended_at", result.endedAt],
          ["execution_state", result.executionState],
          ["verdict", result.verdict],
          ["summary_json", JSON.stringify(summarizeRun(result))],
          ["report_json", JSON.stringify(result)],
        ],
        ["cp_id", "run_id"],
      );
      this.db.run(sql, params);
      // Everything at or below the charge point's (cap+1)-th newest `seq`.
      this.db.run(
        "DELETE FROM scenario_runs WHERE cp_id = ? AND seq <= (" +
          "SELECT seq FROM scenario_runs WHERE cp_id = ? " +
          "ORDER BY seq DESC LIMIT 1 OFFSET ?)",
        [result.cpId, result.cpId, MAX_RUNS_PER_CP],
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(cpId: string, runId: string): ScenarioRunResult | null {
    const row = this.db.get<{ report_json: string }>(
      "SELECT report_json FROM scenario_runs WHERE cp_id = ? AND run_id = ?",
      [cpId, runId],
    );
    return row ? parseRun<ScenarioRunResult>(row.report_json) : null;
  }

  latest(cpId: string, scenarioId: string): ScenarioRunResult | null {
    const row = this.db.get<{ report_json: string }>(
      "SELECT report_json FROM scenario_runs WHERE cp_id = ? AND scenario_id = ? " +
        "ORDER BY seq DESC LIMIT 1",
      [cpId, scenarioId],
    );
    return row ? parseRun<ScenarioRunResult>(row.report_json) : null;
  }

  list(query: ScenarioRunQuery): ScenarioRunPage {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    const filter = (column: string, value: SqlParam | undefined): void => {
      if (value === undefined) return;
      clauses.push(`${column} = ?`);
      params.push(value);
    };
    filter("run_id", query.runId);
    filter("cp_id", query.cpId);
    filter("connector_id", query.connectorId);
    filter("scenario_id", query.scenarioId);
    filter("verdict", query.verdict);
    filter("execution_state", query.executionState);
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";

    const total =
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM scenario_runs${where}`,
        params,
      )?.n ?? 0;
    // SQLite needs a LIMIT to take an OFFSET; -1 means "no limit".
    const rows = this.db.all<{ summary_json: string }>(
      `SELECT summary_json FROM scenario_runs${where} ` +
        "ORDER BY started_at DESC, seq DESC LIMIT ? OFFSET ?",
      [...params, query.limit ?? -1, query.offset ?? 0],
    );
    const runs: ScenarioRunSummary[] = [];
    for (const row of rows) {
      const summary = parseRun<ScenarioRunSummary>(row.summary_json);
      if (summary) runs.push(summary);
    }
    return { runs, total };
  }

  deleteForChargePoint(cpId: string): void {
    this.db.run("DELETE FROM scenario_runs WHERE cp_id = ?", [cpId]);
  }

  clear(): void {
    this.db.run("DELETE FROM scenario_runs");
  }
}

/** The stored JSON, or null when it no longer parses to a run object. */
function parseRun<T extends { runId: string }>(json: string): T | null {
  return parseStoredJson<T>(json, "runId");
}
