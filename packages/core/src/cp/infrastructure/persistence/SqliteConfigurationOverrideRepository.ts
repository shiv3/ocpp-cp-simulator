import type {
  ConfigurationOverrideRepository,
  StoredConfigurationOverride,
} from "../../domain/persistence/ConfigurationOverrideRepository";
import type { Database } from "../../domain/persistence/Database";

/** One charge point's rows of the `configuration` table (#878). */
export class SqliteConfigurationOverrideRepository implements ConfigurationOverrideRepository {
  constructor(
    private readonly chargePointId: string,
    private readonly database: Database,
  ) {}

  loadAll(): StoredConfigurationOverride[] {
    return this.database.all<{ key: string; value: string }>(
      "SELECT key, value FROM configuration WHERE cp_id = ?",
      [this.chargePointId],
    );
  }

  get(key: string): string | null {
    const row = this.database.get<{ value: string }>(
      "SELECT value FROM configuration WHERE cp_id = ? AND key = ?",
      [this.chargePointId, key],
    );
    return row ? row.value : null;
  }

  save(key: string, value: string): void {
    this.database.run(
      "INSERT INTO configuration (cp_id, key, value) VALUES (?, ?, ?) " +
        "ON CONFLICT (cp_id, key) DO UPDATE SET value = excluded.value",
      [this.chargePointId, key, value],
    );
  }
}
