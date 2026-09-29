/** The runtime's live execution states: a run in one of these is in flight
 *  (executing, parked waiting, paused or stepping) — there is something to
 *  Stop. Shared by the Active scenarios panel and the run page. */
export const LIVE_RUN_STATES = [
  "running",
  "paused",
  "stepping",
  "waiting",
] as const;
export type LiveRunState = (typeof LIVE_RUN_STATES)[number];

export function isLiveRunState(state: string): state is LiveRunState {
  return (LIVE_RUN_STATES as readonly string[]).includes(state);
}

/** Debounce for the `getScenarioStatus` re-query that follows a scenario
 *  lifecycle event — no event says a run is parked, so views re-query. */
export const STATUS_REFRESH_DEBOUNCE_MS = 200;

export const LIVE_RUN_STATE_STYLES: Record<LiveRunState, string> = {
  running: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  paused: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  stepping:
    "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  waiting: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};
