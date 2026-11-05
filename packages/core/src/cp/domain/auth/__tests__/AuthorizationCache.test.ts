import { describe, expect, it } from "vitest";
import { AuthorizationCache } from "../AuthorizationCache";

function clock(start = Date.parse("2026-10-29T12:00:00Z")) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("AuthorizationCache (in memory)", () => {
  it("starts empty", () => {
    const cache = new AuthorizationCache("CP");
    expect(cache.size()).toBe(0);
    expect(cache.get("A")).toBeUndefined();
  });

  it("stores an entry with its status, expiry, parent id and timestamps", () => {
    const c = clock();
    const cache = new AuthorizationCache("CP", null, { now: c.now });
    cache.upsert({
      idToken: "A",
      status: "Accepted",
      expiresAt: c.now() + 60_000,
      parentId: "PARENT",
    });
    expect(cache.get("A")).toEqual({
      idToken: "A",
      status: "Accepted",
      expiresAt: c.now() + 60_000,
      parentId: "PARENT",
      insertedAt: c.now(),
      updatedAt: c.now(),
    });
  });

  it("updates an existing entry, keeping its insertion time (§3.5.1, C12.FR.06)", () => {
    const c = clock();
    const cache = new AuthorizationCache("CP", null, { now: c.now });
    cache.upsert({ idToken: "A", status: "Accepted", parentId: "P" });
    const inserted = c.now();
    c.advance(5000);
    cache.upsert({ idToken: "A", status: "Blocked" });
    expect(cache.get("A")).toEqual({
      idToken: "A",
      status: "Blocked",
      insertedAt: inserted,
      updatedAt: inserted + 5000,
    });
    expect(cache.size()).toBe(1);
  });

  it("removes and clears entries", () => {
    const cache = new AuthorizationCache("CP");
    cache.upsert({ idToken: "A", status: "Accepted" });
    cache.upsert({ idToken: "B", status: "Accepted" });
    expect(cache.remove("A")).toBe(true);
    expect(cache.remove("A")).toBe(false);
    expect(cache.clear()).toBe(true);
    expect(cache.size()).toBe(0);
  });

  describe("eviction when full (§3.5.1, C10.FR.07)", () => {
    it("removes NOT-valid entries first, then the oldest valid entries", () => {
      const c = clock();
      const cache = new AuthorizationCache("CP", null, {
        now: c.now,
        maxEntries: 3,
      });
      cache.upsert({ idToken: "OLD-VALID", status: "Accepted" });
      c.advance(1);
      cache.upsert({ idToken: "BLOCKED", status: "Blocked" });
      c.advance(1);
      cache.upsert({ idToken: "NEW-VALID", status: "Accepted" });
      c.advance(1);

      cache.upsert({ idToken: "D", status: "Accepted" });
      expect(cache.get("BLOCKED")).toBeUndefined();
      expect(
        cache
          .all()
          .map((e) => e.idToken)
          .sort(),
      ).toEqual(["D", "NEW-VALID", "OLD-VALID"]);

      c.advance(1);
      cache.upsert({ idToken: "E", status: "Accepted" });
      expect(cache.get("OLD-VALID")).toBeUndefined();
      expect(cache.size()).toBe(3);
    });

    it("counts an Accepted entry whose expiryDate has passed as NOT-valid", () => {
      const c = clock();
      const cache = new AuthorizationCache("CP", null, {
        now: c.now,
        maxEntries: 2,
      });
      cache.upsert({ idToken: "VALID", status: "Accepted" });
      c.advance(1);
      cache.upsert({
        idToken: "EXPIRED",
        status: "Accepted",
        expiresAt: c.now() + 10,
      });
      c.advance(100);
      cache.upsert({ idToken: "NEW", status: "Accepted" });
      expect(cache.get("EXPIRED")).toBeUndefined();
      expect(cache.get("VALID")).toBeDefined();
    });

    it("does not evict when an existing entry is updated", () => {
      const cache = new AuthorizationCache("CP", null, { maxEntries: 1 });
      cache.upsert({ idToken: "A", status: "Accepted" });
      cache.upsert({ idToken: "A", status: "Blocked" });
      expect(cache.get("A")?.status).toBe("Blocked");
    });
  });
});
