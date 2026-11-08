import { describe, expect, it } from "vitest";

import {
  DEFAULT_BOOTSTRAP_PACING,
  forEachPaced,
  startOffsetsMs,
} from "../bootstrapPacing";

describe("startOffsetsMs (#610)", () => {
  it("is all zeros by default, which is the pre-#610 behaviour", () => {
    expect(startOffsetsMs(4, DEFAULT_BOOTSTRAP_PACING)).toEqual([0, 0, 0, 0]);
  });

  it("spaces starts by the delay", () => {
    expect(
      startOffsetsMs(4, { startDelayMs: 100, startJitterMs: 0, startSeed: 0 }),
    ).toEqual([0, 100, 200, 300]);
  });

  it("draws the same jitter for the same seed, within bounds, and another for another seed", () => {
    const p = { startDelayMs: 0, startJitterMs: 1000, startSeed: 42 };
    const a = startOffsetsMs(50, p);
    expect(startOffsetsMs(50, p)).toEqual(a);
    expect(a.every((x) => x >= 0 && x < 1000)).toBe(true);
    expect(new Set(a).size).toBeGreaterThan(40);
    expect(startOffsetsMs(50, { ...p, startSeed: 43 })).not.toEqual(a);
  });

  it("keeps an index's jitter when the fleet grows", () => {
    const p = { startDelayMs: 0, startJitterMs: 500, startSeed: 1 };
    expect(startOffsetsMs(10, p)).toEqual(startOffsetsMs(20, p).slice(0, 10));
  });
});

describe("forEachPaced (#610)", () => {
  function harness() {
    let clock = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
  }

  it("never has more than `concurrency` in flight and visits every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachPaced(
      [1, 2, 3, 4, 5, 6, 7],
      { ...DEFAULT_BOOTSTRAP_PACING, concurrency: 3 },
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        seen.push(n);
        inFlight--;
      },
    );
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("does not sleep at all with the default pacing", async () => {
    const h = harness();
    await forEachPaced(
      [1, 2, 3],
      DEFAULT_BOOTSTRAP_PACING,
      async () => {},
      h.sleep,
      h.now,
    );
    expect(h.sleeps).toEqual([]);
  });

  it("waits for each item's scheduled offset", async () => {
    const h = harness();
    const startedAt: number[] = [];
    await forEachPaced(
      ["a", "b", "c"],
      { concurrency: 1, startDelayMs: 100, startJitterMs: 0, startSeed: 0 },
      async () => {
        startedAt.push(h.now());
      },
      h.sleep,
      h.now,
    );
    expect(startedAt).toEqual([0, 100, 200]);
  });
});
