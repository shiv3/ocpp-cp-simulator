import React from "react";

import { cn } from "@/lib/utils";
import type { ScenarioRunHistoryEntry } from "../../../lib/useScenarioRun";

export interface RunHistoryProps {
  runs: ScenarioRunHistoryEntry[];
}

const RESULT_STYLES: Record<ScenarioRunHistoryEntry["result"], string> = {
  running: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  completed:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  stopped: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  error: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

function formatDuration(startedAt: Date, endedAt: Date | null): string {
  const end = endedAt ?? new Date();
  const ms = Math.max(0, end.getTime() - startedAt.getTime());
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Session-local run history — one row per `start()` call on this page view,
 * newest first (see `useScenarioRun`'s `runs`). Cleared when the viewed
 * scenario/target changes; never persisted.
 */
const RunHistory: React.FC<RunHistoryProps> = ({ runs }) => {
  if (runs.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No runs yet this session.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {runs.map((run, index) => (
        <li
          key={`${run.startedAt.toISOString()}-${index}`}
          className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm dark:border-gray-800"
        >
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-semibold",
                RESULT_STYLES[run.result],
              )}
            >
              {run.result}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {run.startedAt.toLocaleTimeString()}
            </span>
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {formatDuration(run.startedAt, run.endedAt)}
            {run.failedNodeId ? ` · node ${run.failedNodeId}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
};

export default RunHistory;
