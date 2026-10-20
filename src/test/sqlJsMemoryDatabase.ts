import initSqlJs from "sql.js";

import type { Database, SqlParam } from "../cp/domain/persistence/Database";
import { runMigrations } from "../cp/domain/persistence/schema";

/** In-memory sql.js database behind the domain `Database` port, so the
 *  service, its ChargePoints and the scenario repository share real SQL. */
export async function memoryDatabase(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const coerce = (params: SqlParam[]) =>
    params.map((p) => (typeof p === "boolean" ? Number(p) : p));
  const adapter: Database = {
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql, params = []) => {
      db.run(sql, coerce(params));
    },
    all: <T>(sql: string, params: SqlParam[] = []) => {
      const stmt = db.prepare(sql, coerce(params));
      const rows: T[] = [];
      try {
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
      } finally {
        stmt.free();
      }
      return rows;
    },
    get: <T>(sql: string, params: SqlParam[] = []) => {
      const stmt = db.prepare(sql, coerce(params));
      try {
        return stmt.step() ? (stmt.getAsObject() as T) : null;
      } finally {
        stmt.free();
      }
    },
    close: () => db.close(),
  };
  runMigrations(adapter);
  return adapter;
}
