import { blueprintSchema, type Blueprint } from "../../../protocol";
import type { Database } from "./Database";

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

  constructor(private readonly database: Database | null) {}

  list(): Blueprint[] {
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
