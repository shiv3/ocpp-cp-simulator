import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { perChargePointTables } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/schema";
import { PENDING_IDENTITY_OVERRIDE } from "@ocpp-cp-simulator/core/cp/domain/charge-point/chargePointIdentity";

/**
 * Move every row of a charge point to a new identity (#924), in one
 * transaction. The list of tables is the schema's own (`perChargePointTables`,
 * the same one a charge point delete cascades to), so a table added later is
 * renamed too: `tables.bun.test.ts` fails for a table missing from it.
 *
 * Throws, leaving the database as it was, when a row of the new identity
 * already exists (the primary keys collide) or any statement fails.
 *
 * The pending-identity row of the `configuration` table is dropped: the
 * rename it asked for has now happened.
 */
export function renameChargePointRows(
  db: Database,
  oldId: string,
  newId: string,
): void {
  if (oldId === newId) return;
  const taken = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM charge_points WHERE cp_id = ?",
    [newId],
  );
  if ((taken?.n ?? 0) > 0) {
    throw new Error(`cpId already exists: ${newId}`);
  }
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    for (const table of perChargePointTables()) {
      db.run(`UPDATE ${table} SET cp_id = ? WHERE cp_id = ?`, [newId, oldId]);
    }
    db.run('DELETE FROM configuration WHERE cp_id = ? AND "key" = ?', [
      newId,
      PENDING_IDENTITY_OVERRIDE,
    ]);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The failure above is the one to report.
    }
    throw err;
  }
}
