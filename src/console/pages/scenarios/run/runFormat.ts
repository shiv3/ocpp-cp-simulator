import type { ScenarioVerdict } from "../../../../cp/application/scenario/ScenarioTypes";

/** Verdict pill colours shared by the run history list and the run report. */
export const VERDICT_STYLES: Record<ScenarioVerdict, string> = {
  PASS: "border-cx-emerald/40 text-cx-emerald",
  FAIL: "border-cx-rose/40 text-cx-rose",
  BLOCKED: "border-cx-amber/40 text-cx-amber",
  SKIPPED: "border-cx-border-strong text-cx-fg2",
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
