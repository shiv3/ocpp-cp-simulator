import type { Migration } from "./index";

/**
 * v32 (#1133, #1134): `charge_points.meter_value_decimal_separator` (TEXT,
 * `","` or NULL) and `charge_points.empty_meter_values` (INTEGER, 1 or NULL).
 * Guarded like the earlier column migrations; NULL (every row of an older
 * database) restores as the default: a decimal point and filled samples.
 */
export const migration0032MeterValueQuirks: Migration = {
  version: 32,
  name: "meter-value-quirks",
  up(db) {
    const cols = new Set(
      db
        .all<{ name: string }>("PRAGMA table_info(charge_points)")
        .map((c) => c.name),
    );
    if (!cols.has("meter_value_decimal_separator")) {
      db.exec(
        "ALTER TABLE charge_points ADD COLUMN meter_value_decimal_separator TEXT",
      );
    }
    if (!cols.has("empty_meter_values")) {
      db.exec(
        "ALTER TABLE charge_points ADD COLUMN empty_meter_values INTEGER",
      );
    }
  },
};
