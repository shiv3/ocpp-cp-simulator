import { describe, expect, it } from "vitest";

import type { ScenarioRunSummary } from "../../cp/application/verification/ScenarioRunSummary";
import { scenarioRunSummary } from "../../test/scenarioRunFixtures";
import { mergeRunHistory, runRowKey, summaryToRow } from "./runHistoryRows";
import type { ScenarioRunHistoryEntry } from "./useScenarioRun";

function summary(
  overrides: Partial<ScenarioRunSummary> = {},
): ScenarioRunSummary {
  return { ...scenarioRunSummary(), ...overrides };
}

describe("summaryToRow (#388)", () => {
  it("reads the result from the execution state and the stopped flag", () => {
    expect(summaryToRow(summary()).result).toBe("completed");
    expect(summaryToRow(summary({ stopped: true })).result).toBe("stopped");
    expect(
      summaryToRow(summary({ executionState: "error", stopped: true })).result,
    ).toBe("error");
  });

  it("keys a row by charge point and runId, which is unique per charge point only", () => {
    const a = summaryToRow(summary({ cpId: "CP-1" }));
    const b = summaryToRow(summary({ cpId: "CP-2" }));
    expect(a.runId).toBe(b.runId);
    expect(a.key).not.toBe(b.key);
    expect(a.key).toBe(runRowKey("CP-1", "s1#1"));
  });

  it("carries the recorded times, the timeout node and the summary", () => {
    const recorded = summary({ timeoutNodeId: "wait-1" });
    const row = summaryToRow(recorded);
    expect(row).toMatchObject({
      runId: "s1#1",
      failedNodeId: "wait-1",
      summary: recorded,
    });
    expect(row.startedAt.toISOString()).toBe(recorded.startedAt);
    expect(row.endedAt?.toISOString()).toBe(recorded.endedAt);
  });
});

describe("mergeRunHistory (#388)", () => {
  const live: ScenarioRunHistoryEntry = {
    startedAt: new Date("2026-09-30T09:00:00.000Z"),
    endedAt: null,
    result: "running",
    runId: "s1#2",
  };

  it("lists the recorded runs when the page tracked none", () => {
    const rows = mergeRunHistory([], [summary()]);
    expect(rows.map((r) => r.runId)).toEqual(["s1#1"]);
  });

  it("puts the live run on top of the recorded history", () => {
    const rows = mergeRunHistory([live], [summary()]);
    expect(rows.map((r) => [r.runId, r.result])).toEqual([
      ["s1#2", "running"],
      ["s1#1", "completed"],
    ]);
    expect(rows[0].summary).toBeUndefined();
  });

  it("keeps the live run on top even when its clock is behind the daemon's", () => {
    const skewed: ScenarioRunHistoryEntry = {
      ...live,
      startedAt: new Date("2026-09-30T07:59:00.000Z"),
    };
    const rows = mergeRunHistory([skewed], [summary()]);
    expect(rows.map((r) => r.result)).toEqual(["running", "completed"]);
  });

  it("shows a run once, as recorded, when the page also tracked it", () => {
    const tracked: ScenarioRunHistoryEntry = {
      startedAt: new Date("2026-09-30T08:00:00.100Z"),
      endedAt: new Date("2026-09-30T08:00:05.000Z"),
      result: "completed",
      runId: "s1#1",
    };
    const rows = mergeRunHistory([tracked], [summary()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary?.runId).toBe("s1#1");
  });

  it("keeps a tracked run that has no runId (a start that failed)", () => {
    const failedStart: ScenarioRunHistoryEntry = {
      startedAt: new Date("2026-09-30T07:00:00.000Z"),
      endedAt: new Date("2026-09-30T07:00:00.000Z"),
      result: "error",
    };
    const rows = mergeRunHistory([failedStart], [summary()]);
    expect(rows.map((r) => r.result)).toEqual(["completed", "error"]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
});
