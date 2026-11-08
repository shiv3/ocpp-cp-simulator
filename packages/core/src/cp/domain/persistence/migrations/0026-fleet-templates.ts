import type { Database } from "../Database";
import type { Migration } from "./index";

/**
 * The `fleet_templates` table (#445), shared by `SCHEMA_SQL` and the v26
 * migration so the two cannot drift.
 */
export const FLEET_TEMPLATES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS fleet_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  definition  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);`;

/**
 * v25 → v26 (#445): the `fleet_templates` table. Additive; `IF NOT EXISTS` in
 * `SCHEMA_SQL` has usually created it by now, and the `sqlite_master` probe
 * keeps the step correct on its own.
 */
export const migration0026FleetTemplates: Migration = {
  version: 26,
  name: "fleet-templates",
  up(db: Database): void {
    const present = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fleet_templates'",
    );
    if (!present) db.exec(FLEET_TEMPLATES_TABLE_SQL);
  },
};
