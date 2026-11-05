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

/** `bg-*` class of the dot that carries a run state (RunStatePill). */
export const LIVE_RUN_STATE_STYLES: Record<LiveRunState, string> = {
  running: "bg-cx-blue",
  paused: "bg-cx-gray",
  stepping: "bg-cx-purple",
  waiting: "bg-cx-amber",
};
