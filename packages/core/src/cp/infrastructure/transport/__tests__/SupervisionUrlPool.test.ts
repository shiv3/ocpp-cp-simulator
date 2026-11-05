import { describe, expect, it } from "vitest";

import {
  DEFAULT_AFFINITY_FAILOVER_THRESHOLD,
  SupervisionUrlPool,
} from "../SupervisionUrlPool";

const URLS = ["ws://a/ocpp/", "ws://b/ocpp/", "ws://c/ocpp/"];

/** Take `n` URLs, reporting each attempt as a failure. */
function failing(pool: SupervisionUrlPool, n: number): string[] {
  const seen: string[] = [];
  for (let i = 0; i < n; i++) {
    seen.push(pool.next());
    pool.onFailure();
  }
  return seen;
}

describe("SupervisionUrlPool", () => {
  it("needs at least one URL", () => {
    expect(() => new SupervisionUrlPool([], "round-robin", "CP1")).toThrow();
  });

  describe("round-robin", () => {
    it("moves to the next URL on every attempt, so a dead node drains", () => {
      const pool = new SupervisionUrlPool(URLS, "round-robin", "CP1");
      expect(failing(pool, 4)).toEqual([URLS[0], URLS[1], URLS[2], URLS[0]]);
    });
  });

  describe("random", () => {
    it("replays identically for the same charge point", () => {
      const a = new SupervisionUrlPool(URLS, "random", "CP1");
      const b = new SupervisionUrlPool(URLS, "random", "CP1");
      expect(failing(a, 8)).toEqual(failing(b, 8));
    });

    it("does not put every charge point on the same node", () => {
      const draws = new Set(
        ["CP1", "CP2", "CP3", "CP4", "CP5", "CP6"].map((cpId) =>
          new SupervisionUrlPool(URLS, "random", cpId).next(),
        ),
      );
      expect(draws.size).toBeGreaterThan(1);
    });
  });

  describe("cp-affinity", () => {
    it("assigns a primary deterministically from the cpId", () => {
      // The property a test asserting "which node saw the session" depends on:
      // the same charge point lands on the same URL across restarts and
      // across machines.
      const first = new SupervisionUrlPool(URLS, "cp-affinity", "CP42").next();
      const again = new SupervisionUrlPool(URLS, "cp-affinity", "CP42").next();
      expect(again).toBe(first);
    });

    it("spreads a fleet across the nodes", () => {
      const assigned = new Set(
        Array.from({ length: 30 }, (_, i) =>
          new SupervisionUrlPool(URLS, "cp-affinity", `CP${i}`).next(),
        ),
      );
      expect(assigned.size).toBe(URLS.length);
    });

    it("is sticky: it retries its primary rather than rotating", () => {
      const pool = new SupervisionUrlPool(URLS, "cp-affinity", "CP1");
      const primary = pool.current();
      const attempts = failing(pool, DEFAULT_AFFINITY_FAILOVER_THRESHOLD);
      expect(attempts.every((url) => url === primary)).toBe(true);
    });

    it("fails over once the primary has failed enough times", () => {
      // Sticky must not mean stranded: a genuinely dead primary has to release
      // the charge point, or it never connects at all.
      const pool = new SupervisionUrlPool(URLS, "cp-affinity", "CP1");
      const primary = pool.current();
      failing(pool, DEFAULT_AFFINITY_FAILOVER_THRESHOLD);
      expect(pool.next()).not.toBe(primary);
    });

    it("returns to the primary after a successful connection", () => {
      const pool = new SupervisionUrlPool(URLS, "cp-affinity", "CP1");
      const primary = pool.current();
      failing(pool, DEFAULT_AFFINITY_FAILOVER_THRESHOLD);
      const fallback = pool.next();
      expect(fallback).not.toBe(primary);

      pool.onSuccess();
      // The next disconnect episode starts from the assigned node again, which
      // is how the pool "notices" the primary is back without probing a node
      // it is not talking to.
      expect(pool.next()).toBe(primary);
    });

    it("honours a custom failover threshold", () => {
      const pool = new SupervisionUrlPool(URLS, "cp-affinity", "CP1", {
        failoverThreshold: 1,
      });
      const primary = pool.current();
      failing(pool, 1);
      expect(pool.next()).not.toBe(primary);
    });
  });

  it("defaults to round-robin", () => {
    const pool = new SupervisionUrlPool(URLS, undefined, "CP1");
    expect(failing(pool, 2)).toEqual([URLS[0], URLS[1]]);
  });

  it("degenerates safely to a single URL", () => {
    const pool = new SupervisionUrlPool(["ws://only/"], "round-robin", "CP1");
    expect(failing(pool, 3)).toEqual([
      "ws://only/",
      "ws://only/",
      "ws://only/",
    ]);
  });
});
