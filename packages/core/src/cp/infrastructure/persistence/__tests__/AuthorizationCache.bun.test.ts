// Runs under `bun test` (bun:sqlite), not vitest.
import { describe, expect, it } from "bun:test";
import { BunSqliteDatabase } from "../BunSqliteDatabase";
import { SqliteAuthorizationCacheRepository } from "../SqliteAuthorizationCacheRepository";
import {
  AuthorizationCache,
  type AuthorizationCacheOptions,
} from "../../../domain/auth/AuthorizationCache";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { createChargePoint } from "../../charge-point/createChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import type { Database } from "../../../domain/persistence/Database";

/** The cache of `cpId`, on its rows of `db`'s `authorization_cache`. */
function cacheOn(
  db: Database,
  cpId: string,
  options?: AuthorizationCacheOptions,
): AuthorizationCache {
  return new AuthorizationCache(
    cpId,
    new SqliteAuthorizationCacheRepository(cpId, db),
    options,
  );
}

function chargePointOn(db: Database): ChargePoint {
  return createChargePoint(
    "CP-452-RESTART",
    DefaultBootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    db,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
}

const T0 = Date.parse("2026-10-29T12:00:00Z");

describe("SqliteAuthorizationCacheRepository (#878)", () => {
  it("round-trips entries per charge point, optional fields included", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new SqliteAuthorizationCacheRepository("CP1", db);
      expect(repo.loadAll()).toEqual([]);
      repo.upsert({
        idToken: "A",
        status: "Accepted",
        expiresAt: T0 + 3_600_000,
        parentId: "PARENT",
        insertedAt: T0,
        updatedAt: T0,
      });
      repo.upsert({
        idToken: "B",
        status: "Blocked",
        insertedAt: T0,
        updatedAt: T0,
      });
      // An update keeps the stored insertion time.
      repo.upsert({
        idToken: "B",
        status: "Invalid",
        insertedAt: T0 + 5,
        updatedAt: T0 + 10,
      });
      new SqliteAuthorizationCacheRepository("CP2", db).upsert({
        idToken: "C",
        status: "Accepted",
        insertedAt: T0,
        updatedAt: T0,
      });

      const byToken = (a: { idToken: string }, b: { idToken: string }) =>
        a.idToken.localeCompare(b.idToken);
      expect(
        new SqliteAuthorizationCacheRepository("CP1", db)
          .loadAll()
          .sort(byToken),
      ).toEqual([
        {
          idToken: "A",
          status: "Accepted",
          expiresAt: T0 + 3_600_000,
          parentId: "PARENT",
          insertedAt: T0,
          updatedAt: T0,
        },
        {
          idToken: "B",
          status: "Invalid",
          insertedAt: T0,
          updatedAt: T0 + 10,
        },
      ]);

      repo.delete("A");
      expect(repo.loadAll().map((e) => e.idToken)).toEqual(["B"]);
      repo.clear();
      expect(repo.loadAll()).toEqual([]);
      expect(
        new SqliteAuthorizationCacheRepository("CP2", db)
          .loadAll()
          .map((e) => e.idToken),
      ).toEqual(["C"]);
    } finally {
      db.close();
    }
  });
});

