// Runs under `bun test`: the cleanup-path cases use the `bun:sqlite` built-in.
import { describe, it, expect } from "bun:test";

import { BunSqliteDatabase } from "../BunSqliteDatabase";
import { resetSimulatorState } from "../resetState";
import {
  SCHEMA_SQL,
  TABLES,
  perChargePointTables,
  tablesResetOnStateReset,
} from "../schema";
import { CPRegistry } from "../../../../cli/server/CPRegistry";
import { EventBus } from "../../../../cli/server/eventBus";

/**
 * #326: the table set has one source of truth. `state.reset` used to truncate
 * 9 of 12 tables (`blueprints` survived) and a charge point delete cascaded to
 * 3 of the 8 `cp_id`-keyed ones, because each path kept its own hand-written
 * list. Both now iterate `TABLES`; this file is what makes "a new table is
 * missing from a cleanup path" a failing test.
 */

/** `CREATE TABLE [IF NOT EXISTS] <name> (<body>)` pairs, straight from the DDL. */
function createdTables(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g;
  for (const m of SCHEMA_SQL.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/** One row per table, for two charge points. Columns are the NOT NULL set. */
function populate(db: BunSqliteDatabase, cpIds: readonly string[]): void {
  const t = "2026-09-17T00:00:00Z";
  for (const cp of cpIds) {
    db.run(
      "INSERT INTO watched_scenario_files (cp_id, connector_id, scenario_id, path) VALUES (?, 1, 's', '/tmp/s.json')",
      [cp],
    );
    db.run(
      "INSERT INTO scenarios (cp_id, connector_id, scenario_id, name, enabled, updated_at, definition) VALUES (?, 1, 's', 'S', 1, ?, '{}')",
      [cp, t],
    );
    db.run(
      "INSERT INTO connector_settings (cp_id, connector_id, auto_meter) VALUES (?, 1, '{}')",
      [cp],
    );
    db.run(
      "INSERT INTO charging_profiles (cp_id, connector_id, charging_profile_id, stack_level, purpose, profile) VALUES (?, 1, 7, 0, 'TxProfile', '{}')",
      [cp],
    );
    db.run(
      "INSERT INTO configuration (cp_id, key, value) VALUES (?, 'HeartbeatInterval', '30')",
      [cp],
    );
    db.run(
      "INSERT INTO pending_messages (cp_id, message_id, action, payload, created_at) VALUES (?, 'm1', 'MeterValues', '{}', ?)",
      [cp, t],
    );
    db.run(
      "INSERT INTO logs (cp_id, timestamp, level, log_type, message) VALUES (?, ?, 'info', 'ocpp', 'hello')",
      [cp, t],
    );
    db.run(
      "INSERT OR IGNORE INTO charge_points (cp_id, ws_url, connectors, vendor, model, created_at) VALUES (?, 'ws://127.0.0.1:1/ocpp', 1, 'V', 'M', ?)",
      [cp, t],
    );
    db.run(
      "INSERT OR REPLACE INTO charge_point_state (cp_id, desired_connected, updated_at) VALUES (?, 1, ?)",
      [cp, t],
    );
    db.run(
      "INSERT OR REPLACE INTO connector_runtime (cp_id, connector_id, status, availability, updated_at) VALUES (?, 1, 'Available', 'Operative', ?)",
      [cp, t],
    );
  }
  db.run("INSERT OR REPLACE INTO kv (key, value) VALUES ('pref', '1')");
  db.run(
    "INSERT OR REPLACE INTO blueprints (id, name, definition, updated_at) VALUES ('bp', 'BP', '{}', ?)",
    [t],
  );
}

function count(db: BunSqliteDatabase, table: string, cpId?: string): number {
  const row = cpId
    ? db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE cp_id = ?`,
        [cpId],
      )
    : db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? -1;
}

describe("TABLES is the schema's own list (#326)", () => {
  it("names exactly the tables SCHEMA_SQL creates", () => {
    const created = [...createdTables().keys()].sort();
    const registered = TABLES.map((t) => t.name).sort();
    expect(registered).toEqual(created);
    expect(new Set(registered).size).toBe(registered.length);
  });

  it("flags perCp exactly the tables that carry a cp_id column", () => {
    const created = createdTables();
    for (const spec of TABLES) {
      const body = created.get(spec.name) ?? "";
      const hasCpId = /^\s*cp_id\s/m.test(body);
      expect(spec.perCp, `${spec.name} perCp`).toBe(hasCpId);
    }
  });

  it("keeps only schema_meta out of state.reset", () => {
    expect(
      TABLES.filter((t) => !t.resetOnStateReset).map((t) => t.name),
    ).toEqual(["schema_meta"]);
    expect(tablesResetOnStateReset()).not.toContain("schema_meta");
    expect(tablesResetOnStateReset()).toContain("blueprints");
    expect(perChargePointTables()).toContain("logs");
  });
});

describe("the cleanup paths cover every table they promise (#326)", () => {
  it("state.reset empties every table but schema_meta", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      populate(db, ["CP-A", "CP-B"]);
      for (const table of tablesResetOnStateReset()) {
        expect(count(db, table), `${table} before`).toBeGreaterThan(0);
      }
      const meta = count(db, "schema_meta");
      expect(meta).toBeGreaterThan(0);

      resetSimulatorState(db);

      for (const table of tablesResetOnStateReset()) {
        expect(count(db, table), `${table} after`).toBe(0);
      }
      expect(count(db, "schema_meta")).toBe(meta);
    } finally {
      db.close();
    }
  });

  it("deleting a charge point removes its rows from every cp_id-keyed table and nobody else's", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    try {
      for (const cpId of ["CP-A", "CP-B"]) {
        registry.create(
          {
            cpId,
            wsUrl: "ws://127.0.0.1:1/ocpp",
            connectors: 1,
            vendor: "V",
            model: "M",
            basicAuth: null,
          },
          { seedDefault: false },
        );
      }
      populate(db, ["CP-A", "CP-B"]);
      for (const table of perChargePointTables()) {
        expect(count(db, table, "CP-A"), `${table} before`).toBeGreaterThan(0);
      }

      expect(registry.remove("CP-A")).toBe(true);

      for (const table of perChargePointTables()) {
        expect(count(db, table, "CP-A"), `${table} CP-A after`).toBe(0);
        expect(count(db, table, "CP-B"), `${table} CP-B after`).toBeGreaterThan(
          0,
        );
      }
    } finally {
      registry.shutdownAll();
      db.close();
    }
  });
});
