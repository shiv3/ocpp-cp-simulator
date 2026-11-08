import type { Migration } from "./index";

/**
 * v28 (#654): `charge_points.behavior_params`. Guarded like the earlier column
 * migrations; NULL (every row of an older database) means no params, which is
 * what ran before.
 */
export const migration0028BehaviorParams: Migration = {
  version: 28,
  name: "behavior-params",
  up(db) {
    const cols = db.all<{ name: string }>("PRAGMA table_info(charge_points)");
    if (!new Set(cols.map((c) => c.name)).has("behavior_params")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN behavior_params TEXT");
    }
  },
};
