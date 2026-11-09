import type { SqlParam } from "../../domain/persistence/Database";

/**
 * Build `INSERT ... ON CONFLICT (...) DO UPDATE` from one list of
 * `[column, value]` pairs, so the column list, the `?` placeholders and the
 * parameter array cannot disagree and adding a column is a one-line change.
 *
 * Every column that is not part of the conflict key (and not in `keepOnUpdate`)
 * is overwritten with `excluded.<column>` when the row already exists.
 */
export type UpsertEntry = readonly [column: string, value: SqlParam];

export function buildUpsert(
  table: string,
  entries: readonly UpsertEntry[],
  conflictKey: readonly string[],
  keepOnUpdate: readonly string[] = [],
): { sql: string; params: SqlParam[] } {
  const columns = entries.map(([column]) => column);
  if (new Set(columns).size !== columns.length) {
    throw new Error(`buildUpsert(${table}): duplicate column`);
  }
  for (const column of [...conflictKey, ...keepOnUpdate]) {
    if (!columns.includes(column)) {
      throw new Error(`buildUpsert(${table}): unknown column ${column}`);
    }
  }
  const skipped = new Set([...conflictKey, ...keepOnUpdate]);
  const updates = columns
    .filter((column) => !skipped.has(column))
    .map((column) => `${column} = excluded.${column}`);
  const sql =
    `INSERT INTO ${table} (${columns.join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")}) ` +
    `ON CONFLICT (${conflictKey.join(", ")}) DO UPDATE SET ` +
    updates.join(", ");
  return { sql, params: entries.map(([, value]) => value) };
}
