import React from "react";

import { cn } from "@/lib/utils";
import type { RunHistoryRow } from "../../../lib/runHistoryRows";
import { formatDuration, formatDurationMs, VERDICT_STYLES } from "./runFormat";

export interface RunHistoryProps {
  rows: RunHistoryRow[];
  /** Shown when there are no rows. */
  emptyText: string;
  /** Highlights this run's row. */
  selectedRunId?: string | null;
  /** Makes recorded rows clickable (their report can be opened). */
  onSelect?: (row: RunHistoryRow) => void;
  /** Also show the charge point, connector and scenario of each run — for a
   *  list that spans targets. */
  showTarget?: boolean;
}

const RESULT_STYLES: Record<RunHistoryRow["result"], string> = {
  running: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  completed:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  stopped: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  error: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

/**
 * A scenario run history list, newest first (#388): the daemon's recorded
 * runs, plus — on the run page — the runs the page tracked that are not
 * recorded yet (see `mergeRunHistory`). A recorded row carries its verdict
 * and, with `onSelect`, opens its report. An "attached" run (#366) is one the
 * page picked up already live: its time counts from the attach.
 */
const RunHistory: React.FC<RunHistoryProps> = ({
  rows,
  emptyText,
  selectedRunId,
  onSelect,
  showTarget = false,
}) => {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">{emptyText}</p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {rows.map((row) => {
        const selectable = !!row.summary && !!onSelect;
        const selected = !!row.runId && row.runId === selectedRunId;
        const content = (
          <>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-semibold",
                  RESULT_STYLES[row.result],
                )}
              >
                {row.result}
              </span>
              {row.summary && (
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs font-semibold",
                    VERDICT_STYLES[row.summary.verdict],
                  )}
                  title="Verdict"
                >
                  {row.summary.verdict}
                </span>
              )}
              {row.attached && (
                <span
                  className="rounded-full border border-gray-300 px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300"
                  title="Started outside this page"
                >
                  attached
                </span>
              )}
              {showTarget && row.summary && (
                <span className="truncate text-xs text-gray-700 dark:text-gray-200">
                  {row.summary.cpId} · C{row.summary.connectorId} ·{" "}
                  {row.summary.scenarioName ?? row.summary.scenarioId}
                </span>
              )}
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {row.startedAt.toLocaleString()}
              </span>
            </span>
            <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
              {row.summary
                ? formatDurationMs(row.summary.durationMs)
                : formatDuration(row.startedAt, row.endedAt)}
              {row.failedNodeId ? ` · node ${row.failedNodeId}` : ""}
            </span>
          </>
        );
        const className = cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm",
          selected
            ? "border-blue-400 bg-blue-50 dark:border-blue-700 dark:bg-blue-950"
            : "border-gray-200 dark:border-gray-800",
        );
        return (
          <li key={row.key}>
            {selectable ? (
              <button
                type="button"
                data-run-id={row.runId}
                aria-pressed={selected}
                className={cn(
                  className,
                  "hover:bg-gray-50 dark:hover:bg-gray-900",
                )}
                onClick={() => onSelect(row)}
              >
                {content}
              </button>
            ) : (
              <div className={className}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
};

export default RunHistory;
