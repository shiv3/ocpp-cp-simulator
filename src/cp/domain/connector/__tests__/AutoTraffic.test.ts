import { describe, expect, it } from "vitest";

import {
  AutoTrafficPlanner,
  defaultAutoTrafficConfig,
  validateAutoTrafficConfig,
  type AutoTrafficConfig,
} from "../AutoTraffic";

const CONFIG: AutoTrafficConfig = {
  ...defaultAutoTrafficConfig,
  enabled: true,
  seed: 7,
  minDurationSec: 10,
  maxDurationSec: 60,
  minGapSec: 5,
  maxGapSec: 30,
};

function sequence(
  config: AutoTrafficConfig,
  cpId: string,
  connectorId: number,
  n = 12,
): string {
  const planner = new AutoTrafficPlanner(config, cpId, connectorId);
  return Array.from({ length: n }, () => JSON.stringify(planner.next())).join(
    "|",
  );
}

describe("AutoTrafficPlanner (#300)", () => {
  it("replays exactly for the same seed", () => {
    // The point of the whole feature: a CI failure that only shows up under an
    // hour of background load is worthless if it cannot be replayed.
    expect(sequence(CONFIG, "CP1", 1)).toBe(sequence(CONFIG, "CP1", 1));
  });

  it("gives a different stream to another seed", () => {
    expect(sequence(CONFIG, "CP1", 1)).not.toBe(
      sequence({ ...CONFIG, seed: 8 }, "CP1", 1),
    );
  });

  it("does not step two connectors in lockstep", () => {
    expect(sequence(CONFIG, "CP1", 1)).not.toBe(sequence(CONFIG, "CP1", 2));
  });

  it("does not step two charge points in lockstep", () => {
    expect(sequence(CONFIG, "CP1", 1)).not.toBe(sequence(CONFIG, "CP2", 1));
  });

  it("keeps every draw inside its configured bounds", () => {
    const planner = new AutoTrafficPlanner(CONFIG, "CP1", 1);
    for (let i = 0; i < 200; i++) {
      const step = planner.next();
      expect(step.gapSec).toBeGreaterThanOrEqual(CONFIG.minGapSec);
      expect(step.gapSec).toBeLessThanOrEqual(CONFIG.maxGapSec);
      expect(step.durationSec).toBeGreaterThanOrEqual(CONFIG.minDurationSec);
      expect(step.durationSec).toBeLessThanOrEqual(CONFIG.maxDurationSec);
    }
  });

  it("honours probabilityOfStart at both extremes", () => {
    const never = new AutoTrafficPlanner(
      { ...CONFIG, probabilityOfStart: 0 },
      "CP1",
      1,
    );
    const always = new AutoTrafficPlanner(
      { ...CONFIG, probabilityOfStart: 1 },
      "CP1",
      1,
    );
    for (let i = 0; i < 50; i++) {
      expect(never.next().start).toBe(false);
      expect(always.next().start).toBe(true);
    }
  });

  it("sometimes idles in between", () => {
    const planner = new AutoTrafficPlanner(
      { ...CONFIG, probabilityOfStart: 0.5 },
      "CP1",
      1,
    );
    const starts = Array.from({ length: 200 }, () => planner.next().start);
    expect(starts.some(Boolean)).toBe(true);
    expect(starts.some((s) => !s)).toBe(true);
  });

  it("draws the duration regardless of the probability gate", () => {
    // Drawn before the roll, so the sequence a seed produces does not depend
    // on which attempts happened to fire — otherwise "same seed, same run"
    // would hold only when every attempt started.
    const gaps = (probabilityOfStart: number) => {
      const planner = new AutoTrafficPlanner(
        { ...CONFIG, probabilityOfStart },
        "CP1",
        1,
      );
      return Array.from({ length: 20 }, () => planner.next().gapSec);
    };
    expect(gaps(0)).toEqual(gaps(1));
  });

  it("collapses a zero-width range instead of dividing by it", () => {
    const planner = new AutoTrafficPlanner(
      { ...CONFIG, minGapSec: 3, maxGapSec: 3 },
      "CP1",
      1,
    );
    expect(planner.next().gapSec).toBe(3);
  });
});

describe("validateAutoTrafficConfig (#300)", () => {
  it("accepts a sane config", () => {
    expect(validateAutoTrafficConfig(CONFIG)).toBeNull();
  });

  it("rejects what the runner could not act on", () => {
    // Each of these would otherwise become a runtime surprise: a negative
    // delay, an inverted range, or a probability that is not one.
    expect(validateAutoTrafficConfig({ ...CONFIG, minDurationSec: 0 })).toMatch(
      /minDurationSec/,
    );
    expect(validateAutoTrafficConfig({ ...CONFIG, maxDurationSec: 1 })).toMatch(
      /maxDurationSec/,
    );
    expect(validateAutoTrafficConfig({ ...CONFIG, minGapSec: -1 })).toMatch(
      /minGapSec/,
    );
    expect(validateAutoTrafficConfig({ ...CONFIG, maxGapSec: 1 })).toMatch(
      /maxGapSec/,
    );
    expect(
      validateAutoTrafficConfig({ ...CONFIG, probabilityOfStart: 1.5 }),
    ).toMatch(/probabilityOfStart/);
    expect(
      validateAutoTrafficConfig({ ...CONFIG, probabilityOfStart: -0.1 }),
    ).toMatch(/probabilityOfStart/);
    expect(validateAutoTrafficConfig({ ...CONFIG, stopAfterSec: 0 })).toMatch(
      /stopAfterSec/,
    );
  });
});
