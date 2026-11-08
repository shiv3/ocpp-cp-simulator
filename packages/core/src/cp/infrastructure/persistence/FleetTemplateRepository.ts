import {
  fleetTemplateSchema,
  type FleetTemplate,
} from "@ocpp-cp-simulator/contracts/index";
import type { Database } from "../../domain/persistence/Database";

interface FleetTemplateRow {
  id: string;
  name: string;
  description: string | null;
  definition: string;
  updated_at: string;
}

/**
 * Stored fleet templates (#445).
 *
 * Deliberately dumb: the shape is validated by `fleetTemplateSchema` at the
 * control-plane boundary, so this only stores and returns it. A row whose JSON
 * no longer parses is skipped rather than thrown, so one bad row cannot make
 * `fleet.template.list` fail for every other.
 *
 * **Without `--state-db` it keeps templates in memory rather than dropping
 * them.** The daemon's default is no database, and a `fleet.template.save` that
 * answered success while storing nothing would be the worst of both — the
 * common CI case is a throwaway daemon that saves a template and
 * instantiates it in the same run.
 */
export class FleetTemplateRepository {
  private readonly inMemory = new Map<string, FleetTemplate>();

  /**
   * `provided` are templates read from `--fleet-template` files: the same
   * shape as a stored one, but owned by the file. They are listed and
   * instantiated like any other, win over a stored template of the same id,
   * and can be neither replaced nor deleted over the control plane.
   */
  private readonly provided: ReadonlyMap<string, FleetTemplate>;

  constructor(
    private readonly database: Database | null,
    provided: readonly FleetTemplate[] = [],
  ) {
    this.provided = new Map(provided.map((t) => [t.id, t]));
  }

  /** True for a template that came from a file. */
  isProvided(id: string): boolean {
    return this.provided.has(id);
  }

  /** Stored templates only: what `fleet.template.save` may touch. */
  listStored(): FleetTemplate[] {
    return this.storedList();
  }

  /** Provided and stored templates, ordered by id. */
  list(): FleetTemplate[] {
    const all = new Map(this.storedList().map((t) => [t.id, t]));
    for (const [id, t] of this.provided) all.set(id, t);
    return [...all.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  private storedList(): FleetTemplate[] {
    if (!this.database) {
      return [...this.inMemory.values()].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
    }
    const rows = this.database.all<FleetTemplateRow>(
      "SELECT id, name, description, definition, updated_at FROM fleet_templates ORDER BY id ASC",
    );
    const templates: FleetTemplate[] = [];
    for (const row of rows) {
      const parsed = safeParse(row.definition);
      if (parsed) templates.push(parsed);
    }
    return templates;
  }

  get(id: string): FleetTemplate | null {
    const provided = this.provided.get(id);
    if (provided) return provided;
    if (!this.database) return this.inMemory.get(id) ?? null;
    const row = this.database.get<FleetTemplateRow>(
      "SELECT id, name, description, definition, updated_at FROM fleet_templates WHERE id = ?",
      [id],
    );
    return row ? safeParse(row.definition) : null;
  }

  save(template: FleetTemplate): void {
    if (!this.database) {
      this.inMemory.set(template.id, template);
      return;
    }
    this.database.run(
      "INSERT INTO fleet_templates (id, name, description, definition, updated_at) " +
        "VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, " +
        "description = excluded.description, definition = excluded.definition, " +
        "updated_at = excluded.updated_at",
      [
        template.id,
        template.name,
        template.description ?? null,
        JSON.stringify(template),
      ],
    );
  }

  /** Returns whether a row was removed, so the caller can report `not_found`. */
  delete(id: string): boolean {
    if (this.provided.has(id)) return false;
    if (!this.database) return this.inMemory.delete(id);
    if (!this.get(id)) return false;
    this.database.run("DELETE FROM fleet_templates WHERE id = ?", [id]);
    return true;
  }
}

/**
 * Parse a stored row, and check its shape.
 *
 * Valid JSON is not enough: a row written by an older version, or edited by
 * hand, can parse and still fail `fleetTemplateSchema`. Returned unchecked it
 * would fail `fleet.template.list`'s *result* validation, so one bad row would make
 * the whole call answer `internal` instead of returning every good one.
 */
function safeParse(definition: string): FleetTemplate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    return null;
  }
  const checked = fleetTemplateSchema.safeParse(parsed);
  return checked.success ? checked.data : null;
}
