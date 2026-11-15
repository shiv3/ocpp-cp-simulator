import {
  BLUEPRINT_SCHEMA_VERSION,
  blueprintSchema,
  type Blueprint,
} from "@ocpp-cp-simulator/contracts/index";
import type { Database } from "../../domain/persistence/Database";

interface BlueprintRow {
  id: string;
  name: string;
  description: string | null;
  definition: string;
  updated_at: string;
}

/**
 * Stored charge point blueprints (#297).
 *
 * Deliberately dumb: the shape is validated by `blueprintSchema` at the
 * control-plane boundary, so this only stores and returns it. A row whose JSON
 * no longer parses is skipped rather than thrown, so one bad row cannot make
 * `blueprint.list` fail for every other.
 *
 * **Without `--state-db` it keeps blueprints in memory rather than dropping
 * them.** The daemon's default is no database, and a `blueprint.save` that
 * answered success while storing nothing would be the worst of both — the
 * common CI case is a throwaway daemon that creates a blueprint and
 * instantiates it in the same run.
 */
export class BlueprintRepository {
  private readonly inMemory = new Map<string, Blueprint>();

  /**
   * `provided` are blueprints read from `--blueprint` files (#331): the same
   * shape as a stored one, but owned by the file. They are listed and
   * instantiated like any other, win over a stored blueprint of the same id,
   * and can be neither replaced nor deleted over the control plane — the file
   * wins again at the next start, so a stored copy would be dead.
   */
  private readonly provided: ReadonlyMap<string, Blueprint>;

  constructor(
    private readonly database: Database | null,
    provided: readonly Blueprint[] = [],
  ) {
    this.provided = new Map(provided.map((b) => [b.id, b]));
  }

  /** True for a blueprint that came from a file. */
  isProvided(id: string): boolean {
    return this.provided.has(id);
  }

  /** Stored blueprints only: what `blueprint.save` may touch. */
  listStored(): Blueprint[] {
    return this.storedList();
  }

  /** Provided and stored blueprints, ordered by id. */
  list(): Blueprint[] {
    if (this.provided.size === 0) return this.storedList();
    const all = new Map(this.storedList().map((b) => [b.id, b]));
    for (const [id, b] of this.provided) all.set(id, b);
    return [...all.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  /**
   * Stored rows written by a newer build (`schemaVersion` above
   * `BLUEPRINT_SCHEMA_VERSION`), which this build cannot read and therefore
   * leaves out of `list()` and `get()`. The row itself is kept untouched, so
   * going back to the newer build restores it; the daemon logs these once at
   * startup so the omission is visible rather than silent (#331).
   */
  newerVersionRows(): Array<{ id: string; schemaVersion: number }> {
    if (!this.database) return [];
    const rows = this.database.all<BlueprintRow>(
      "SELECT id, name, description, definition, updated_at FROM blueprints ORDER BY id ASC",
    );
    const newer: Array<{ id: string; schemaVersion: number }> = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.definition);
      } catch {
        continue;
      }
      const version =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { schemaVersion?: unknown }).schemaVersion
          : undefined;
      if (typeof version === "number" && version > BLUEPRINT_SCHEMA_VERSION) {
        newer.push({ id: row.id, schemaVersion: version });
      }
    }
    return newer;
  }

  private storedList(): Blueprint[] {
    if (!this.database) {
      return [...this.inMemory.values()].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
    }
    const rows = this.database.all<BlueprintRow>(
      "SELECT id, name, description, definition, updated_at FROM blueprints ORDER BY id ASC",
    );
    const blueprints: Blueprint[] = [];
    for (const row of rows) {
      const parsed = safeParse(row.definition);
      if (parsed) blueprints.push(parsed);
    }
    return blueprints;
  }

  get(id: string): Blueprint | null {
    const provided = this.provided.get(id);
    if (provided) return provided;
    if (!this.database) return this.inMemory.get(id) ?? null;
    const row = this.database.get<BlueprintRow>(
      "SELECT id, name, description, definition, updated_at FROM blueprints WHERE id = ?",
      [id],
    );
    return row ? safeParse(row.definition) : null;
  }

  save(blueprint: Blueprint): void {
    if (!this.database) {
      this.inMemory.set(blueprint.id, blueprint);
      return;
    }
    this.database.run(
      "INSERT INTO blueprints (id, name, description, definition, updated_at) " +
        "VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, " +
        "description = excluded.description, definition = excluded.definition, " +
        "updated_at = excluded.updated_at",
      [
        blueprint.id,
        blueprint.name,
        blueprint.description ?? null,
        JSON.stringify(blueprint),
        new Date().toISOString(),
      ],
    );
  }

  /** Returns whether a row was removed, so the caller can report `not_found`. */
  delete(id: string): boolean {
    if (this.provided.has(id)) return false;
    if (!this.database) return this.inMemory.delete(id);
    if (!this.get(id)) return false;
    this.database.run("DELETE FROM blueprints WHERE id = ?", [id]);
    return true;
  }
}

/**
 * Parse a stored row, and check its shape.
 *
 * Valid JSON is not enough: a row written by an older version, or edited by
 * hand, can parse and still fail `blueprintSchema`. Returned unchecked it
 * would fail `blueprint.list`'s *result* validation, so one bad row would make
 * the whole call answer `internal` instead of returning every good one.
 */
function safeParse(definition: string): Blueprint | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    return null;
  }
  const checked = blueprintSchema.safeParse(parsed);
  return checked.success ? checked.data : null;
}