describe("AuthorizationCache persistence (1.6 §3.5.1, errata 3.4, C10.FR.02)", () => {
  it("survives a restart: a new cache on the same database sees the entries", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = cacheOn(db, "CP1", { now: () => T0 });
      first.upsert({
        idToken: "A",
        status: "Accepted",
        expiresAt: T0 + 3_600_000,
        parentId: "PARENT",
      });
      first.upsert({ idToken: "B", status: "Blocked" });

      const restarted = cacheOn(db, "CP1", {
        now: () => T0 + 1,
      });
      expect(restarted.get("A")).toEqual({
        idToken: "A",
        status: "Accepted",
        expiresAt: T0 + 3_600_000,
        parentId: "PARENT",
        insertedAt: T0,
        updatedAt: T0,
      });
      expect(restarted.get("B")).toEqual({
        idToken: "B",
        status: "Blocked",
        insertedAt: T0,
        updatedAt: T0,
      });
    } finally {
      db.close();
    }
  });

  it("persists updates, removals and clear, scoped to its charge point", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const cp1 = cacheOn(db, "CP1", { now: () => T0 });
      const cp2 = cacheOn(db, "CP2", { now: () => T0 });
      cp1.upsert({ idToken: "A", status: "Accepted" });
      cp1.upsert({ idToken: "B", status: "Accepted" });
      cp2.upsert({ idToken: "A", status: "Accepted" });

      cp1.upsert({ idToken: "A", status: "Invalid" });
      cp1.remove("B");
      expect(cacheOn(db, "CP1").all()).toEqual([
        expect.objectContaining({ idToken: "A", status: "Invalid" }),
      ]);

      cp1.clear();
      expect(cacheOn(db, "CP1").size()).toBe(0);
      expect(cacheOn(db, "CP2").size()).toBe(1);
    } finally {
      db.close();
    }
  });

  it("persists evictions", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      let now = T0;
      const cache = cacheOn(db, "CP1", {
        now: () => now,
        maxEntries: 1,
      });
      cache.upsert({ idToken: "A", status: "Accepted" });
      now += 1;
      cache.upsert({ idToken: "B", status: "Accepted" });
      expect(
        cacheOn(db, "CP1", { maxEntries: 1 })
          .all()
          .map((e) => e.idToken),
      ).toEqual(["B"]);
    } finally {
      db.close();
    }
  });
});

describe("AuthorizationCache — case-insensitive identifiers (#452)", () => {
  const rows = (db: Database) =>
    db.all<{ id_token: string; status: string }>(
      "SELECT id_token, status FROM authorization_cache WHERE cp_id = ? ORDER BY id_token",
      ["CP1"],
    );

  it("an update under another spelling replaces the row", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const cache = cacheOn(db, "CP1", { now: () => T0 });
      cache.upsert({ idToken: "ABC", status: "Accepted" });
      cache.upsert({ idToken: "abc", status: "Blocked" });
      expect(rows(db)).toEqual([{ id_token: "abc", status: "Blocked" }]);
      expect(cache.remove("ABC")).toBe(true);
      expect(rows(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("restore folds rows spelt differently: the newest wins, the others go", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const insert = (idToken: string, status: string, at: number) =>
        db.run(
          "INSERT INTO authorization_cache " +
            "(cp_id, id_token, status, expires_at, parent_id, inserted_at, updated_at) " +
            "VALUES (?, ?, ?, NULL, NULL, ?, ?)",
          [
            "CP1",
            idToken,
            status,
            new Date(at).toISOString(),
            new Date(at).toISOString(),
          ],
        );
      insert("ABC", "Accepted", T0);
      insert("abc", "Blocked", T0 + 1000);
      insert("Abc", "Invalid", T0 + 500);

      const cache = cacheOn(db, "CP1", { now: () => T0 + 2000 });
      expect(cache.size()).toBe(1);
      expect(cache.get("ABC")).toMatchObject({
        idToken: "abc",
        status: "Blocked",
      });
      expect(rows(db)).toEqual([{ id_token: "abc", status: "Blocked" }]);
    } finally {
      db.close();
    }
  });
});

describe("ChargePoint restart with --state-db (issue test 8)", () => {
  it("a restarted charge point authorizes offline from the cache it had before", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const before = chargePointOn(db);
      before.configuration.applyChange("AuthorizationCacheEnabled", "true");
      before.recordAuthorizationResult("TAG-R", { status: "Accepted" });
      before.dispose();

      const after = chargePointOn(db);
      expect(after.configuration.authorizationCacheEnabled()).toBe(true);
      expect(after.authorization.cache.get("TAG-R")?.status).toBe("Accepted");
      expect(after.isOnline()).toBe(false);
      expect(await after.startTransaction("TAG-R", 1)).toEqual({
        started: true,
      });
      after.dispose();
    } finally {
      db.close();
    }
  });
});
