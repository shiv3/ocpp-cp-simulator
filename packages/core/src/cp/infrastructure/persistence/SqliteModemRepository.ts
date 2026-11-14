import type { Database } from "../../domain/persistence/Database";
import type { ModemRepository } from "../../domain/persistence/ModemRepository";

/** One charge point's `modem:<cpId>` row of the `kv` table (#928). */
export class SqliteModemRepository implements ModemRepository {
  private readonly key: string;

  constructor(
    chargePointId: string,
    private readonly database: Database,
  ) {
    this.key = `modem:${chargePointId}`;
  }

  load(): string | null {
    const row = this.database.get<{ value: string }>(
      "SELECT value FROM kv WHERE key = ?",
      [this.key],
    );
    return row ? row.value : null;
  }

  save(document: string): void {
    this.database.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [this.key, document],
    );
  }

  delete(): void {
    this.database.run("DELETE FROM kv WHERE key = ?", [this.key]);
  }
}
