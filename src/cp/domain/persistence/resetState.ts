import type { Database } from "./Database";

/**
 * Truncate every simulator-owned table in the given database. The schema
 * itself is left in place; `schema_meta` is also preserved so the next
 * boot doesn't re-run migrations against an empty slate.
 *
 * Used by the Settings "Reset all simulator data" button (browser) and the
 * `POST /v1/state/reset` endpoint (daemon). Caller is expected to drop
 * any in-memory caches (ChargePoint instances, repositories' subscriber
 * notifications) afterwards — easiest path is a UI reload.
 */
export function resetSimulatorState(db: Database): void {
  // Order doesn't matter (no FKs declared), but keep it stable for the
  // log line and ease of diffing.
  const tables = [
    "scenarios",
    // #314: daemon-only, but simulator-owned all the same. Left out, a reset
    // cleared every scenario and left the rows saying where they came from, so
    // a later watched restart reattached files for scenarios that no longer
    // exist. `state.reset` promises to truncate every simulator-owned table.
    "watched_scenario_files",
    "connector_settings",
    "charging_profiles",
    "configuration",
    "pending_messages",
    "logs",
    "charge_points",
    "charge_point_state",
    "kv",
  ];
  for (const table of tables) {
    try {
      db.run(`DELETE FROM ${table}`);
    } catch {
      // Table may not exist on older DBs that pre-date a new entity —
      // ignore so a reset on a partial schema still completes cleanly.
    }
  }
}
