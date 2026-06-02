import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type { Database } from "../../cp/domain/persistence/Database";
import type { ScenarioRepository } from "../interfaces/ScenarioRepository";

/**
 * SQLite-backed scenario repository. Persists definitions verbatim as a
 * JSON blob in the `scenarios` table, keyed by (cp_id, connector_id,
 * scenario_id). The interface allows multiple scenarios per
 * (cp, connector); `load()` returns the most-recently-updated one to
 * preserve the previous LocalScenarioRepository's "one active scenario"
 * contract that downstream UI code relies on.
 *
 * `connectorId = null` represents a charge-point-level scenario; we
 * collapse it to `0` in the column to keep the column NOT NULL and to
 * line up with OCPP's connectorId=0 (CP main controller) convention.
 *
 * Subscribers are notified in-memory after every `save`/`delete`; the
 * subscribe contract mirrors LocalScenarioRepository so existing consumers
 * keep working without changes.
 */
export class SqliteScenarioRepository implements ScenarioRepository {
  private readonly listeners = new Map<
    string,
    Set<(scenario: ScenarioDefinition | null) => void>
  >();

  // `db === null` is the remote-mode path: the daemon owns scenarios and
  // serves them via ChargePointService.listScenarios. Browsers in that
  // mode shouldn't load sql.js just to mirror the same state locally, so
  // every method here no-ops / returns empty when there's no DB.
  constructor(private readonly db: Database | null) {}

  async load(
    chargePointId: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition | null> {
    if (!this.db) return null;
    const row = this.db.get<{ definition: string }>(
      "SELECT definition FROM scenarios " +
        "WHERE cp_id = ? AND connector_id = ? " +
        "ORDER BY updated_at DESC LIMIT 1",
      [chargePointId, connectorId ?? 0],
    );
    return row ? (JSON.parse(row.definition) as ScenarioDefinition) : null;
  }

  async save(
    chargePointId: string,
    connectorId: number | null,
    scenario: ScenarioDefinition,
  ): Promise<void> {
    if (!this.db) {
      // Still fan out to subscribers so UI in remote mode reacts to
      // in-session saves; just don't persist anything.
      this.notify(chargePointId, connectorId, scenario);
      return;
    }
    const updatedAt = scenario.updatedAt ?? new Date().toISOString();
    this.db.run(
      "INSERT INTO scenarios " +
        "(cp_id, connector_id, scenario_id, name, enabled, updated_at, definition) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (cp_id, connector_id, scenario_id) DO UPDATE SET " +
        "name = excluded.name, " +
        "enabled = excluded.enabled, " +
        "updated_at = excluded.updated_at, " +
        "definition = excluded.definition",
      [
        chargePointId,
        connectorId ?? 0,
        scenario.id,
        scenario.name,
        scenario.enabled ? 1 : 0,
        updatedAt,
        JSON.stringify(scenario),
      ],
    );
    this.notify(chargePointId, connectorId, scenario);
  }

  async delete(
    chargePointId: string,
    connectorId: number | null,
  ): Promise<void> {
    if (this.db) {
      this.db.run(
        "DELETE FROM scenarios WHERE cp_id = ? AND connector_id = ?",
        [chargePointId, connectorId ?? 0],
      );
    }
    this.notify(chargePointId, connectorId, null);
  }

  async list(chargePointId: string): Promise<ScenarioDefinition[]> {
    if (!this.db) return [];
    const rows = this.db.all<{ definition: string }>(
      "SELECT definition FROM scenarios WHERE cp_id = ? ORDER BY updated_at DESC",
      [chargePointId],
    );
    return rows.map((r) => JSON.parse(r.definition) as ScenarioDefinition);
  }

  /**
   * List every scenario stored for a single (cp_id, connector_id) pair.
   * Used by the daemon to rehydrate per-connector scenarios on startup
   * and to expose `list_scenarios` over the JSON command channel.
   * `connectorId = null` maps to the column value `0` (cp-level slot),
   * matching `save()` / `delete()`.
   */
  listByConnector(
    chargePointId: string,
    connectorId: number | null,
  ): ScenarioDefinition[] {
    if (!this.db) return [];
    const rows = this.db.all<{ definition: string }>(
      "SELECT definition FROM scenarios " +
        "WHERE cp_id = ? AND connector_id = ? " +
        "ORDER BY updated_at DESC",
      [chargePointId, connectorId ?? 0],
    );
    return rows.map((r) => JSON.parse(r.definition) as ScenarioDefinition);
  }

  /**
   * Delete a single scenario row by composite key. The interface's
   * `delete(cpId, connectorId)` wipes the whole connector slot, which is
   * wrong for the daemon — operators expect "drop scenario X" to leave
   * sibling scenarios on the same connector intact.
   */
  deleteOne(
    chargePointId: string,
    connectorId: number | null,
    scenarioId: string,
  ): void {
    if (!this.db) return;
    this.db.run(
      "DELETE FROM scenarios " +
        "WHERE cp_id = ? AND connector_id = ? AND scenario_id = ?",
      [chargePointId, connectorId ?? 0, scenarioId],
    );
  }

  subscribe(
    chargePointId: string,
    connectorId: number | null,
    handler: (scenario: ScenarioDefinition | null) => void,
  ): () => void {
    const key = keyOf(chargePointId, connectorId);
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(handler);
    this.listeners.set(key, listeners);

    void this.load(chargePointId, connectorId).then((value) => handler(value));

    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  private notify(
    chargePointId: string,
    connectorId: number | null,
    scenario: ScenarioDefinition | null,
  ): void {
    const listeners = this.listeners.get(keyOf(chargePointId, connectorId));
    if (!listeners) return;
    listeners.forEach((listener) => {
      try {
        listener(scenario);
      } catch (error) {
        console.error("[SqliteScenarioRepository] listener error", error);
      }
    });
  }
}

function keyOf(chargePointId: string, connectorId: number | null): string {
  return `${chargePointId}::${connectorId ?? "cp"}`;
}
