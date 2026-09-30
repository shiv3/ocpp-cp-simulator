// Runs under `bun test`: the SQLite implementation uses the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunSqliteDatabase } from "../BunSqliteDatabase";
import {
  InMemoryScenarioRunRepository,
  MAX_RUNS_PER_CP,
  type ScenarioRunRepository,
} from "../ScenarioRunRepository";
import { SqliteScenarioRunRepository } from "../SqliteScenarioRunRepository";
import type { ScenarioRunResult } from "../../../application/verification/ScenarioAssertions";
import { summarizeRun } from "../../../application/verification/ScenarioRunSummary";
import { scenarioRunResult } from "../../../../test/scenarioRunFixtures";

/**
 * #388: the run history contract, run against both implementations — the
 * shared in-memory store a daemon without `--state-db` uses, and the
 * `scenario_runs` table.
 */

let clock = Date.parse("2026-09-30T08:00:00.000Z");

function run(overrides: Partial<ScenarioRunResult> = {}): ScenarioRunResult {
  clock += 1_000;
  return scenarioRunResult({
    runId: `run-${clock}`,
    cpId: "CP-A",
    startedAt: new Date(clock).toISOString(),
    endedAt: new Date(clock + 500).toISOString(),
    durationMs: 500,
    ...overrides,
  });
}

