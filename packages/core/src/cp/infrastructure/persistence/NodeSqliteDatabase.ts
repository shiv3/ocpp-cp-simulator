import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type {
  Database,
  SqlParam,
  SqlRow,
} from "../../domain/persistence/Database";
import { runMigrations } from "./schema";

/**
 * `node:sqlite` adapter (#916): the daemon's state DB when the CLI runs on
 * Node (>= 22.13). Same contract as {@link BunSqliteDatabase} — the same
 * file can be opened by either runtime. Daemon-only, like the Bun adapter;
 * pick one with `openSqliteDatabase`.
 *
 * `node:sqlite` is loaded on first `open()`, through
 * `process.getBuiltinModule`, so its one-time "SQLite is an experimental
 * feature" warning can be filtered: it is noise on every daemon start and,
 * written to stderr, would land in JSON Lines consumers' error logs.
 */
export class NodeSqliteDatabase implements Database {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): NodeSqliteDatabase {
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (dir && dir !== "." && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    const { DatabaseSync: NodeDB } = loadNodeSqlite();
    const db = new NodeDB(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    const adapter = new NodeSqliteDatabase(db);
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
    return this.db
      .prepare(sql)
      .all(...this.coerce(params))
      .map((row) => ({ ...row }) as T);
  }

  get<T = SqlRow>(sql: string, params: SqlParam[] = []): T | null {
    const row = this.db.prepare(sql).get(...this.coerce(params));
    // Rows come back with a null prototype; hand out plain objects like
    // bun:sqlite does.
    return row === undefined ? null : ({ ...row } as T);
  }

  close(): void {
    this.db.close();
  }

  // node:sqlite refuses booleans; 0/1 matches the Bun and sql.js adapters.
  private coerce(params: SqlParam[]): SQLInputValue[] {
    return params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
  }
}

type NodeSqliteModule = typeof import("node:sqlite");

let nodeSqlite: NodeSqliteModule | null = null;

function loadNodeSqlite(): NodeSqliteModule {
  if (nodeSqlite) return nodeSqlite;
  const mod = withoutSqliteExperimentalWarning(
    () =>
      process.getBuiltinModule("node:sqlite") as NodeSqliteModule | undefined,
  );
  if (!mod) {
    throw new Error(
      "node:sqlite is not available in this runtime; the state DB needs Node >= 22.13 or Bun",
    );
  }
  nodeSqlite = mod;
  return mod;
}

/**
 * Run `fn` with `process.emitWarning` dropping node:sqlite's
 * `ExperimentalWarning` (emitted synchronously on the module's first load);
 * every other warning passes through.
 */
export function withoutSqliteExperimentalWarning<T>(fn: () => T): T {
  const original = process.emitWarning;
  process.emitWarning = function (
    this: unknown,
    warning: string | Error,
    ...rest: unknown[]
  ): void {
    const first = rest[0];
    const type =
      typeof first === "string"
        ? first
        : typeof first === "object" && first !== null
          ? (first as { type?: unknown }).type
          : warning instanceof Error
            ? warning.name
            : undefined;
    const message = typeof warning === "string" ? warning : warning.message;
    if (type === "ExperimentalWarning" && /sqlite/i.test(message)) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return fn();
  } finally {
    process.emitWarning = original;
  }
}
