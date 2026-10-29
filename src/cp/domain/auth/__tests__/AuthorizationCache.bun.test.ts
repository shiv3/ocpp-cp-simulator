// Runs under `bun test` (bun:sqlite), not vitest.
import { describe, expect, it } from "bun:test";
import { BunSqliteDatabase } from "../../persistence/BunSqliteDatabase";
import { AuthorizationCache } from "../AuthorizationCache";
import { ChargePoint } from "../../charge-point/ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import type { Database } from "../../persistence/Database";

function chargePointOn(db: Database): ChargePoint {
  return new ChargePoint(
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

describe("AuthorizationCache persistence (1.6 §3.5.1, errata 3.4, C10.FR.02)", () => {
  it("survives a restart: a new cache on the same database sees the entries", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = new AuthorizationCache("CP1", db, { now: () => T0 });
      first.upsert({
        idToken: "A",
        status: "Accepted",
        expiresAt: T0 + 3_600_000,
        parentId: "PARENT",
      });
      first.upsert({ idToken: "B", status: "Blocked" });

      const restarted = new AuthorizationCache("CP1", db, {
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
      const cp1 = new AuthorizationCache("CP1", db, { now: () => T0 });
      const cp2 = new AuthorizationCache("CP2", db, { now: () => T0 });
      cp1.upsert({ idToken: "A", status: "Accepted" });
      cp1.upsert({ idToken: "B", status: "Accepted" });
      cp2.upsert({ idToken: "A", status: "Accepted" });

      cp1.upsert({ idToken: "A", status: "Invalid" });
      cp1.remove("B");
      expect(new AuthorizationCache("CP1", db).all()).toEqual([
        expect.objectContaining({ idToken: "A", status: "Invalid" }),
      ]);

      cp1.clear();
      expect(new AuthorizationCache("CP1", db).size()).toBe(0);
      expect(new AuthorizationCache("CP2", db).size()).toBe(1);
    } finally {
      db.close();
    }
  });

  it("persists evictions", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      let now = T0;
      const cache = new AuthorizationCache("CP1", db, {
        now: () => now,
        maxEntries: 1,
      });
      cache.upsert({ idToken: "A", status: "Accepted" });
      now += 1;
      cache.upsert({ idToken: "B", status: "Accepted" });
      expect(
        new AuthorizationCache("CP1", db, { maxEntries: 1 })
          .all()
          .map((e) => e.idToken),
      ).toEqual(["B"]);
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
