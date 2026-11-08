// Runs under `bun test`: the daemon's `bun:sqlite` database.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BunSqliteDatabase } from "../BunSqliteDatabase";
import {
  LEGACY_SCHEMA_VERSION,
  MIGRATIONS,
  latestVersion,
  validateMigrations,
  type Migration,
} from "../migrations";
import { SCHEMA_VERSION, runMigrations } from "../schema";

describe("schema migration guard", () => {
  it("the registered migrations are unique, contiguous and ascending", () => {
    expect(validateMigrations(MIGRATIONS)).toEqual([]);
  });

  it("SCHEMA_VERSION is the last migration (or the legacy version)", () => {
    expect(SCHEMA_VERSION).toBe(latestVersion(MIGRATIONS));
    if (MIGRATIONS.length === 0) {
      expect(SCHEMA_VERSION).toBe(LEGACY_SCHEMA_VERSION);
    }
  });

  it("the legacy branches are ascending, unique and end at LEGACY_SCHEMA_VERSION", () => {
    const source = readFileSync(join(import.meta.dir, "../schema.ts"), "utf8");
    const gates = [...source.matchAll(/if \(stored < (\d+)\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(gates.length).toBeGreaterThan(0);
    expect(gates).toEqual([...new Set(gates)].sort((a, b) => a - b));
    expect(gates[gates.length - 1]).toBe(LEGACY_SCHEMA_VERSION);
  });

  it("detects duplicate, skipped and out-of-order versions", () => {
    const m = (version: number): Migration => ({
      version,
      name: `v${version}`,
      up: () => {},
    });
    const next = LEGACY_SCHEMA_VERSION + 1;
    expect(validateMigrations([m(next), m(next + 1)])).toEqual([]);
    expect(validateMigrations([m(next), m(next)])).toHaveLength(1);
    expect(validateMigrations([m(next + 1)])).toHaveLength(1);
    expect(validateMigrations([m(next + 1), m(next)])).not.toEqual([]);
  });
});

describe("runMigrations with file migrations", () => {
  const addColumn: Migration = {
    version: LEGACY_SCHEMA_VERSION + 1,
    name: "test-column",
    up(db) {
      db.exec("ALTER TABLE charge_points ADD COLUMN test_column TEXT");
    },
  };

  it("applies a migration newer than the stored version, once", () => {
    const db = BunSqliteDatabase.open(":memory:");
    runMigrations(db);
    runMigrations(db, [addColumn]);
    runMigrations(db, [addColumn]);
    const cols = db.all<{ name: string }>("PRAGMA table_info(charge_points)");
    expect(cols.some((c) => c.name === "test_column")).toBe(true);
    const row = db.get<{ value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'version'",
    );
    expect(Number(row?.value)).toBe(addColumn.version);
  });

  it("refuses a database written by a newer schema", () => {
    const db = BunSqliteDatabase.open(":memory:");
    runMigrations(db, [addColumn]);
    expect(() => runMigrations(db)).toThrow();
  });
});
