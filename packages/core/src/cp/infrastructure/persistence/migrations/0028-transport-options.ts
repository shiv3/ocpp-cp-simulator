import type { Migration } from "./index";

/**
 * v27 → v28 (#609): `charge_points.transport_options` (JSON). Existing rows
 * stay NULL, which restores as the built-in transport behaviour.
 */
export const transportOptions: Migration = {
  version: 28,
  name: "transport-options",
  up(db) {
    const cols = db.all<{ name: string }>("PRAGMA table_info(charge_points)");
    if (!new Set(cols.map((c) => c.name)).has("transport_options")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN transport_options TEXT");
    }
  },
};
