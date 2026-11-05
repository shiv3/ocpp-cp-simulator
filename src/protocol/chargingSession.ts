// Charging-session history vocabulary (#447): the outcomes `sessions.list`
// filters on and the per-charge-point retention bound. The full session model
// lives in `cp/domain/session/ChargingSession.ts`.

export const CHARGING_SESSION_OUTCOMES = [
  "active",
  "completed",
  "interrupted",
  "failed",
] as const;

/** Sessions kept per charge point; see `ChargingSessionRepository`. */
export const MAX_SESSIONS_PER_CP = 500;
