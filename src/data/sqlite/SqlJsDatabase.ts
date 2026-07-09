import initSqlJs, { type Database as SqlJsBackingDb } from "sql.js";
// Import the WASM file as a vite URL asset so the bundler fingerprints it
// and we don't have to maintain a `public/sql-wasm*.wasm` copy. The JS
// wrapper inside sql.js otherwise tries to fetch `sql-wasm-browser.wasm`
// at its own guessed path, which fails in production builds.
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

import type {
  Database,
  SqlParam,
  SqlRow,
} from "../../cp/domain/persistence/Database";
import { runMigrations } from "../../cp/domain/persistence/schema";
import { createDurableFlusher } from "./durableFlush";
import { loadBlob, saveBlob } from "./IndexedDbBlobStore";

/**
 * Browser-side adapter for the domain `Database` interface, backed by
 * sql.js (WASM SQLite) for the query engine and IndexedDB for durable
 * storage of the underlying binary.
 *
 * Lifecycle:
 *   1. `create()` resolves once the WASM is loaded and the schema is
 *      ensured. It first tries to restore the DB from IndexedDB; failing
 *      that, it starts from an empty DB and runs migrations.
 *   2. Subsequent `run`/`exec` calls operate in-memory.
 *   3. Every write schedules a debounced `flush()` — exports the in-memory
 *      DB to a `Uint8Array` and writes it back to IndexedDB. The debounce
 *      keeps a flurry of writes (e.g. a scenario tick storm) to one IDB
 *      transaction.
 *   4. `flush()` can also be awaited explicitly when a caller cares about
 *      durability (e.g. before unload).
 *
 * The WASM file ships at `/sql-wasm.wasm` (copied from `public/`), and
 * `locateFile` returns that path. Hosting under a non-root base path is
 * handled by `import.meta.env.BASE_URL` so GitHub Pages deployments work
 * unchanged.
 */
export class SqlJsDatabase implements Database {
  private flushHandle: ReturnType<typeof setTimeout> | null = null;
  // Never drops writes that land while an earlier save is still in flight
  // (#101). The arrow reads `this.db` lazily (at flush time), so it's safe to
  // build during field init before the constructor assigns `db`.
  private readonly durableFlush = createDurableFlusher(
    () => this.db.export(),
    saveBlob,
  );
  private static readonly FLUSH_DEBOUNCE_MS = 200;

  private constructor(private db: SqlJsBackingDb) {}

  static async create(): Promise<SqlJsDatabase> {
    // Whatever filename the sql.js wrapper asks for
    // (`sql-wasm.wasm` / `sql-wasm-browser.wasm`), point it at the single
    // fingerprinted URL vite emitted for us. The bytes are identical.
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });

    const existing = await loadBlob();
    const db = existing ? new SQL.Database(existing) : new SQL.Database();
    const adapter = new SqlJsDatabase(db);
    runMigrations(adapter);
    // If we just initialised an empty DB, flush immediately so the schema
    // is on disk even before the first user-driven write.
    if (!existing) await adapter.flush();
    return adapter;
  }

  exec(sql: string): void {
    this.db.exec(sql);
    this.scheduleFlush();
  }

  run(sql: string, params: SqlParam[] = []): void {
    this.db.run(sql, this.coerce(params));
    this.scheduleFlush();
  }

  all<T = SqlRow>(sql: string, params: SqlParam[] = []): T[] {
    const stmt = this.db.prepare(sql, this.coerce(params));
    try {
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  get<T = SqlRow>(sql: string, params: SqlParam[] = []): T | null {
    const stmt = this.db.prepare(sql, this.coerce(params));
    try {
      return stmt.step() ? (stmt.getAsObject() as unknown as T) : null;
    } finally {
      stmt.free();
    }
  }

  close(): void {
    if (this.flushHandle) clearTimeout(this.flushHandle);
    this.flushHandle = null;
    this.db.close();
  }

  /**
   * Export the in-memory DB to IndexedDB. Delegates to {@link createDurableFlusher},
   * which guarantees the current state reaches storage even when a previous
   * save is still in flight — so an awaited `flush()` never resolves while the
   * newest writes are still only in memory (#101).
   */
  flush(): Promise<void> {
    // The durable flusher always persists the current state, so any pending
    // debounce timer is redundant once we're flushing explicitly.
    if (this.flushHandle) {
      clearTimeout(this.flushHandle);
      this.flushHandle = null;
    }
    return this.durableFlush();
  }

  private scheduleFlush(): void {
    if (this.flushHandle) clearTimeout(this.flushHandle);
    this.flushHandle = setTimeout(() => {
      this.flushHandle = null;
      void this.flush();
    }, SqlJsDatabase.FLUSH_DEBOUNCE_MS);
  }

  // sql.js refuses booleans; coerce upfront so callers can pass them
  // freely (mirrors the BunSqliteDatabase coercion).
  private coerce(params: SqlParam[]): (string | number | null | Uint8Array)[] {
    return params.map((p) =>
      typeof p === "boolean" ? (p ? 1 : 0) : (p as never),
    );
  }
}
