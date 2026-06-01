// Runs under `bun test` (see package.json `test:bun`), NOT vitest — see
// vite.config.ts `test.exclude`. The vitest runner can't resolve the
// `bun:sqlite` built-in used by the SUT.
import { describe, it, expect } from "bun:test";
import { BunSqliteDatabase } from "../BunSqliteDatabase";
import { SCHEMA_VERSION } from "../schema";

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
});
