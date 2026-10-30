// Runs under `bun test` (see package.json `test:bun`), NOT vitest — see
// vite.config.ts `test.exclude`. The vitest runner can't resolve the
// `bun:sqlite` built-in used by the SUT.
import { describe, it, expect } from "bun:test";
import { BunSqliteDatabase } from "../BunSqliteDatabase";
import {
  SCHEMA_VERSION,
  SchemaVersionMismatchError,
  runMigrations,
} from "../schema";
import { SqliteConnectorRuntimeRepository } from "../SqliteConnectorRuntimeRepository";
import { legacyGeneratedBaseId } from "../legacyStartupInstances";
import type { ConnectorRuntimeSnapshot } from "../ConnectorRuntimeRepository";
import { OCPPStatus } from "../../types/OcppTypes";

/** Names of the tables in `db`. */
function tables(db: BunSqliteDatabase): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
    .map((t) => t.name);
}

describe("BunSqliteDatabase", () => {
  it("opens an in-memory DB and applies the schema", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const tables = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
      const names = tables.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "schema_meta",
          "scenarios",
          "connector_settings",
          "charging_profiles",
          "configuration",
          "pending_messages",
          "kv",
          "connector_runtime",
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("stamps the schema version on open", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const row = db.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'version'",
      );
      expect(row?.value).toBe(String(SCHEMA_VERSION));
    } finally {
      db.close();
    }
  });

  it("round-trips a row through run() and get()", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      db.run(
        "INSERT INTO kv (key, value) VALUES (?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        ["test", "hello"],
      );
      const row = db.get<{ value: string }>(
        "SELECT value FROM kv WHERE key = ?",
        ["test"],
      );
      expect(row?.value).toBe("hello");
    } finally {
      db.close();
    }
  });

  it("normalises booleans to 0/1", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      db.run(
        "INSERT INTO connector_settings (cp_id, connector_id, soc_meter_sync) VALUES (?, ?, ?)",
        ["cp1", 1, true],
      );
      const row = db.get<{ soc_meter_sync: number }>(
        "SELECT soc_meter_sync FROM connector_settings WHERE cp_id = ?",
        ["cp1"],
      );
      expect(row?.soc_meter_sync).toBe(1);
    } finally {
      db.close();
    }
  });

  it("round-trips a connector runtime snapshot with active transaction", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new SqliteConnectorRuntimeRepository(db);
      const startTime = new Date("2026-06-02T08:00:00.000Z");
      const snapshot: ConnectorRuntimeSnapshot = {
        status: OCPPStatus.Charging,
        availability: "Operative",
        scheduledAvailability: null,
        transaction: {
          id: 1583,
          connectorId: 1,
          tagId: "TAG001",
          meterStart: 0,
          meterStop: null,
          startTime,
          stopTime: null,
          meterSent: false,
          cpTransactionId: "cp-tx-abc",
          cpNextSeqNo: 1,
          cpLastTransactionEventChargingState: "SuspendedEVSE",
        },
        meterValueWh: 12345,
        socPercent: 42.5,
        lastAutoStartedScenarioKey: "essential-cp-behavior@1|oneshot",
      };
      repo.save("shiv3-cp7", 1, snapshot);
      const loaded = repo.load("shiv3-cp7", 1);
      expect(loaded).not.toBeNull();
      expect(loaded?.status).toBe(OCPPStatus.Charging);
      expect(loaded?.transaction?.id).toBe(1583);
      expect(loaded?.transaction?.tagId).toBe("TAG001");
      expect(loaded?.transaction?.cpTransactionId).toBe("cp-tx-abc");
      expect(loaded?.transaction?.cpNextSeqNo).toBe(1);
      expect(loaded?.transaction?.cpLastTransactionEventChargingState).toBe(
        "SuspendedEVSE",
      );
      // Date round-trip: JSON.stringify reduces Date to ISO string;
      // deserializeTransaction re-hydrates it. The instance identity
      // changes (toMatchObject doesn't help) so just compare the epoch.
      expect(loaded?.transaction?.startTime.getTime()).toBe(
        startTime.getTime(),
      );
      expect(loaded?.meterValueWh).toBe(12345);
      expect(loaded?.socPercent).toBe(42.5);
      expect(loaded?.lastAutoStartedScenarioKey).toBe(
        "essential-cp-behavior@1|oneshot",
      );
    } finally {
      db.close();
    }
  });

  it("clears a connector runtime row when transaction ends", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new SqliteConnectorRuntimeRepository(db);
      const base: ConnectorRuntimeSnapshot = {
        status: OCPPStatus.Available,
        availability: "Operative",
        scheduledAvailability: null,
        transaction: null,
        meterValueWh: 0,
        socPercent: null,
        lastAutoStartedScenarioKey: null,
      };
      repo.save("shiv3-cp7", 1, base);
      const loaded = repo.load("shiv3-cp7", 1);
      expect(loaded?.transaction).toBeNull();
      expect(loaded?.status).toBe(OCPPStatus.Available);
    } finally {
      db.close();
    }
  });

  it("deleteByCpId removes every connector row for that CP", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new SqliteConnectorRuntimeRepository(db);
      const snap: ConnectorRuntimeSnapshot = {
        status: OCPPStatus.Available,
        availability: "Operative",
        scheduledAvailability: null,
        transaction: null,
        meterValueWh: 0,
        socPercent: null,
        lastAutoStartedScenarioKey: null,
      };
      repo.save("cp-a", 1, snap);
      repo.save("cp-a", 2, snap);
      repo.save("cp-b", 1, snap);
      repo.deleteByCpId("cp-a");
      expect(repo.load("cp-a", 1)).toBeNull();
      expect(repo.load("cp-a", 2)).toBeNull();
      expect(repo.load("cp-b", 1)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("round-trips a scenario position when one is set", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new SqliteConnectorRuntimeRepository(db);
      const snap: ConnectorRuntimeSnapshot = {
        status: OCPPStatus.Charging,
        availability: "Operative",
        scheduledAvailability: null,
        transaction: null,
        meterValueWh: 12000,
        socPercent: null,
        lastAutoStartedScenarioKey: null,
        scenarioPosition: {
          scenarioKey: "essential-cp-behavior",
          lastCompletedNodeId: "tx-start",
          executedNodes: [
            "start-1",
            "delay-2s",
            "plug-in",
            "delay-1s",
            "trigger-remote-start",
            "tx-start",
          ],
        },
      };
      repo.save("shiv3-cp7", 1, snap);
      const loaded = repo.load("shiv3-cp7", 1);
      expect(loaded?.scenarioPosition?.lastCompletedNodeId).toBe("tx-start");
      expect(loaded?.scenarioPosition?.executedNodes).toEqual([
        "start-1",
        "delay-2s",
        "plug-in",
        "delay-1s",
        "trigger-remote-start",
        "tx-start",
      ]);
      expect(loaded?.scenarioPosition?.scenarioKey).toBe(
        "essential-cp-behavior",
      );
    } finally {
      db.close();
    }
  });

  it("treats absent scenarioPosition as null on load", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new SqliteConnectorRuntimeRepository(db);
      // Save without scenarioPosition — backward-compat path.
      const snap: ConnectorRuntimeSnapshot = {
        status: OCPPStatus.Available,
        availability: "Operative",
        scheduledAvailability: null,
        transaction: null,
        meterValueWh: 0,
        socPercent: null,
        lastAutoStartedScenarioKey: null,
      };
      repo.save("cp-a", 1, snap);
      const loaded = repo.load("cp-a", 1);
      // Implementation may return undefined or null depending on
      // serialisation path; both mean "no resume info, fresh start".
      expect(loaded?.scenarioPosition ?? null).toBeNull();
    } finally {
      db.close();
    }
  });

  it("clears scenarioPosition when saved as null", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new SqliteConnectorRuntimeRepository(db);
      repo.save("cp-a", 1, {
        status: OCPPStatus.Charging,
        availability: "Operative",
        scheduledAvailability: null,
        transaction: null,
        meterValueWh: 0,
        socPercent: null,
        lastAutoStartedScenarioKey: null,
        scenarioPosition: {
          scenarioKey: "x",
          lastCompletedNodeId: "n1",
          executedNodes: ["n1"],
        },
      });
      // Same row again, this time with scenarioPosition explicitly null
      // (simulates the scenario-finished cleanup path).
      repo.save("cp-a", 1, {
        status: OCPPStatus.Available,
        availability: "Operative",
        scheduledAvailability: null,
        transaction: null,
        meterValueWh: 0,
        socPercent: null,
        lastAutoStartedScenarioKey: null,
        scenarioPosition: null,
      });
      const loaded = repo.load("cp-a", 1);
      expect(loaded?.scenarioPosition ?? null).toBeNull();
    } finally {
      db.close();
    }
  });

  it("refuses to open a DB whose schema version is newer than the build", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      // Simulate a future-version DB by stamping a newer value before
      // re-running migrations.
      db.run(
        "INSERT INTO schema_meta (key, value) VALUES ('version', ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [String(SCHEMA_VERSION + 1)],
      );
      expect(() => runMigrations(db)).toThrow(SchemaVersionMismatchError);
    } finally {
      db.close();
    }
  });
});

