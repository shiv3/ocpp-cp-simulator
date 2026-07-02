import { describe, expect, it } from "vitest";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type {
  Database,
  SqlParam,
  SqlRow,
} from "../../cp/domain/persistence/Database";
import { LocalChargePointService } from "./LocalChargePointService";

interface ScenarioRow {
  cp_id: string;
  connector_id: number;
  scenario_id: string;
  name: string;
  enabled: number;
  updated_at: string;
  definition: string;
}

class MemoryScenarioDatabase implements Database {
  private readonly rows = new Map<string, ScenarioRow>();

  exec(sql: string): void {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(sql)) return;
    throw new Error(`Unexpected exec: ${sql}`);
  }

  run(sql: string, params: SqlParam[] = []): void {
    if (sql.startsWith("INSERT INTO scenarios ")) {
      const [
        cpId,
        connectorId,
        scenarioId,
        name,
        enabled,
        updatedAt,
        definition,
      ] = params;
      const row: ScenarioRow = {
        cp_id: String(cpId),
        connector_id: Number(connectorId),
        scenario_id: String(scenarioId),
        name: String(name),
        enabled: Number(enabled),
        updated_at: String(updatedAt),
        definition: String(definition),
      };
      this.rows.set(
        this.key(row.cp_id, row.connector_id, row.scenario_id),
        row,
      );
      return;
    }

    if (sql === "DELETE FROM scenarios WHERE cp_id = ? AND connector_id = ?") {
      const [cpId, connectorId] = params;
      for (const row of [...this.rows.values()]) {
        if (row.cp_id === cpId && row.connector_id === connectorId) {
          this.rows.delete(
            this.key(row.cp_id, row.connector_id, row.scenario_id),
          );
        }
      }
      return;
    }

    if (sql.startsWith("DELETE FROM scenarios ")) {
      const [cpId, connectorId, scenarioId] = params;
      this.rows.delete(
        this.key(String(cpId), Number(connectorId), String(scenarioId)),
      );
      return;
    }

    throw new Error(`Unexpected run: ${sql}`);
  }

  all<T = SqlRow>(sql: string, params: SqlParam[] = []): T[] {
    if (sql.startsWith("SELECT definition FROM scenarios ")) {
      const [cpId, connectorId] = params;
      return [...this.rows.values()]
        .filter((row) => row.cp_id === cpId && row.connector_id === connectorId)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((row) => ({ definition: row.definition }) as T);
    }

    throw new Error(`Unexpected all: ${sql}`);
  }

  get<T = SqlRow>(sql: string, params: SqlParam[] = []): T | null {
    return this.all<T>(sql, params)[0] ?? null;
  }

  close(): void {}

  async flush(): Promise<void> {}

  private key(cpId: string, connectorId: number, scenarioId: string): string {
    return `${cpId}\0${connectorId}\0${scenarioId}`;
  }
}

function scenario(
  id: string,
  connectorId: number,
  updatedAt: string,
): ScenarioDefinition {
  return {
    id,
    name: `Scenario ${id}`,
    targetType: "connector",
    targetId: connectorId,
    nodes: [],
    edges: [],
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt,
    enabled: true,
  };
}

describe("LocalChargePointService scenario definition persistence", () => {
  it("round-trips save, list, and delete", async () => {
    const service = new LocalChargePointService(new MemoryScenarioDatabase());
    const definition = scenario("scenario-1", 1, "2026-06-30T00:00:01.000Z");

    await expect(
      service.saveScenarioDefinition("cp-1", 1, definition),
    ).resolves.toEqual(definition);
    await expect(service.listScenarioDefinitions("cp-1", 1)).resolves.toEqual([
      definition,
    ]);

    await service.deleteScenarioDefinition("cp-1", 1, definition.id);

    await expect(service.listScenarioDefinitions("cp-1", 1)).resolves.toEqual(
      [],
    );
  });

  it("replaceConnectorScenarioDefinitions prunes stale siblings and keeps the provided set", async () => {
    const service = new LocalChargePointService(new MemoryScenarioDatabase());
    const stale = scenario("stale", 1, "2026-06-30T00:00:01.000Z");
    const keep = scenario("keep", 1, "2026-06-30T00:00:02.000Z");
    const next = scenario("next", 1, "2026-06-30T00:00:03.000Z");

    await service.saveScenarioDefinition("cp-1", 1, stale);
    await service.saveScenarioDefinition("cp-1", 1, keep);

    await expect(
      service.replaceConnectorScenarioDefinitions("cp-1", 1, [keep, next]),
    ).resolves.toEqual([keep, next]);

    const definitions = await service.listScenarioDefinitions("cp-1", 1);
    expect(definitions.map((definition) => definition.id).sort()).toEqual([
      "keep",
      "next",
    ]);
    expect(definitions).not.toContainEqual(stale);
  });
});
