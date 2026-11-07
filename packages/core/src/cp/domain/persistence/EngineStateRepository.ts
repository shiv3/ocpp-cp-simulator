import type { Database } from "./Database";

/**
 * The charger engine's state between runs (see `engine_state` in the schema):
 * one JSON document per charge point. The repository stores text; reading it
 * back into a state is `parsePersistedEngineState`.
 */
export interface EngineStateRepository {
  load(cpId: string): unknown;
  save(cpId: string, state: unknown): void;
}

export class SqliteEngineStateRepository implements EngineStateRepository {
  constructor(private readonly database: Database) {}

  /** The stored document, or `null` if none or if it is not valid JSON. */
  load(cpId: string): unknown {
    const row = this.database.get<{ state_json: string }>(
      "SELECT state_json FROM engine_state WHERE cp_id = ?",
      [cpId],
    );
    if (!row) return null;
    try {
      return JSON.parse(row.state_json) as unknown;
    } catch {
      return null;
    }
  }

  save(cpId: string, state: unknown): void {
    this.database.run(
      "INSERT INTO engine_state (cp_id, state_json, updated_at) " +
        "VALUES (?, ?, ?) ON CONFLICT (cp_id) DO UPDATE SET " +
        "state_json = excluded.state_json, updated_at = excluded.updated_at",
      [cpId, JSON.stringify(state), new Date().toISOString()],
    );
  }
}
