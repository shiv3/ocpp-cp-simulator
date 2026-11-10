// The `node:sqlite` adapter (#916). Runs under vitest, i.e. on Node; the Bun
// adapter has BunSqliteDatabase.bun.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  NodeSqliteDatabase,
  withoutSqliteExperimentalWarning,
} from "../NodeSqliteDatabase";
import { openSqliteDatabase } from "../openSqliteDatabase";
import { SCHEMA_VERSION } from "../schema";

const dir = mkdtempSync(path.join(tmpdir(), "node-sqlite-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("NodeSqliteDatabase", () => {
  it("opens an in-memory DB and applies the schema", () => {
    const db = NodeSqliteDatabase.open(":memory:");
    try {
      const names = db
        .all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(["schema_meta", "kv", "connector_runtime"]),
      );
      expect(
        db.get<{ value: string }>(
          "SELECT value FROM schema_meta WHERE key = 'version'",
        )?.value,
      ).toBe(String(SCHEMA_VERSION));
    } finally {
      db.close();
    }
  });

  it("round-trips rows as plain objects and answers null for no row", () => {
    const db = NodeSqliteDatabase.open(":memory:");
    try {
      db.run("INSERT INTO kv (key, value) VALUES (?, ?)", ["a", "1"]);
      const row = db.get<{ value: string }>(
        "SELECT value FROM kv WHERE key = ?",
        ["a"],
      );
      expect(row).toEqual({ value: "1" });
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(db.get("SELECT value FROM kv WHERE key = ?", ["b"])).toBeNull();
      expect(db.all("SELECT key FROM kv")).toEqual([{ key: "a" }]);
    } finally {
      db.close();
    }
  });

  it("binds booleans as 0/1, and null and bytes as they are", () => {
    const db = NodeSqliteDatabase.open(":memory:");
    try {
      db.exec("CREATE TABLE t (b INTEGER, n TEXT, blob BLOB)");
      db.run("INSERT INTO t VALUES (?, ?, ?)", [
        true,
        null,
        new Uint8Array([1, 2]),
      ]);
      db.run("INSERT INTO t VALUES (?, ?, ?)", [false, "x", null]);
      const rows = db.all<{ b: number; n: string | null; blob: unknown }>(
        "SELECT b, n, blob FROM t ORDER BY rowid",
      );
      expect(rows.map((r) => r.b)).toEqual([1, 0]);
      expect(rows[0]!.n).toBeNull();
      expect([...(rows[0]!.blob as Uint8Array)]).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });

  it("creates the parent directory and keeps the data across reopen", () => {
    const file = path.join(dir, "nested", "deeper", "state.db");
    const first = NodeSqliteDatabase.open(file);
    first.run("INSERT INTO kv (key, value) VALUES (?, ?)", ["k", "v"]);
    first.close();
    const second = NodeSqliteDatabase.open(file);
    try {
      expect(
        second.get<{ value: string }>("SELECT value FROM kv WHERE key = 'k'")
          ?.value,
      ).toBe("v");
      expect(
        second.get<{ journal_mode: string }>("PRAGMA journal_mode")
          ?.journal_mode,
      ).toBe("wal");
    } finally {
      second.close();
    }
  });

  it("drops node:sqlite's experimental warning and lets others through", () => {
    const seen: unknown[][] = [];
    const spy = vi
      .spyOn(process, "emitWarning")
      .mockImplementation((...args: unknown[]) => {
        seen.push(args);
      });
    try {
      const value = withoutSqliteExperimentalWarning(() => {
        process.emitWarning(
          "SQLite is an experimental feature and might change at any time",
          "ExperimentalWarning",
        );
        process.emitWarning("SQLite is an experimental feature", {
          type: "ExperimentalWarning",
        });
        process.emitWarning("Something else", "ExperimentalWarning");
        process.emitWarning("sqlite deprecation", "DeprecationWarning");
        return 7;
      });
      expect(value).toBe(7);
      expect(seen.map((a) => a[0])).toEqual([
        "Something else",
        "sqlite deprecation",
      ]);
    } finally {
      spy.mockRestore();
    }
    // Restored afterwards.
    expect(process.emitWarning).not.toBe(spy);
  });
});

describe("openSqliteDatabase", () => {
  it("opens the node:sqlite adapter on Node", async () => {
    const db = await openSqliteDatabase(":memory:");
    try {
      expect(db).toBeInstanceOf(NodeSqliteDatabase);
    } finally {
      db.close();
    }
  });
});
