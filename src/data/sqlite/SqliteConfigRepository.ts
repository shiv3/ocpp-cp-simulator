import type { Database } from "../../cp/domain/persistence/Database";
import type { ConfigRepository } from "../interfaces/ConfigRepository";
import type { Config } from "../../store/store";

const CONFIG_KEY = "global_config";

/**
 * SQLite-backed ConfigRepository. The previous LocalConfigRepository
 * pushed the global app `Config` through a Jotai atom whose backing was
 * `atomWithStorage("config")` — that observability shape was nice for
 * React, but a Jotai atom isn't a portable persistence target.
 *
 * We replicate the subscribe contract with a simple listener Set and
 * round-trip the JSON through a single `kv` row. There's only ever one
 * global config so a single key suffices.
 */
export class SqliteConfigRepository implements ConfigRepository {
  private readonly listeners = new Set<(config: Config | null) => void>();
  // In-memory cache so save→load works in the no-DB (remote) path without
  // forcing UI to refetch.
  private cached: Config | null = null;
  private cacheValid = false;

  constructor(private readonly db: Database | null) {}

  async load(): Promise<Config | null> {
    if (!this.db) {
      return this.cacheValid ? this.cached : null;
    }
    const row = this.db.get<{ value: string }>(
      "SELECT value FROM kv WHERE key = ?",
      [CONFIG_KEY],
    );
    if (!row) return null;
    try {
      return JSON.parse(row.value) as Config;
    } catch {
      return null;
    }
  }

  async save(config: Config | null): Promise<void> {
    if (!this.db) {
      this.cached = config;
      this.cacheValid = true;
      this.notify(config);
      return;
    }
    if (config === null) {
      this.db.run("DELETE FROM kv WHERE key = ?", [CONFIG_KEY]);
    } else {
      this.db.run(
        "INSERT INTO kv (key, value) VALUES (?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [CONFIG_KEY, JSON.stringify(config)],
      );
    }
    this.notify(config);
  }

  subscribe(handler: (config: Config | null) => void): () => void {
    this.listeners.add(handler);
    void this.load().then(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  private notify(config: Config | null): void {
    this.listeners.forEach((handler) => {
      try {
        handler(config);
      } catch (error) {
        console.error("[SqliteConfigRepository] listener error", error);
      }
    });
  }
}
