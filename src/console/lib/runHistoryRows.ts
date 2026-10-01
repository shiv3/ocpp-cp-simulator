import type { ScenarioRunSummary } from "../../cp/application/verification/ScenarioRunSummary";
import type { ScenarioRunHistoryEntry } from "./useScenarioRun";

/** One line of a run history list: a run the page tracked itself, or one
 *  from the daemon's recorded history (#388). */
export interface RunHistoryRow {
  key: string;
  result: ScenarioRunHistoryEntry["result"];
  startedAt: Date;
  endedAt: Date | null;
  runId?: string;
  failedNodeId?: string;
  attached?: boolean;
  /** Set when the daemon recorded the run: its report can be opened. */
  summary?: ScenarioRunSummary;
}

/** A recorded run's identity: a runId is unique per charge point only. */
export function runRowKey(cpId: string, runId: string): string {
  return JSON.stringify([cpId, runId]);
}

export function summaryToRow(summary: ScenarioRunSummary): RunHistoryRow {
  return {
    key: runRowKey(summary.cpId, summary.runId),
    result:
      summary.executionState === "error"
        ? "error"
        : summary.stopped
          ? "stopped"
          : "completed",
    startedAt: new Date(summary.startedAt),
    endedAt: new Date(summary.endedAt),
    runId: summary.runId,
    failedNodeId: summary.timeoutNodeId ?? undefined,
    summary,
  };
}

/**
 * The run page's history: the daemon's recorded runs, plus the runs this page
 * tracked that are not recorded (yet) — the live one, a start that failed
 * before it got a runId, or every run in local mode, which records none. A
 * run in both lists shows once, as recorded. Newest first, the live run on
 * top.
 */
export function mergeRunHistory(
  tracked: ScenarioRunHistoryEntry[],
  recorded: ScenarioRunSummary[],
): RunHistoryRow[] {
  const recordedIds = new Set(recorded.map((r) => r.runId));
  const trackedRows: RunHistoryRow[] = tracked
    .filter((entry) => !entry.runId || !recordedIds.has(entry.runId))
    .map((entry, index) => ({
      ...entry,
      key: entry.runId ?? `tracked-${entry.startedAt.toISOString()}-${index}`,
    }));
  // A live run ranks first whatever its time says: it is stamped by the
  // browser's clock, the recorded runs by the daemon's.
  const live = (row: RunHistoryRow) => (row.result === "running" ? 1 : 0);
  return [...trackedRows, ...recorded.map(summaryToRow)].sort(
    (a, b) =>
      live(b) - live(a) || b.startedAt.getTime() - a.startedAt.getTime(),
  );
}
