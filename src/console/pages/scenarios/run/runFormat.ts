import type { ScenarioVerdict } from "../../../../cp/application/scenario/ScenarioTypes";

/** Verdict pill colours shared by the run history list and the run report. */
export const VERDICT_STYLES: Record<ScenarioVerdict, string> = {
  PASS: "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300",
  FAIL: "border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300",
  BLOCKED:
    "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300",
  SKIPPED:
    "border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-300",
};

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Elapsed time of a run the page tracks; an open run counts up to now. */
export function formatDuration(startedAt: Date, endedAt: Date | null): string {
  const end = endedAt ?? new Date();
  return formatDurationMs(Math.max(0, end.getTime() - startedAt.getTime()));
}