describe("connector_runtime.soc_awaits_next_transaction (#301)", () => {
  const base: ConnectorRuntimeSnapshot = {
    status: OCPPStatus.Charging,
    availability: "Operative",
    scheduledAvailability: null,
    transaction: null,
    meterValueWh: 4200,
    socPercent: 82.3,
    lastAutoStartedScenarioKey: null,
  };

  it("round-trips the waiting marker", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new SqliteConnectorRuntimeRepository(db);
      repo.save("cp-soc", 1, { ...base, socAwaitsNextTransaction: true });
      expect(repo.load("cp-soc", 1)?.socAwaitsNextTransaction).toBe(true);

      repo.save("cp-soc", 2, { ...base, socAwaitsNextTransaction: false });
      expect(repo.load("cp-soc", 2)?.socAwaitsNextTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it("updates the marker on conflict rather than keeping the first write", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new SqliteConnectorRuntimeRepository(db);
      repo.save("cp-soc", 1, { ...base, socAwaitsNextTransaction: true });
      repo.save("cp-soc", 1, { ...base, socAwaitsNextTransaction: false });
      expect(repo.load("cp-soc", 1)?.socAwaitsNextTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it("reads a pre-v12 row, which has no column value, as not waiting", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      // Simulate the migrated-in column on a row written before it existed:
      // ALTER TABLE ADD COLUMN leaves NULL on every existing row, and the
      // fresh CREATE TABLE declares the column nullable for exactly that
      // reason — a fresh DB and a migrated one must not differ.
      const repo = new SqliteConnectorRuntimeRepository(db);
      repo.save("cp-soc", 1, { ...base, socAwaitsNextTransaction: true });
      db.run(
        "UPDATE connector_runtime SET soc_awaits_next_transaction = NULL " +
          "WHERE cp_id = ? AND connector_id = ?",
        ["cp-soc", 1],
      );
      expect(repo.load("cp-soc", 1)?.socAwaitsNextTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it("migrates an existing v10 database by adding the column", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      // Rebuild the pre-v12 shape: drop the column and stamp version 10.
      db.exec("DROP TABLE connector_runtime");
      db.exec(
        "CREATE TABLE connector_runtime (" +
          "cp_id TEXT NOT NULL, connector_id INTEGER NOT NULL, " +
          "status TEXT NOT NULL, availability TEXT NOT NULL, " +
          "scheduled_availability TEXT, transaction_json TEXT, " +
          "meter_value_wh INTEGER NOT NULL DEFAULT 0, soc_percent REAL, " +
          "last_auto_started_scenario_key TEXT, scenario_position_json TEXT, " +
          "updated_at TEXT NOT NULL, PRIMARY KEY (cp_id, connector_id))",
      );
      db.run(
        "INSERT INTO schema_meta (key, value) VALUES ('version', '10') " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      );
      runMigrations(db);

      const cols = db.all<{ name: string }>(
        "PRAGMA table_info(connector_runtime)",
      );
      expect(cols.map((c) => c.name)).toContain("soc_awaits_next_transaction");
      const version = db.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'version'",
      );
      expect(Number(version?.value)).toBe(SCHEMA_VERSION);

      const repo = new SqliteConnectorRuntimeRepository(db);
      repo.save("cp-soc", 1, { ...base, socAwaitsNextTransaction: true });
      expect(repo.load("cp-soc", 1)?.socAwaitsNextTransaction).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("file hot-reload schema, v13 (#314)", () => {
  /** Strip everything v13 adds and stamp the database at `version`. */
  function rewindTo(db: BunSqliteDatabase, version: number): void {
    db.exec("DROP TABLE IF EXISTS watched_scenario_files");
    // SQLite cannot drop a column on older engines, so rebuild
    // `charge_points` without `id_tag_file` from the shape v9 left.
    db.exec("DROP TABLE IF EXISTS charge_points");
    db.exec(
      "CREATE TABLE charge_points (" +
        "cp_id TEXT PRIMARY KEY, ws_url TEXT NOT NULL, " +
        "supervision_urls TEXT, url_distribution TEXT, " +
        "id_tags TEXT, id_tag_distribution TEXT, " +
        "connectors INTEGER NOT NULL, vendor TEXT NOT NULL, " +
        "model TEXT NOT NULL, ocpp_version TEXT, central_system_url TEXT, " +
        "soap_callback_url TEXT, soap_path TEXT, security_profile INTEGER, " +
        "authorization_key TEXT, cpo_name TEXT, tls_ca_path TEXT, " +
        "tls_cert_path TEXT, tls_key_path TEXT, basic_auth TEXT, " +
        "boot_notif TEXT, created_at TEXT NOT NULL)",
    );
    db.run(
      "INSERT INTO schema_meta (key, value) VALUES ('version', ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [String(version)],
    );
  }

  function columns(db: BunSqliteDatabase, table: string): string[] {
    return db
      .all<{ name: string }>(`PRAGMA table_info(${table})`)
      .map((c) => c.name);
  }

  it("migrates a database `main` stamped 12 — the released number", () => {
    // The case the renumber exists for. A database that came from `main` has
    // `soc_awaits_next_transaction` and neither of this feature's tables, and
    // one `stored < 13` step has to create both. This branch developed against
    // 11 and then 12; both were taken on `main` before it merged, so the whole
    // feature moved to 13 rather than skipping a number silently.
    const db = BunSqliteDatabase.open(":memory:");
    try {
      rewindTo(db, 12);
      expect(columns(db, "charge_points")).not.toContain("id_tag_file");
      expect(tables(db)).not.toContain("watched_scenario_files");
      // `main` at 12 has this column, and the rewind must not have removed it.
      expect(columns(db, "connector_runtime")).toContain(
        "soc_awaits_next_transaction",
      );

      runMigrations(db);

      expect(columns(db, "charge_points")).toContain("id_tag_file");
      expect(tables(db)).toContain("watched_scenario_files");
      expect(columns(db, "connector_runtime")).toContain(
        "soc_awaits_next_transaction",
      );
      const version = db.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'version'",
      );
      expect(Number(version?.value)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("is a no-op on a database an earlier build of this branch stamped 11 or 12", () => {
    // Those builds already created one or both of these. The step has to be
    // idempotent — `CREATE TABLE IF NOT EXISTS` and a `PRAGMA table_info`
    // guard — or an operator who ran a pre-renumber build cannot start at all.
    for (const stamped of [11, 12]) {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        // Fully migrated by this build, then re-stamped at the old number: the
        // shape an earlier build of this branch left behind.
        db.run(
          "INSERT INTO schema_meta (key, value) VALUES ('version', ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          [String(stamped)],
        );
        db.run(
          "INSERT INTO watched_scenario_files " +
            "(cp_id, connector_id, scenario_id, path) VALUES (?, ?, ?, ?)",
          ["cp-1", 1, "s-1", "/tmp/s.json"],
        );

        expect(() => runMigrations(db)).not.toThrow();

        expect(columns(db, "charge_points")).toContain("id_tag_file");
        expect(tables(db)).toContain("watched_scenario_files");
        // Re-running the step must not have dropped and re-created the table.
        expect(db.all("SELECT cp_id FROM watched_scenario_files")).toHaveLength(
          1,
        );
        const version = db.get<{ value: string }>(
          "SELECT value FROM schema_meta WHERE key = 'version'",
        );
        expect(Number(version?.value)).toBe(SCHEMA_VERSION);
      } finally {
        db.close();
      }
    }
  });

  it("migrates a fresh pre-feature database in one step", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      rewindTo(db, 10);
      runMigrations(db);
      expect(columns(db, "charge_points")).toContain("id_tag_file");
      expect(tables(db)).toContain("watched_scenario_files");
    } finally {
      db.close();
    }
  });
});

describe("scenario run history schema, v14 (#388)", () => {
  it("creates scenario_runs on a database stamped 13", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      db.exec("DROP TABLE scenario_runs");
      db.run("UPDATE schema_meta SET value = '13' WHERE key = 'version'");
      expect(tables(db)).not.toContain("scenario_runs");

      runMigrations(db);

      expect(tables(db)).toContain("scenario_runs");
      const version = db.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'version'",
      );
      expect(Number(version?.value)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});

describe("vehicle profiles schema, v15 (#458)", () => {
  it("creates vehicle_profiles on a database stamped 14", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      db.exec("DROP TABLE vehicle_profiles");
      db.run("UPDATE schema_meta SET value = '14' WHERE key = 'version'");
      expect(tables(db)).not.toContain("vehicle_profiles");

      runMigrations(db);

      expect(tables(db)).toContain("vehicle_profiles");
      const columns = db
        .all<{ name: string }>("PRAGMA table_info(vehicle_profiles)")
        .map((c) => c.name);
      expect(columns).toEqual(["id", "name", "body", "updated_at"]);
      const version = db.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'version'",
      );
      expect(Number(version?.value)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});

describe("charge-point labels schema, v16 (#446)", () => {
  it("adds the labels column to a database stamped 15 and keeps its rows", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      // The v15 shape of `charge_points`: everything but `labels`.
      db.exec("DROP TABLE charge_points");
      db.exec(
        "CREATE TABLE charge_points (" +
          "cp_id TEXT PRIMARY KEY, ws_url TEXT NOT NULL, " +
          "supervision_urls TEXT, url_distribution TEXT, " +
          "id_tags TEXT, id_tag_distribution TEXT, id_tag_file TEXT, " +
          "connectors INTEGER NOT NULL, vendor TEXT NOT NULL, " +
          "model TEXT NOT NULL, ocpp_version TEXT, central_system_url TEXT, " +
          "soap_callback_url TEXT, soap_path TEXT, security_profile INTEGER, " +
          "authorization_key TEXT, cpo_name TEXT, tls_ca_path TEXT, " +
          "tls_cert_path TEXT, tls_key_path TEXT, basic_auth TEXT, " +
          "boot_notif TEXT, created_at TEXT NOT NULL)",
      );
      db.run(
        "INSERT INTO charge_points (cp_id, ws_url, connectors, vendor, model, created_at) " +
          "VALUES ('CP1', 'ws://h', 1, 'v', 'm', '2026-10-27T00:00:00Z')",
      );
      db.run("UPDATE schema_meta SET value = '15' WHERE key = 'version'");

      runMigrations(db);

      const columns = db
        .all<{ name: string }>("PRAGMA table_info(charge_points)")
        .map((c) => c.name);
      expect(columns).toContain("labels");
      const row = db.get<{ cp_id: string; labels: string | null }>(
        "SELECT cp_id, labels FROM charge_points",
      );
      expect(row).toEqual({ cp_id: "CP1", labels: null });
      const version = db.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'version'",
      );
      expect(Number(version?.value)).toBe(SCHEMA_VERSION);

      // Re-running the step on a migrated database is a no-op, not an error.
      db.run("UPDATE schema_meta SET value = '15' WHERE key = 'version'");
      expect(() => runMigrations(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("charging sessions schema, v17 (#447)", () => {
  it("creates charging_sessions on a database stamped 16", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      db.exec("DROP TABLE charging_sessions");
      db.run("UPDATE schema_meta SET value = '16' WHERE key = 'version'");
      expect(tables(db)).not.toContain("charging_sessions");

      runMigrations(db);

      expect(tables(db)).toContain("charging_sessions");
      const version = db.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'version'",
      );
      expect(Number(version?.value)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("creates authorization_cache on a database stamped 17", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      db.exec("DROP TABLE authorization_cache");
      db.run("UPDATE schema_meta SET value = '17' WHERE key = 'version'");
      expect(tables(db)).not.toContain("authorization_cache");

      runMigrations(db);

      expect(tables(db)).toContain("authorization_cache");
      const version = db.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'version'",
      );
      expect(Number(version?.value)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});

describe("certificates schema, v18 (#456)", () => {
  it("creates certificates on a database stamped 17", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      db.exec("DROP TABLE certificates");
      db.run("UPDATE schema_meta SET value = '17' WHERE key = 'version'");
      expect(tables(db)).not.toContain("certificates");

      runMigrations(db);

      expect(tables(db)).toContain("certificates");
      const version = db.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'version'",
      );
      expect(Number(version?.value)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});

describe("startup scenario provenance schema, v19 (#338)", () => {
  /** The v17 `scenarios` table, which has no `startup_source` column. */
  function rebuildV17Scenarios(db: BunSqliteDatabase): void {
    db.exec("DROP TABLE scenarios");
    db.exec(
      "CREATE TABLE scenarios (" +
        "cp_id TEXT NOT NULL, connector_id INTEGER NOT NULL, " +
        "scenario_id TEXT NOT NULL, name TEXT NOT NULL, " +
        "enabled INTEGER NOT NULL, updated_at TEXT NOT NULL, " +
        "definition TEXT NOT NULL, " +
        "PRIMARY KEY (cp_id, connector_id, scenario_id))",
    );
    db.run("UPDATE schema_meta SET value = '17' WHERE key = 'version'");
  }

  it("recognises exactly the ids older builds generated", () => {
    // Table test of the two shapes the deleted prunes matched: the
    // `-<epoch ms>` suffix `--scenario` minted through 0f6f951, and the
    // template instance id minted through v0.9.0. Anchored on a 13+ digit
    // epoch, on the row's own connector and (templates) charge point.
    const cases: Array<[string, number, string, string | null]> = [
      ["CP", 1, "demo-c1-1757200000000", "demo"],
      ["CP", 2, "demo-c2-17572000000001", "demo"],
      ["CP", 1, "a.b-c1-1757200000000", "a.b"],
      [
        "CP",
        1,
        "essential-cp-behavior-CP-c1-1760000000000-abc123",
        "essential-cp-behavior",
      ],
      [
        "C.P",
        3,
        "full-charging-cycle-C.P-c3-1760000000000-z9",
        "full-charging-cycle",
      ],
      // Not generated: no epoch, a short number, another connector, another
      // charge point, a trailing word.
      ["CP", 1, "demo-c1", null],
      ["CP", 1, "demo", null],
      ["CP", 1, "demo-c1-manual", null],
      ["CP", 1, "demo-c1-42", null],
      ["CP", 1, "demo-c1-202610291200", null],
      ["CP", 1, "demo-c2-1757200000000", null],
      ["CP", 1, "essential-cp-behavior-OTHER-c1-1760000000000-abc123", null],
      ["CP", 1, "essential-cp-behavior-CP-c1-123-abc123", null],
      ["CP", 1, "essential-cp-behavior-CP-c1-1760000000000-ABC", null],
      ["CP", 1, "demo-c1-1757200000000-final", null],
      ["CP", 1, "user-authored", null],
    ];
    for (const [cpId, connectorId, id, base] of cases) {
      expect({
        id,
        base: legacyGeneratedBaseId(cpId, connectorId, id),
      }).toEqual({ id, base });
    }
  });

  it("adds a nullable startup_source column, keeps every row and marks only generated legacy ids", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      rebuildV17Scenarios(db);
      // What a v17 database can hold: a user scenario, a stable startup id
      // (#314) and the clock-suffixed ids older builds minted.
      const ids = [
        "user-authored",
        "demo-c1",
        "demo-c1-1757200000000",
        "essential-cp-behavior-CP-c1-1760000000000-abc123",
      ];
      for (const id of ids) {
        db.run(
          "INSERT INTO scenarios (cp_id, connector_id, scenario_id, name, " +
            "enabled, updated_at, definition) VALUES ('CP', 1, ?, ?, 1, " +
            "'2026-10-01T00:00:00Z', '{}')",
          [id, id],
        );
      }

      runMigrations(db);

      const columns = db
        .all<{ name: string }>("PRAGMA table_info(scenarios)")
        .map((c) => c.name);
      expect(columns).toContain("startup_source");
      // Nothing dropped. The two clock-suffixed ids are recorded as legacy
      // generated instances of their base; everything else — including the
      // stable `demo-c1`, which could as well be an operator's — stays NULL.
      const rows = db.all<{ scenario_id: string; startup_source: unknown }>(
        "SELECT scenario_id, startup_source FROM scenarios ORDER BY scenario_id",
      );
      expect(rows).toEqual([
        { scenario_id: "demo-c1", startup_source: null },
        { scenario_id: "demo-c1-1757200000000", startup_source: "legacy:demo" },
        {
          scenario_id: "essential-cp-behavior-CP-c1-1760000000000-abc123",
          startup_source: "legacy:essential-cp-behavior",
        },
        { scenario_id: "user-authored", startup_source: null },
      ]);
      const version = db.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'version'",
      );
      expect(Number(version?.value)).toBe(SCHEMA_VERSION);

      // Re-running the step on a migrated database is a no-op, not an error.
      db.run("UPDATE schema_meta SET value = '17' WHERE key = 'version'");
      expect(() => runMigrations(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("variable monitors schema, v21 (#457)", () => {
  it("creates variable_monitors on a database stamped 17", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      db.exec("DROP TABLE variable_monitors");
      db.run("UPDATE schema_meta SET value = '17' WHERE key = 'version'");
      expect(tables(db)).not.toContain("variable_monitors");

      runMigrations(db);

      expect(tables(db)).toContain("variable_monitors");
      const version = db.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'version'",
      );
      expect(Number(version?.value)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
