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
import type { ConnectorRuntimeSnapshot } from "../ConnectorRuntimeRepository";
import { OCPPStatus } from "../../types/OcppTypes";

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
