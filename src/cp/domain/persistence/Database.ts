/**
 * Domain-level SQL database abstraction.
 *
 * Two adapters target the same shape:
 *   - `BunSqliteDatabase`  (CLI / daemon, `bun:sqlite`)
 *   - `SqlJsDatabase`      (browser, sql.js + IndexedDB)
 *
 * The interface is intentionally narrow — `exec/run/all/get/close/flush` —
 * so domain modules can hold a `Database` reference without caring whether
 * it lives in WASM (browser) or in `bun:sqlite` (daemon). All SQL
 * statements are plain SQLite dialect; both adapters accept the same
 * placeholder syntax (positional `?`).
 *
 * Transaction handling is deliberately omitted. Domain code currently
 * issues a small number of single-row writes per event; if/when we need
 * multi-statement atomicity, we'll add a `transaction(fn)` helper.
 */
export interface Database {
  /** Run one or more semicolon-separated DDL/DML statements with no
   *  parameters. Used for schema creation and pragma setup. */
  exec(sql: string): void;

  /** INSERT / UPDATE / DELETE with positional parameters. */
  run(sql: string, params?: SqlParam[]): void;

  /** SELECT returning every row. */
  all<T = SqlRow>(sql: string, params?: SqlParam[]): T[];

  /** SELECT returning the first row or null. */
  get<T = SqlRow>(sql: string, params?: SqlParam[]): T | null;

  /** Release underlying resources. After close() further calls throw. */
  close(): void;

  /**
   * Persist any pending in-memory changes. The browser adapter exports the
   * sql.js database to a Uint8Array and writes it to IndexedDB; the daemon
   * adapter is a no-op (`bun:sqlite` writes through to disk synchronously).
   * Callers may `await flush()` whenever they need to be sure data has
   * survived a crash/reload, but most write sites can fire-and-forget — the
   * browser adapter debounces internally.
   */
  flush?(): Promise<void>;
}

export type SqlParam = string | number | boolean | null | Uint8Array;
export type SqlRow = Record<string, unknown>;
