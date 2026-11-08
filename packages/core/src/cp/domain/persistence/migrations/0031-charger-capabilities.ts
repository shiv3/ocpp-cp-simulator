import type { Migration } from "./index";

/**
 * v31 (#327): `charge_points.charger_capabilities`, the JSON charger-side
 * delivery caps per connector. Guarded like the earlier column migrations;
 * NULL (every row of an older database) means no cap, which is what ran
 * before.
 */
export const migration0031ChargerCapabilities: Migration = {
  version: 31,
  name: "charger-capabilities",
  up(db) {
    const cols = db.all<{ name: string }>("PRAGMA table_info(charge_points)");
    if (!new Set(cols.map((c) => c.name)).has("charger_capabilities")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN charger_capabilities TEXT");
    }
  },
};
