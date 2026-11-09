import { describe, expect, it } from "vitest";

import {
  AutoTrafficIdTagPicker,
  AutoTrafficPlanner,
  autoTrafficVehicleLabel,
  autoTrafficVehiclePatch,
  defaultAutoTrafficConfig,
  pickWeightedIndex,
  validateAutoTrafficConfig,
  type AutoTrafficConfig,
  type AutoTrafficVehicle,
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

  it("rejects an incomplete config, not just an out-of-range one", () => {
    // Every comparison is false against a missing field, so
    // `{ enabled: true, seed: 1 }` validated, the planner produced NaN gaps,
    // and setTimeout(NaN) fires immediately — a non-starting step then
    // rescheduled itself in a hot loop.
    const partial = { enabled: true, seed: 1 } as unknown as AutoTrafficConfig;
    expect(validateAutoTrafficConfig(partial)).toMatch(/finite number/);
    expect(
      validateAutoTrafficConfig({
        ...CONFIG,
        minGapSec: NaN,
      }),
    ).toMatch(/finite number/);
    expect(
      validateAutoTrafficConfig({
        ...CONFIG,
        enabled: undefined as unknown as boolean,
      }),
    ).toMatch(/enabled/);
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

describe("AutoTrafficIdTagPicker (#603)", () => {
  const TAGS = ["T0", "T1", "T2", "T3", "T4"];
  const draws = (picker: AutoTrafficIdTagPicker, n = 10): string[] =>
    Array.from({ length: n }, () => picker.next());
  const picker = (
    strategy: "round-robin" | "random" | "connector-affinity",
    over: {
      seed?: number;
      cpId?: string;
      connector?: number;
      index?: number;
    } = {},
  ) =>
    new AutoTrafficIdTagPicker(
      TAGS,
      strategy,
      over.seed ?? 7,
      over.cpId ?? "CP1",
      over.connector ?? 1,
      over.index,
    );

  it("replays the same sequence for the same seed, whatever else drew", () => {
    for (const strategy of [
      "round-robin",
      "random",
      "connector-affinity",
    ] as const) {
      expect(draws(picker(strategy))).toEqual(draws(picker(strategy)));
    }
  });

  it("round-robin walks the whole pool from an offset the cp index sets", () => {
    const first = draws(picker("round-robin", { index: 0 }), 5);
    expect(first).toEqual(["T0", "T1", "T2", "T3", "T4"]);
    expect(draws(picker("round-robin", { index: 2 }), 5)).toEqual([
      "T2",
      "T3",
      "T4",
      "T0",
      "T1",
    ]);
  });

  it("spreads the first tag across a fleet", () => {
    const firsts = new Set(
      Array.from({ length: 5 }, (_, i) =>
        picker("round-robin", { index: i }).next(),
      ),
    );
    expect(firsts.size).toBe(5);
    const affinity = new Set(
      Array.from({ length: 5 }, (_, i) =>
        picker("connector-affinity", { index: i }).next(),
      ),
    );
    expect(affinity.size).toBe(5);
  });

  it("without an index, spreads by a stable hash of the charge point id", () => {
    const a = draws(picker("round-robin", { cpId: "CP-A" }), 3);
    expect(a).toEqual(draws(picker("round-robin", { cpId: "CP-A" }), 3));
  });

  it("connector-affinity gives a connector one tag and its neighbour another", () => {
    const one = draws(
      picker("connector-affinity", { index: 0, connector: 1 }),
      4,
    );
    const two = draws(
      picker("connector-affinity", { index: 0, connector: 2 }),
      4,
    );
    expect(new Set(one)).toEqual(new Set(["T0"]));
    expect(new Set(two)).toEqual(new Set(["T1"]));
  });

  it("random follows the seed and stays inside the pool", () => {
    const a = draws(picker("random", { seed: 1 }), 30);
    expect(a).not.toEqual(draws(picker("random", { seed: 2 }), 30));
    for (const tag of a) expect(TAGS).toContain(tag);
    expect(new Set(a).size).toBeGreaterThan(1);
  });

  it("refuses an empty pool", () => {
    expect(
      () => new AutoTrafficIdTagPicker([], "random", 1, "CP1", 1, 0),
    ).toThrow();
  });
});

describe("validateAutoTrafficConfig, #603 fields", () => {
  it("accepts a stop time, a strategy and a cp index", () => {
    expect(
      validateAutoTrafficConfig({
        ...CONFIG,
        stopAt: "2026-11-08T12:00:00Z",
        idTagStrategy: "random",
        cpIndex: 3,
      }),
    ).toBeNull();
  });

  it("rejects what the runtime could not act on", () => {
    expect(validateAutoTrafficConfig({ ...CONFIG, stopAt: "soon" })).toMatch(
      /stopAt/,
    );
    expect(
      validateAutoTrafficConfig({
        ...CONFIG,
        idTagStrategy: "nope" as unknown as "random",
      }),
    ).toMatch(/idTagStrategy/);
    expect(validateAutoTrafficConfig({ ...CONFIG, cpIndex: -1 })).toMatch(
      /cpIndex/,
    );
    expect(validateAutoTrafficConfig({ ...CONFIG, cpIndex: 1.5 })).toMatch(
      /cpIndex/,
    );
  });
});

describe("AutoTraffic sessionModel (#327)", () => {
  const INTENT: AutoTrafficConfig = { ...CONFIG, sessionModel: "intent" };

  it('keeps the duration stream byte for byte: absent equals "duration"', () => {
    expect(sequence({ ...CONFIG, sessionModel: "duration" }, "CP1", 1)).toBe(
      sequence(CONFIG, "CP1", 1),
    );
    const step = new AutoTrafficPlanner(CONFIG, "CP1", 1).next();
    expect("intent" in step).toBe(false);
  });

  it("draws the same gaps and durations first, so a seed keeps its gap sequence", () => {
    const duration = new AutoTrafficPlanner(CONFIG, "CP1", 1).next();
    const intent = new AutoTrafficPlanner(INTENT, "CP1", 1).next();
    expect(intent.gapSec).toBe(duration.gapSec);
    expect(intent.durationSec).toBe(duration.durationSec);
  });

  it("replays the same intents for the same seed and differs for another", () => {
    expect(sequence(INTENT, "CP1", 1)).toBe(sequence(INTENT, "CP1", 1));
    expect(sequence(INTENT, "CP1", 1)).not.toBe(
      sequence({ ...INTENT, seed: 8 }, "CP1", 1),
    );
  });

  it("keeps initial and target SoC in their bounds, target above initial", () => {
    const planner = new AutoTrafficPlanner(
      { ...INTENT, initialSocMin: 5, initialSocMax: 90, targetSocMin: 20 },
      "CP1",
      1,
    );
    for (let i = 0; i < 300; i++) {
      const { intent } = planner.next();
      expect(intent!.initialSoc).toBeGreaterThanOrEqual(5);
      expect(intent!.initialSoc).toBeLessThanOrEqual(90);
      expect(intent!.targetSoc).toBeGreaterThan(intent!.initialSoc);
      expect(intent!.targetSoc).toBeLessThanOrEqual(100);
    }
  });

  it("validates the model and the SoC bounds", () => {
    expect(validateAutoTrafficConfig(INTENT)).toBeNull();
    expect(
      validateAutoTrafficConfig({ ...CONFIG, sessionModel: "x" as never }),
    ).toMatch(/sessionModel/);
    expect(validateAutoTrafficConfig({ ...INTENT, targetSocMax: 101 })).toMatch(
      /targetSocMax/,
    );
    expect(
      validateAutoTrafficConfig({
        ...INTENT,
        initialSocMin: 60,
        initialSocMax: 40,
      }),
    ).toMatch(/initialSocMax/);
  });
});

describe("AutoTraffic vehiclePool (#627)", () => {
  const SMALL: AutoTrafficVehicle = {
    weight: 3,
    profileId: "small-ac",
    vehicle: {
      modelName: "Small AC",
      batteryCapacityKwh: 40,
      maxChargingPowerKw: 7,
      currentType: "AC",
      phases: 1,
    },
  };
  const BIG: AutoTrafficVehicle = {
    weight: 1,
    vehicle: {
      modelName: "Big DC",
      batteryCapacityKwh: 100,
      maxChargingPowerKw: 150,
      currentType: "DC",
      chargingCurve: [
        { socPercent: 0, powerFraction: 1 },
        { socPercent: 100, powerFraction: 0.1 },
      ],
    },
  };
  const POOLED: AutoTrafficConfig = { ...CONFIG, vehiclePool: [SMALL, BIG] };

  function indices(config: AutoTrafficConfig, n: number): number[] {
    const planner = new AutoTrafficPlanner(config, "CP1", 1);
    return Array.from({ length: n }, () => planner.next().vehicleIndex!);
  }

  it("changes nothing for a config without a pool", () => {
    expect(
      "vehicleIndex" in new AutoTrafficPlanner(CONFIG, "CP1", 1).next(),
    ).toBe(false);
    expect(sequence({ ...CONFIG, vehiclePool: undefined }, "CP1", 1)).toBe(
      sequence(CONFIG, "CP1", 1),
    );
  });

  it("keeps the gaps, durations, intents and rolls a seed gives without a pool", () => {
    const strip = (config: AutoTrafficConfig): string => {
      const planner = new AutoTrafficPlanner(config, "CP1", 1);
      return Array.from({ length: 30 }, () => {
        const { vehicleIndex: _unused, ...rest } = planner.next();
        return JSON.stringify(rest);
      }).join("|");
    };
    for (const sessionModel of ["duration", "intent"] as const) {
      expect(strip({ ...POOLED, sessionModel })).toBe(
        strip({ ...CONFIG, sessionModel }),
      );
    }
  });

  it("replays the same vehicle sequence for the same seed, and another for another seed", () => {
    expect(indices(POOLED, 40)).toEqual(indices(POOLED, 40));
    expect(indices(POOLED, 40)).not.toEqual(
      indices({ ...POOLED, seed: 8 }, 40),
    );
  });

  it("draws in proportion to the weights", () => {
    const drawn = indices(POOLED, 4000);
    const small = drawn.filter((i) => i === 0).length / drawn.length;
    expect(small).toBeGreaterThan(0.7);
    expect(small).toBeLessThan(0.8);
  });

  it("never draws an entry of weight that is tiny next to the others more than its share, and a single entry always", () => {
    expect(new Set(indices({ ...CONFIG, vehiclePool: [BIG] }, 50))).toEqual(
      new Set([0]),
    );
  });

  it("pickWeightedIndex maps the unit interval onto the weights", () => {
    expect(pickWeightedIndex([3, 1], 0)).toBe(0);
    expect(pickWeightedIndex([3, 1], 0.74)).toBe(0);
    expect(pickWeightedIndex([3, 1], 0.75)).toBe(1);
    expect(pickWeightedIndex([3, 1], 0.999999)).toBe(1);
    expect(pickWeightedIndex([0.5, 0.5, 1], 0.4)).toBe(1);
  });

  it("labels an entry by its profile id, else its model name", () => {
    expect(autoTrafficVehicleLabel(SMALL)).toBe("small-ac");
    expect(autoTrafficVehicleLabel(BIG)).toBe("Big DC");
  });

  it("builds a patch that replaces the previous vehicle whole", () => {
    expect(autoTrafficVehiclePatch(SMALL)).toEqual({
      modelName: "Small AC",
      batteryCapacityKwh: 40,
      maxChargingPowerKw: 7,
      chargingCurve: [],
      currentType: "AC",
      phases: 1,
      attribution: null,
    });
    expect(autoTrafficVehiclePatch(BIG)).toMatchObject({
      currentType: "DC",
      phases: null,
      chargingCurve: BIG.vehicle.chargingCurve,
    });
  });

  it("validates the pool", () => {
    expect(validateAutoTrafficConfig(POOLED)).toBeNull();
    const bad = (pool: unknown) =>
      validateAutoTrafficConfig({ ...CONFIG, vehiclePool: pool as never });
    expect(bad("x")).toMatch(/must be an array/);
    expect(bad([])).toMatch(/must not be empty/);
    expect(bad([{ ...SMALL, weight: 0 }])).toMatch(/vehiclePool\[0\]\.weight/);
    expect(bad([SMALL, { ...BIG, weight: Infinity }])).toMatch(
      /vehiclePool\[1\]\.weight/,
    );
    expect(
      bad([{ weight: 1, vehicle: { ...BIG.vehicle, batteryCapacityKwh: 0 } }]),
    ).toMatch(/batteryCapacityKwh/);
    expect(
      bad([{ weight: 1, vehicle: { ...BIG.vehicle, modelName: "" } }]),
    ).toMatch(/modelName/);
    expect(
      bad([{ weight: 1, vehicle: { ...BIG.vehicle, phases: 2 } }]),
    ).toMatch(/phases/);
    expect(
      bad([
        {
          weight: 1,
          vehicle: {
            ...BIG.vehicle,
            chargingCurve: [{ socPercent: 120, powerFraction: 1 }],
          },
        },
      ]),
    ).toMatch(/chargingCurve/);
  });
});
