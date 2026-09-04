import type { Database } from "../../cp/domain/persistence/Database";

/**
 * The `watched_scenario_files` table (schema v12, #314): which file a scenario
 * was loaded from, when a `load_scenario { file }` / `run_scenario_file` RPC
 * loaded it.
 *
 * These live here rather than as private methods on `FileReloadManager` for one
 * reason, learned the hard way: **cleaning a row up must not depend on an
 * active watcher.** A row is a fact about stored state, not about `--watch`.
 * Behind the flag, a daemon restarted *without* `--watch` would leave a stale
 * row when a scenario was removed or replaced inline — and a later watched
 * restart would find it under the same id, reattach the abandoned file, and
 * overwrite the definition the operator installed in between. The RPC handlers
 * therefore call these directly whenever they have a database, whether or not
 * a reloader exists to consume the rows.
 */
export interface WatchedScenarioFileRow {
  readonly cp_id: string;
  readonly connector_id: number;
  readonly scenario_id: string;
  readonly path: string;
}

export function rememberWatchedScenarioFile(
  database: Database | null | undefined,
  cpId: string,
  connectorId: number,
  scenarioId: string,
  absolutePath: string,
): void {
  database?.run(
    "INSERT INTO watched_scenario_files (cp_id, connector_id, scenario_id, path) " +
      "VALUES (?, ?, ?, ?) ON CONFLICT (cp_id, connector_id, scenario_id) " +
      "DO UPDATE SET path = excluded.path",
    [cpId, connectorId, scenarioId, absolutePath],
  );
}

export function forgetWatchedScenarioFile(
  database: Database | null | undefined,
  cpId: string,
  connectorId: number,
  scenarioId: string,
): void {
  database?.run(
    "DELETE FROM watched_scenario_files " +
      "WHERE cp_id = ? AND connector_id = ? AND scenario_id = ?",
    [cpId, connectorId, scenarioId],
  );
}

export function forgetWatchedConnectorScenarioFiles(
  database: Database | null | undefined,
  cpId: string,
  connectorId: number,
): void {
  database?.run(
    "DELETE FROM watched_scenario_files WHERE cp_id = ? AND connector_id = ?",
    [cpId, connectorId],
  );
}

/**
 * Drop every row for a charge point. Called from `CPRegistry.persistRemove`, so
 * a `cp.delete` cascades here the way it already does to `scenarios` and
 * `connector_runtime`: without it a re-created charge point reusing the same id
 * would inherit watches on files it was never loaded from.
 */
export function forgetWatchedChargePointFiles(
  database: Database | null | undefined,
  cpId: string,
): void {
  database?.run("DELETE FROM watched_scenario_files WHERE cp_id = ?", [cpId]);
}

export function listWatchedScenarioFiles(
  database: Database | null | undefined,
): WatchedScenarioFileRow[] {
  return (
    database?.all<WatchedScenarioFileRow>(
      "SELECT cp_id, connector_id, scenario_id, path FROM watched_scenario_files",
    ) ?? []
  );
}
