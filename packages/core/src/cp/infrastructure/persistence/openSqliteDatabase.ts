import type { Database } from "../../domain/persistence/Database";

/**
 * Open the daemon's SQLite state DB with the runtime's own driver (#916):
 * `bun:sqlite` on Bun ({@link BunSqliteDatabase}, unchanged), `node:sqlite`
 * on Node ({@link NodeSqliteDatabase}). The adapters are imported lazily so a
 * runtime never loads the other one's built-in module.
 *
 * `path` is a file path or `":memory:"`; a missing parent directory is
 * created.
 */
export async function openSqliteDatabase(path: string): Promise<Database> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const { BunSqliteDatabase } = await import("./BunSqliteDatabase");
    return BunSqliteDatabase.open(path);
  }
  const { NodeSqliteDatabase } = await import("./NodeSqliteDatabase");
  return NodeSqliteDatabase.open(path);
}
