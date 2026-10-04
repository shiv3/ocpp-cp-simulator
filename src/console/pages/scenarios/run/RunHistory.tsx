import React from "react";

import { cn } from "@/lib/utils";
import RunStatePill from "../../../components/RunStatePill";
import type { RunHistoryRow } from "../../../lib/runHistoryRows";
import { formatDuration, formatDurationMs, VERDICT_STYLES } from "./runFormat";

export interface RunHistoryProps {
  rows: RunHistoryRow[];
  /** Shown when there are no rows. */
  emptyText: string;
  /** Highlights the row with this key (`runRowKey` for a recorded run). */
  selectedKey?: string | null;
  /** Makes recorded rows clickable (their report can be opened). */
  onSelect?: (row: RunHistoryRow) => void;
  /** Also show the charge point, connector and scenario of each run — for a
   *  list that spans targets. */
  showTarget?: boolean;
}

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
  selectedKey,
  onSelect,
  showTarget = false,
}) => {
  if (rows.length === 0) {
    return <p className="text-sm text-cx-muted">{emptyText}</p>;
  }

  return (
    <ul className="space-y-1.5">
      {rows.map((row) => {
        const selectable = !!row.summary && !!onSelect;
        const selected = row.key === selectedKey;
        const content = (
          <>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <RunStatePill state={row.result} />
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
                  className="rounded-full border border-cx-border-strong px-2 py-0.5 text-xs text-cx-fg2"
                  title="Started outside this page"
                >
                  attached
                </span>
              )}
              {showTarget && row.summary && (
                <span className="truncate text-xs text-cx-fg2">
                  {row.summary.cpId} · C{row.summary.connectorId} ·{" "}
                  {row.summary.scenarioName ?? row.summary.scenarioId}
                </span>
              )}
              <span className="text-xs text-cx-muted">
                {row.startedAt.toLocaleString()}
              </span>
            </span>
            <span className="shrink-0 text-xs text-cx-muted">
              {row.summary
                ? formatDurationMs(row.summary.durationMs)
                : formatDuration(row.startedAt, row.endedAt)}
              {row.failedNodeId ? ` · node ${row.failedNodeId}` : ""}
            </span>
          </>
        );
        const className = cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm",
          selected ? "border-cx-accent bg-cx-sel" : "border-cx-border",
        );
        return (
          <li key={row.key}>
            {selectable ? (
              <button
                type="button"
                data-run-id={row.runId}
                data-cp-id={row.summary?.cpId}
                aria-pressed={selected}
                className={cn(className, "hover:bg-cx-sub")}
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
