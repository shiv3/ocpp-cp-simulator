import { describe, expect, it } from "vitest";

import { DEFAULT_ID_TAG, IdTagPool } from "../IdTagPool";

const TAGS = ["TAG-A", "TAG-B", "TAG-C"];

describe("IdTagPool (#299)", () => {
  it("needs at least one tag", () => {
    expect(() => new IdTagPool([], "round-robin", "CP1")).toThrow();
  });

  describe("round-robin", () => {
    it("walks the pool and wraps", () => {
      const pool = new IdTagPool(TAGS, "round-robin", "CP1");
      expect([0, 1, 2, 3].map(() => pool.next())).toEqual([
        "TAG-A",
        "TAG-B",
        "TAG-C",
        "TAG-A",
      ]);
    });

    it("ignores the connector, since the walk is charge-point wide", () => {
      const pool = new IdTagPool(TAGS, "round-robin", "CP1");
      expect([pool.next(1), pool.next(1), pool.next(2)]).toEqual([
        "TAG-A",
        "TAG-B",
        "TAG-C",
      ]);
    });
  });

  describe("random", () => {
    it("replays identically for the same charge point", () => {
      const a = new IdTagPool(TAGS, "random", "CP1");
      const b = new IdTagPool(TAGS, "random", "CP1");
      const draws = Array.from({ length: 12 }, () => a.next());
      expect(draws).toEqual(Array.from({ length: 12 }, () => b.next()));
    });

    it("seeds per charge point, so a fleet does not draw in lockstep", () => {
      // One pool per charge point, each drawing its own sequence. If the seed
      // ignored the cpId every station would present the same tag at the same
      // moment, which is the thing the pool exists to avoid.
      const sequences = ["CP1", "CP2", "CP3", "CP4", "CP5"].map((cpId) => {
        const pool = new IdTagPool(TAGS, "random", cpId);
        return Array.from({ length: 10 }, () => pool.next()).join("");
      });
      expect(new Set(sequences).size).toBeGreaterThan(1);
    });
  });

  describe("connector-affinity", () => {
    it("gives a connector the same tag every time", () => {
      const pool = new IdTagPool(TAGS, "connector-affinity", "CP1");
      expect(pool.next(2)).toBe(pool.next(2));
      expect(pool.next(1)).not.toBe(pool.next(2));
    });

    it("spreads connectors across the pool and wraps", () => {
      const pool = new IdTagPool(TAGS, "connector-affinity", "CP1");
      expect([1, 2, 3, 4].map((c) => pool.next(c))).toEqual([
        "TAG-A",
        "TAG-B",
        "TAG-C",
        "TAG-A",
      ]);
    });

    it("tolerates a connector-less caller", () => {
      // A bare `authorize` has no connector in hand.
      const pool = new IdTagPool(TAGS, "connector-affinity", "CP1");
      expect(TAGS).toContain(pool.next());
    });
  });

  it("defaults to round-robin", () => {
    const pool = new IdTagPool(TAGS, undefined, "CP1");
    expect([pool.next(), pool.next()]).toEqual(["TAG-A", "TAG-B"]);
  });

  it("degenerates safely to a single tag", () => {
    const pool = new IdTagPool(["ONLY"], "round-robin", "CP1");
    expect([pool.next(), pool.next(9)]).toEqual(["ONLY", "ONLY"]);
  });

  it("names the historical fallback rather than repeating the literal", () => {
    expect(DEFAULT_ID_TAG).toBe("123456");
  });
});

describe("the scenario executor draws through a callback (#299)", () => {
  it("prefers a node's own tag, then the pool, then the default", async () => {
    // The executor has no charge point and no connector of its own, so the
    // pool reaches it as behaviour. An earlier draft referenced a
    // `this.chargePoint` that does not exist — code that would have thrown on
    // the first transaction node of any scenario.
    const { ScenarioExecutor } =
      await import("../../../application/scenario/ScenarioExecutor");
    const started: string[] = [];
    const scenario = {
      id: "s",
      name: "s",
      nodes: [
        { id: "start", type: "start", data: {} },
        { id: "tx", type: "transaction", data: { action: "start" } },
      ],
      edges: [{ id: "e", source: "start", target: "tx" }],
    };

    const run = async (onResolveIdTag?: () => string | null) => {
      started.length = 0;
      const executor = new ScenarioExecutor(
        scenario as never,
        {
          onResolveIdTag,
          onStartTransaction: async (tagId: string) => {
            started.push(tagId);
          },
        } as never,
      );
      await executor.start();
      return started[0];
    };

    expect(await run(() => "POOLED")).toBe("POOLED");
    // No pool: the historical literal, so a charge point without one is
    // unchanged.
    expect(await run(() => null)).toBe(DEFAULT_ID_TAG);
    expect(await run(undefined)).toBe(DEFAULT_ID_TAG);
  });
});
