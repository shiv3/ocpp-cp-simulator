// Runs under `bun test`: the daemon's state DB is `bun:sqlite`.
import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import type { Database } from "../../../cp/domain/persistence/Database";
import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";
import { CLIChargePointService } from "../../service";
import { pruneStaleStartupScenarios } from "../startServer";
import {
  listStartupScenarioRows,
  loadWithStartupProvenance,
} from "../startupScenarioRows";

/**
 * The failure contracts of the startup provenance bookkeeping (#338). Each
 * one fails towards keeping a scenario: a write or read that fails marks
 * nothing and prunes nothing, and one removal that throws does not stop the
 * prune from processing the next row.
 */
const CP = "cp-338-rows";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function quietStderr(): { lines: () => string[] } {
  const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
  cleanups.push(() => spy.mockRestore());
  return { lines: () => spy.mock.calls.map(([chunk]) => String(chunk)) };
}

function definition(id: string): ScenarioDefinition {
  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    trigger: { type: "manual" },
    nodes: [
      {
        id: "s",
        type: "start",
        position: { x: 0, y: 0 },
        data: { label: "S" },
      },
      { id: "e", type: "end", position: { x: 0, y: 1 }, data: { label: "E" } },
    ],
    edges: [{ id: "e1", source: "s", target: "e" }],
  } as unknown as ScenarioDefinition;
}

function failing(overrides: Partial<Database> = {}): Database {
  const fail = (): never => {
    throw new Error("SQLITE_BUSY");
  };
  return {
    exec: fail,
    run: fail,
    get: fail,
    all: fail,
    close: () => {},
    ...overrides,
  } as unknown as Database;
}

describe("startup provenance bookkeeping fails towards keeping scenarios (#338)", () => {
  it("a provenance read that fails marks nothing, and the load still happens", () => {
    const stderr = quietStderr();
    let loads = 0;
    const id = loadWithStartupProvenance(
      failing(),
      CP,
      1,
      "--scenario=x",
      () => {
        loads += 1;
        return "x-c1";
      },
    );
    expect(id).toBe("x-c1");
    expect(loads).toBe(1);
    expect(stderr.lines().join("")).toContain(
      "could not read scenario provenance",
    );
  });

  it("a provenance write that fails is reported, not thrown", () => {
    const stderr = quietStderr();
    const id = loadWithStartupProvenance(
      failing({ all: (() => []) as Database["all"] }),
      CP,
      1,
      "--scenario=x",
      () => "x-c1",
    );
    expect(id).toBe("x-c1");
    expect(stderr.lines().join("")).toContain(
      "could not record startup provenance",
    );
  });

  it("a row list that cannot be read prunes nothing", () => {
    const stderr = quietStderr();
    expect(listStartupScenarioRows(failing(), CP)).toEqual([]);
    expect(stderr.lines().join("")).toContain(
      "could not read startup scenario rows",
    );
  });

  it("one removal that throws does not stop the prune", () => {
    const stderr = quietStderr();
    const db = BunSqliteDatabase.open(":memory:");
    cleanups.push(() => db.close());
    for (const id of ["a-c1", "b-c1"]) {
      db.run(
        "INSERT INTO scenarios (cp_id, connector_id, scenario_id, name, enabled, " +
          "updated_at, definition, startup_source) VALUES (?, 1, ?, ?, 1, ?, '{}', ?)",
        [CP, id, id, "2026-10-29T00:00:00Z", "--scenario=gone.json"],
      );
    }
    const removed: string[] = [];
    const svc = {
      getInit: () => ({ cpId: CP }),
      removeScenario: (connectorId: number, scenarioId: string) => {
        if (scenarioId === "a-c1") throw new Error("boom");
        removed.push(scenarioId);
        db.run(
          "DELETE FROM scenarios WHERE cp_id = ? AND connector_id = ? AND scenario_id = ?",
          [CP, connectorId, scenarioId],
        );
        return true;
      },
    } as unknown as CLIChargePointService;

    pruneStaleStartupScenarios(svc, db, new Map());

    expect(removed).toEqual(["b-c1"]);
    expect(stderr.lines().join("")).toContain(
      'Failed to remove stale startup scenario "a-c1"',
    );
  });

  it("deletes a stale row whose id memory holds on another connector, and leaves that one alone", () => {
    quietStderr();
    const db = BunSqliteDatabase.open(":memory:");
    // A user-authored "shared" on c1, and a startup-generated "shared" on c2.
    // The in-memory map is keyed by id, so the restore holds c1's only.
    const insert = (connectorId: number, source: string | null): void =>
      db.run(
        "INSERT INTO scenarios (cp_id, connector_id, scenario_id, name, enabled, " +
          "updated_at, definition, startup_source) VALUES (?, ?, 'shared', 'shared', 1, ?, ?, ?)",
        [
          CP,
          connectorId,
          "2026-10-29T00:00:00Z",
          JSON.stringify(definition("shared")),
          source,
        ],
      );
    insert(1, null);
    insert(2, "--scenario=gone.json");
    const svc = new CLIChargePointService(
      {
        cpId: CP,
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 2,
        vendor: "v",
        model: "m",
        basicAuth: null,
      },
      db,
    );
    cleanups.push(async () => {
      svc.cleanup(true);
      await new Promise((r) => setTimeout(r, 50));
      db.close();
    });
    svc.restoreScenariosFromDatabase();
    expect(svc.listScenarios(1).map((s) => s.scenarioId)).toEqual(["shared"]);

    pruneStaleStartupScenarios(svc, db, new Map());

    expect(
      db.all(
        "SELECT connector_id, scenario_id FROM scenarios WHERE cp_id = ?",
        [CP],
      ),
    ).toEqual([{ connector_id: 1, scenario_id: "shared" }]);
    expect(svc.listScenarios(1).map((s) => s.scenarioId)).toEqual(["shared"]);
  });
});
