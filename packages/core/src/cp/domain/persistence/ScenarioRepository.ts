import type { ScenarioDefinition } from "../../application/scenario/ScenarioTypes";

export interface ScenarioRepository {
  load(
    chargePointId: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition | null>;
  save(
    chargePointId: string,
    connectorId: number | null,
    scenario: ScenarioDefinition,
  ): Promise<void>;
  delete(chargePointId: string, connectorId: number | null): Promise<void>;
  list(chargePointId: string): Promise<ScenarioDefinition[]>;
  listByConnector(
    chargePointId: string,
    connectorId: number | null,
  ): ScenarioDefinition[];
  replaceConnector(
    chargePointId: string,
    connectorId: number | null,
    scenarios: readonly ScenarioDefinition[],
  ): Promise<void>;
  deleteOne(
    chargePointId: string,
    connectorId: number | null,
    scenarioId: string,
  ): void;
  subscribe(
    chargePointId: string,
    connectorId: number | null,
    handler: (scenario: ScenarioDefinition | null) => void,
  ): () => void;
}

/**
 * Scenario definitions for a daemon without `--state-db` (#495): the same
 * contract as `SqliteScenarioRepository` on a database, kept for the process
 * lifetime. A charge point's scenarios go when it is deleted
 * ({@link deleteForChargePoint}) and everything goes on `state.reset`
 * ({@link clear}), like the table's rows; the Library scope is not a charge
 * point, so only `clear` drops it.
 *
 * (`SqliteScenarioRepository` on `null` is the browser's Remote-mode no-op:
 * there the daemon owns the definitions.)
 */
export class InMemoryScenarioRepository implements ScenarioRepository {
  /** By `cpId::connector` (null connector = `0`, like the table), then by
   *  scenario id. */
  private readonly rows = new Map<
    string,
    Map<string, { updatedAt: string; definition: ScenarioDefinition }>
  >();
  private readonly listeners = new Map<
    string,
    Set<(scenario: ScenarioDefinition | null) => void>
  >();

  async load(
    chargePointId: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition | null> {
    return this.listByConnector(chargePointId, connectorId)[0] ?? null;
  }

  async save(
    chargePointId: string,
    connectorId: number | null,
    scenario: ScenarioDefinition,
  ): Promise<void> {
    this.saveRow(chargePointId, connectorId, scenario);
    this.notify(chargePointId, connectorId, scenario);
  }

  async delete(
    chargePointId: string,
    connectorId: number | null,
  ): Promise<void> {
    this.rows.delete(slotOf(chargePointId, connectorId));
    this.notify(chargePointId, connectorId, null);
  }

  async list(chargePointId: string): Promise<ScenarioDefinition[]> {
    const prefix = `${chargePointId}::`;
    return newestFirst(
      [...this.rows]
        .filter(([slot]) => slot.startsWith(prefix))
        .flatMap(([, defs]) => [...defs.values()]),
    );
  }

  listByConnector(
    chargePointId: string,
    connectorId: number | null,
  ): ScenarioDefinition[] {
    return newestFirst([
      ...(this.rows.get(slotOf(chargePointId, connectorId))?.values() ?? []),
    ]);
  }

  async replaceConnector(
    chargePointId: string,
    connectorId: number | null,
    scenarios: readonly ScenarioDefinition[],
  ): Promise<void> {
    this.rows.delete(slotOf(chargePointId, connectorId));
    for (const scenario of scenarios) {
      this.saveRow(chargePointId, connectorId, scenario);
    }
    this.notify(chargePointId, connectorId, scenarios[0] ?? null);
  }

  deleteOne(
    chargePointId: string,
    connectorId: number | null,
    scenarioId: string,
  ): void {
    this.rows.get(slotOf(chargePointId, connectorId))?.delete(scenarioId);
    this.notify(chargePointId, connectorId, null);
  }

  subscribe(
    chargePointId: string,
    connectorId: number | null,
    handler: (scenario: ScenarioDefinition | null) => void,
  ): () => void {
    const key = listenerKeyOf(chargePointId, connectorId);
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(handler);
    this.listeners.set(key, listeners);

    void this.load(chargePointId, connectorId).then((value) => handler(value));

    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  /** Every scenario of a deleted charge point, connector-level and CP-level. */
  deleteForChargePoint(chargePointId: string): void {
    const prefix = `${chargePointId}::`;
    for (const slot of [...this.rows.keys()]) {
      if (slot.startsWith(prefix)) this.rows.delete(slot);
    }
  }

  clear(): void {
    this.rows.clear();
  }

  private saveRow(
    chargePointId: string,
    connectorId: number | null,
    scenario: ScenarioDefinition,
  ): void {
    const slot = slotOf(chargePointId, connectorId);
    const defs = this.rows.get(slot) ?? new Map();
    defs.set(scenario.id, {
      updatedAt: scenario.updatedAt ?? new Date().toISOString(),
      definition: scenario,
    });
    this.rows.set(slot, defs);
  }

  private notify(
    chargePointId: string,
    connectorId: number | null,
    scenario: ScenarioDefinition | null,
  ): void {
    const listeners = this.listeners.get(
      listenerKeyOf(chargePointId, connectorId),
    );
    if (!listeners) return;
    listeners.forEach((listener) => {
      try {
        listener(scenario);
      } catch (error) {
        console.error("[InMemoryScenarioRepository] listener error", error);
      }
    });
  }
}

/** Storage slot: a null connector is the CP-level slot `0`, as in the table. */
function slotOf(chargePointId: string, connectorId: number | null): string {
  return `${chargePointId}::${connectorId ?? 0}`;
}

/** Listener key, as `SqliteScenarioRepository` keys its listeners. */
function listenerKeyOf(
  chargePointId: string,
  connectorId: number | null,
): string {
  return `${chargePointId}::${connectorId ?? "cp"}`;
}

/** `ORDER BY updated_at DESC`; ISO 8601 strings sort chronologically. */
function newestFirst(
  rows: Array<{ updatedAt: string; definition: ScenarioDefinition }>,
): ScenarioDefinition[] {
  return rows
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((row) => row.definition);
}
