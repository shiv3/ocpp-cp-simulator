import type { Migration } from "./index";

/**
 * v25 → v26 (#618): `charge_points.capability_profile` (JSON). Existing rows
 * stay NULL, which restores as no profile.
 */
export const capabilityProfile: Migration = {
  version: 26,
  name: "capability-profile",
  up(db) {
    const cols = db.all<{ name: string }>("PRAGMA table_info(charge_points)");
    if (!new Set(cols.map((c) => c.name)).has("capability_profile")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN capability_profile TEXT");
    }
  },
};