const opened: BunSqliteDatabase[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

const implementations: Array<[string, () => ScenarioRunRepository]> = [
  ["in-memory", () => new InMemoryScenarioRunRepository()],
  [
    "sqlite",
    () => {
      const db = BunSqliteDatabase.open(":memory:");
      opened.push(db);
      return new SqliteScenarioRunRepository(db);
    },
  ],
];

describe.each(implementations)("ScenarioRunRepository (%s)", (_, create) => {
  it("returns a recorded run by id, as latest, and in the listing", () => {
    const repo = create();
    const result = run();
    repo.record(result);

    expect(repo.get("CP-A", result.runId)).toEqual(result);
    expect(repo.latest("CP-A", "s1")).toEqual(result);
    expect(repo.list({})).toEqual({ runs: [summarizeRun(result)], total: 1 });
  });

  it("returns null for an unknown run, and for another CP's run", () => {
    const repo = create();
    const result = run();
    repo.record(result);

    expect(repo.get("CP-A", "nope")).toBeNull();
    expect(repo.get("CP-B", result.runId)).toBeNull();
    expect(repo.latest("CP-B", "s1")).toBeNull();
    expect(repo.latest("CP-A", "other")).toBeNull();
  });

  it("keeps several runs of one scenario distinct, newest first", () => {
    const repo = create();
    const first = run();
    const second = run();
    const third = run();
    repo.record(first);
    repo.record(second);
    repo.record(third);

    expect(repo.list({}).runs.map((r) => r.runId)).toEqual([
      third.runId,
      second.runId,
      first.runId,
    ]);
    expect(repo.latest("CP-A", "s1")?.runId).toBe(third.runId);
  });

  it("orders by start time, not by the order runs finished in", () => {
    const repo = create();
    const early = run();
    const late = run();
    // The later-started run finishes first.
    repo.record(late);
    repo.record(early);

    expect(repo.list({}).runs.map((r) => r.runId)).toEqual([
      late.runId,
      early.runId,
    ]);
    // "latest" stays the last run recorded, as scenario_report always had it.
    expect(repo.latest("CP-A", "s1")?.runId).toBe(early.runId);
  });

  it("replaces a run recorded twice instead of duplicating it", () => {
    const repo = create();
    const result = run();
    repo.record(result);
    repo.record({ ...result, verdict: "FAIL" });

    const page = repo.list({});
    expect(page.total).toBe(1);
    expect(page.runs[0].verdict).toBe("FAIL");
  });

  it("breaks a start-time tie by record order, newest first", () => {
    const repo = create();
    const first = run();
    const second = run({ startedAt: first.startedAt });
    repo.record(first);
    repo.record(second);

    expect(repo.list({}).runs.map((r) => r.runId)).toEqual([
      second.runId,
      first.runId,
    ]);
  });

  it("keeps a re-recorded run's place in the eviction order", () => {
    const repo = create();
    const oldest = run();
    repo.record(oldest);
    const rest = Array.from({ length: MAX_RUNS_PER_CP - 1 }, () => run());
    for (const r of rest) repo.record(r);
    // Re-recording must not make the oldest run look new...
    repo.record({ ...oldest, verdict: "FAIL" });
    repo.record(run());

    // ...so it is still the one the cap evicts.
    expect(repo.get("CP-A", oldest.runId)).toBeNull();
    expect(repo.get("CP-A", rest[0].runId)).not.toBeNull();
  });

  it("never returns another CP's, connector's or scenario's runs", () => {
    const repo = create();
    const target = run({ cpId: "CP-A", connectorId: 1, scenarioId: "s1" });
    repo.record(target);
    repo.record(run({ cpId: "CP-B", connectorId: 1, scenarioId: "s1" }));
    repo.record(run({ cpId: "CP-A", connectorId: 2, scenarioId: "s1" }));
    repo.record(run({ cpId: "CP-A", connectorId: 1, scenarioId: "s2" }));

    const page = repo.list({ cpId: "CP-A", connectorId: 1, scenarioId: "s1" });
    expect(page.runs.map((r) => r.runId)).toEqual([target.runId]);
    expect(page.total).toBe(1);
    expect(
      repo.list({ cpId: "CP-B" }).runs.every((r) => r.cpId === "CP-B"),
    ).toBe(true);
    expect(repo.list({ cpId: "CP-C" })).toEqual({ runs: [], total: 0 });
  });

  it("filters by verdict and execution state", () => {
    const repo = create();
    const pass = run({ verdict: "PASS" });
    const fail = run({ verdict: "FAIL" });
    const errored = run({ verdict: "BLOCKED", executionState: "error" });
    repo.record(pass);
    repo.record(fail);
    repo.record(errored);

    expect(repo.list({ verdict: "FAIL" }).runs.map((r) => r.runId)).toEqual([
      fail.runId,
    ]);
    expect(
      repo.list({ executionState: "error" }).runs.map((r) => r.runId),
    ).toEqual([errored.runId]);
  });

  it("pages with limit and offset and reports the filtered total", () => {
    const repo = create();
    const runs = Array.from({ length: 5 }, () => run());
    for (const r of runs) repo.record(r);
    repo.record(run({ cpId: "CP-B" }));
    const newestFirst = runs.map((r) => r.runId).reverse();

    const first = repo.list({ cpId: "CP-A", limit: 2 });
    expect(first.total).toBe(5);
    expect(first.runs.map((r) => r.runId)).toEqual(newestFirst.slice(0, 2));
    const second = repo.list({ cpId: "CP-A", limit: 2, offset: 2 });
    expect(second.runs.map((r) => r.runId)).toEqual(newestFirst.slice(2, 4));
    const past = repo.list({ cpId: "CP-A", limit: 2, offset: 10 });
    expect(past).toEqual({ runs: [], total: 5 });
  });

  it(`keeps at most ${MAX_RUNS_PER_CP} runs per charge point, evicting that CP's oldest`, () => {
    const repo = create();
    const other = run({ cpId: "CP-B" });
    repo.record(other);
    const runs = Array.from({ length: MAX_RUNS_PER_CP + 1 }, () => run());
    for (const r of runs) repo.record(r);

    expect(repo.list({ cpId: "CP-A" }).total).toBe(MAX_RUNS_PER_CP);
    expect(repo.get("CP-A", runs[0].runId)).toBeNull();
    expect(repo.get("CP-A", runs[1].runId)).not.toBeNull();
    // Another charge point's history is not collateral.
    expect(repo.get("CP-B", other.runId)).toEqual(other);
  });

  it("forgets a deleted charge point's runs, and everything on clear", () => {
    const repo = create();
    repo.record(run({ cpId: "CP-A" }));
    const kept = run({ cpId: "CP-B" });
    repo.record(kept);

    repo.deleteForChargePoint("CP-A");
    expect(repo.list({}).runs.map((r) => r.runId)).toEqual([kept.runId]);

    repo.clear();
    expect(repo.list({})).toEqual({ runs: [], total: 0 });
  });
});

describe("summarizeRun", () => {
  it("keeps the listing fields and drops the transcript", () => {
    const summary = summarizeRun(
      run({
        stopped: true,
        errors: ["boom"],
        timeout: { nodeId: "wait-1" },
        assertions: [
          {
            id: "a1",
            type: "ocpp_sent",
            status: "passed",
            description: "",
            severity: "failure",
          },
          {
            id: "a2",
            type: "ocpp_sent",
            status: "failed",
            description: "",
            severity: "failure",
          },
        ],
      }),
    );

    expect(summary).toMatchObject({
      stopped: true,
      errorCount: 1,
      timeoutNodeId: "wait-1",
      assertions: { total: 2, failed: 1 },
    });
    expect(summary).not.toHaveProperty("transcript");
  });

  it("reports stopped=false for a report written before the field existed", () => {
    expect(summarizeRun(run()).stopped).toBe(false);
  });
});

describe("SqliteScenarioRunRepository", () => {
  it("keeps the history across a close and reopen of the DB file", () => {
    const dir = mkdtempSync(join(tmpdir(), "scenario-runs-"));
    const path = join(dir, "state.db");
    try {
      const result = run();
      const first = BunSqliteDatabase.open(path);
      new SqliteScenarioRunRepository(first).record(result);
      first.close();

      const reopened = BunSqliteDatabase.open(path);
      opened.push(reopened);
      const repo = new SqliteScenarioRunRepository(reopened);
      expect(repo.get("CP-A", result.runId)).toEqual(result);
      expect(repo.list({}).runs.map((r) => r.runId)).toEqual([result.runId]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a row whose JSON no longer parses instead of failing the listing", () => {
    const db = BunSqliteDatabase.open(":memory:");
    opened.push(db);
    const repo = new SqliteScenarioRunRepository(db);
    const good = run();
    const bad = run();
    repo.record(good);
    repo.record(bad);
    db.run(
      "UPDATE scenario_runs SET summary_json = '{', report_json = '{' WHERE run_id = ?",
      [bad.runId],
    );

    expect(repo.list({}).runs.map((r) => r.runId)).toEqual([good.runId]);
    expect(repo.get("CP-A", bad.runId)).toBeNull();
  });
});
