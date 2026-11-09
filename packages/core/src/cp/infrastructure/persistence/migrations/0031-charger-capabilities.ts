import type { Migration } from "./index";

/**
 * v31 (#327): `charge_points.charger_capabilities`, the JSON charger-side
 * delivery caps per connector. Guarded like the earlier column migrations;
 * NULL (every row of an older database) means no cap, which is what ran
 * before. It also ensures `reservation_authorize_id_tag` (v30, #595): a
 * development database written by the unreleased pre-merge build stamped v30
 * for `charger_capabilities`, so 0030 never ran on it (#846).
 */
export const migration0031ChargerCapabilities: Migration = {
  version: 31,
  name: "charger-capabilities",
  up(db) {
    const cols = new Set(
      db
        .all<{ name: string }>("PRAGMA table_info(charge_points)")
        .map((c) => c.name),
    );
    if (!cols.has("charger_capabilities")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN charger_capabilities TEXT");
    }
    if (!cols.has("reservation_authorize_id_tag")) {
      db.exec(
        "ALTER TABLE charge_points ADD COLUMN reservation_authorize_id_tag INTEGER",
      );
    }
  },
};
