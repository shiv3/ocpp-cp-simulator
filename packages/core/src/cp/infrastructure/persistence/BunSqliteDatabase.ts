import type { Database as BunDB } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

import type {
  Database,
  SqlParam,
  SqlRow,
} from "../../domain/persistence/Database";
import { runMigrations } from "./schema";

/**
 * `bun:sqlite` adapter. Daemon-only — imports the Bun built-in module and
 * therefore must never be reached from the browser bundle. The browser
 * uses {@link SqlJsDatabase} instead.
 *
 * Construction is via the static `open` factory:
 *   - `open(":memory:")` → ephemeral DB, dropped on process exit.
 *   - `open("/path/to/state.db")` → file-backed; the parent directory is
 *     created if missing so the user can pass any path without prepping it.
 *
 * `flush()` is a no-op because `bun:sqlite` writes through to disk (WAL
 * mode is enabled in the constructor so concurrent reads stay fast).
 *
 * `bun:sqlite` is loaded in `open()` (`process.getBuiltinModule`), not by a
 * static import, so a bundle that also runs on Node (#916) can contain this
 * file: Node refuses a `bun:` import while loading the bundle, before
 * `openSqliteDatabase` has picked the Node adapter.
 */
export class BunSqliteDatabase implements Database {
  private constructor(private readonly db: BunDB) {}

  static open(path: string): BunSqliteDatabase {
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (dir && dir !== "." && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    const db = new (loadBunSqlite().Database)(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    const adapter = new BunSqliteDatabase(db);
    runMigrations(adapter);
    return adapter;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: SqlParam[] = []): void {
    this.db.prepare(sql).run(...this.coerce(params));
  }

  all<T = SqlRow>(sql: string, params: SqlParam[] = []): T[] {
    return this.db.prepare(sql).all(...this.coerce(params)) as T[];
  }

  get<T = SqlRow>(sql: string, params: SqlParam[] = []): T | null {
    return (this.db.prepare(sql).get(...this.coerce(params)) as T) ?? null;
  }

  close(): void {
    this.db.close();
  }

  // `bun:sqlite` accepts booleans on recent versions, but normalising to
  // 0/1 keeps behaviour identical to the sql.js adapter where booleans
  // can't be bound directly.
  private coerce(params: SqlParam[]): SqlParam[] {
    return params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
  }
}

type BunSqliteModule = typeof import("bun:sqlite");

function loadBunSqlite(): BunSqliteModule {
  const mod = process.getBuiltinModule("bun:sqlite") as
    BunSqliteModule | undefined;
  if (!mod) throw new Error("bun:sqlite is only available on Bun");
  return mod;
}
