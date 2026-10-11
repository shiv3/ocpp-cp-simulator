import { vehicleProfileSchema } from "../../../protocol/vehicle";
import type { VehicleProfile } from "../vehicle/VehicleProfile";
import type { Database } from "./Database";

interface VehicleProfileRow {
  body: string;
}

/**
 * Saved vehicle profiles (#458), in the daemon's `--state-db` and in the
 * browser's sql.js database alike.
 *
 * Like {@link BlueprintRepository}: without a database the profiles live in
 * memory rather than being dropped, and a stored row that no longer matches
 * `vehicleProfileSchema` is skipped rather than thrown, so one bad row cannot
 * hide every other profile. A saved profile is validated on the way in too:
 * fields the schema does not name are not stored.
 */
export class VehicleProfileRepository {
  private readonly inMemory = new Map<string, VehicleProfile>();

  constructor(private readonly database: Database | null) {}

  /** By name, then id, so the pickers list them in a stable order. */
  list(): VehicleProfile[] {
    const profiles = this.database
      ? this.database
          .all<VehicleProfileRow>("SELECT body FROM vehicle_profiles")
          .map((row) => safeParse(row.body))
          .filter((p): p is VehicleProfile => p !== null)
      : [...this.inMemory.values()];
    return profiles.sort(
      (a, b) => a.name.localeCompare(b.name) || compare(a.id, b.id),
    );
  }

  get(id: string): VehicleProfile | null {
    if (!this.database) return this.inMemory.get(id) ?? null;
    const row = this.database.get<VehicleProfileRow>(
      "SELECT body FROM vehicle_profiles WHERE id = ?",
      [id],
    );
    return row ? safeParse(row.body) : null;
  }

  /** Inserts or replaces by id. Returns what was stored. */
  save(profile: VehicleProfile): VehicleProfile {
    const stored = vehicleProfileSchema.parse(profile);
    if (!this.database) {
      this.inMemory.set(stored.id, stored);
      return stored;
    }
    this.database.run(
      "INSERT INTO vehicle_profiles (id, name, body, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, " +
        "body = excluded.body, updated_at = excluded.updated_at",
      [stored.id, stored.name, JSON.stringify(stored), stored.updatedAt],
    );
    return stored;
  }

  /** Returns whether a row was removed, so the caller can report `not_found`. */
  delete(id: string): boolean {
    if (!this.database) return this.inMemory.delete(id);
    if (!this.get(id)) return false;
    this.database.run("DELETE FROM vehicle_profiles WHERE id = ?", [id]);
    return true;
  }
}

function safeParse(body: string): VehicleProfile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const checked = vehicleProfileSchema.safeParse(parsed);
  return checked.success ? checked.data : null;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
