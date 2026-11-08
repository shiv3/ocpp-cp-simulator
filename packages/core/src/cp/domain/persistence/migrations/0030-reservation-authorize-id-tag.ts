import type { Migration } from "./index";

/**
 * v30 (#595): `charge_points.reservation_authorize_id_tag`. Guarded like the
 * earlier column migrations; existing rows stay NULL, which restores as off.
 */
export const migration0030ReservationAuthorizeIdTag: Migration = {
  version: 30,
  name: "reservation-authorize-id-tag",
  up(db) {
    const cols = db.all<{ name: string }>("PRAGMA table_info(charge_points)");
    if (!new Set(cols.map((c) => c.name)).has("reservation_authorize_id_tag")) {
      db.exec(
        "ALTER TABLE charge_points ADD COLUMN reservation_authorize_id_tag INTEGER",
      );
    }
  },
};
