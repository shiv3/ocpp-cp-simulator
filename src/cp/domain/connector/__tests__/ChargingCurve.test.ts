import { describe, expect, it } from "vitest";

import {
  currentAmpsFor,
  electricalModelOf,
  powerWattsForCurrent,
  DEFAULT_VOLTAGE_V,
  effectiveChargingPowerW,
  effectivePowerFactor,
  MIN_UI_POWER_FACTOR,
  normalizeChargingCurve,
  powerFractionAtSoc,
  resolveSocForCurve,
} from "../ChargingCurve";

const TAPER = [
  { socPercent: 0, powerFraction: 1 },
  { socPercent: 80, powerFraction: 0.4 },
  { socPercent: 100, powerFraction: 0.1 },
];

describe("normalizeChargingCurve (#301)", () => {
  it("sorts by SoC so interpolation can assume a monotone axis", () => {
    const sorted = normalizeChargingCurve([
      { socPercent: 80, powerFraction: 0.4 },
      { socPercent: 0, powerFraction: 1 },
    ]);
    expect(sorted.map((p) => p.socPercent)).toEqual([0, 80]);
  });

  it("drops points that cannot be interpolated", () => {
    const cleaned = normalizeChargingCurve([
      { socPercent: 0, powerFraction: 1 },
      { socPercent: 150, powerFraction: 0.5 },
      { socPercent: 50, powerFraction: 2 },
      { socPercent: NaN, powerFraction: 0.5 },
      { socPercent: 50, powerFraction: -1 },
    ]);
    expect(cleaned).toEqual([{ socPercent: 0, powerFraction: 1 }]);
  });
});

describe("powerFractionAtSoc (#301)", () => {
  it("interpolates linearly between points", () => {
    // Halfway from 0 (1.0) to 80 (0.4) is 0.7.
    expect(powerFractionAtSoc(TAPER, 40)).toBeCloseTo(0.7);
    // Halfway from 80 (0.4) to 100 (0.1) is 0.25.
    expect(powerFractionAtSoc(TAPER, 90)).toBeCloseTo(0.25);
  });

  it("returns the exact value at a defined point", () => {
    expect(powerFractionAtSoc(TAPER, 0)).toBe(1);
    expect(powerFractionAtSoc(TAPER, 80)).toBe(0.4);
    expect(powerFractionAtSoc(TAPER, 100)).toBe(0.1);
  });

  it("clamps rather than extrapolating outside the curve", () => {
    // A curve that starts at 20% says nothing about 10%; inventing a number
    // there would be worse than admitting the curve does not cover it.
    const partial = [
      { socPercent: 20, powerFraction: 0.9 },
      { socPercent: 60, powerFraction: 0.5 },
    ];
    expect(powerFractionAtSoc(partial, 0)).toBe(0.9);
    expect(powerFractionAtSoc(partial, 100)).toBe(0.5);
  });

  it("treats an empty curve as flat acceptance", () => {
    // The pre-1.2 behaviour, so a charge point without a curve is unchanged.
    expect(powerFractionAtSoc([], 0)).toBe(1);
    expect(powerFractionAtSoc([], 99)).toBe(1);
  });

  it("steps rather than dividing by zero on a repeated SoC", () => {
    const stepped = [
      { socPercent: 0, powerFraction: 1 },
      { socPercent: 50, powerFraction: 1 },
      { socPercent: 50, powerFraction: 0.2 },
      { socPercent: 100, powerFraction: 0.2 },
    ];
    expect(powerFractionAtSoc(stepped, 50)).toBe(1);
    expect(powerFractionAtSoc(stepped, 60)).toBeCloseTo(0.2);
  });

  it("survives a non-finite SoC", () => {
    expect(powerFractionAtSoc(TAPER, NaN)).toBe(1);
  });
});

describe("currentAmpsFor (#301)", () => {
  it("uses I = P / V for DC", () => {
    expect(currentAmpsFor(150_000, { currentType: "DC", voltageV: 400 })).toBe(
      375,
    );
  });

  it("ignores powerFactor on DC, which has no reactive component", () => {
    // A single shared formula would report a current the hardware could not
    // draw.
    expect(
      currentAmpsFor(1_000, {
        currentType: "DC",
        voltageV: 100,
        powerFactor: 0.5,
      }),
    ).toBe(10);
  });

  it("divides across phases and by cos phi for AC", () => {
    expect(
      currentAmpsFor(22_000, {
        currentType: "AC",
        phases: 3,
        voltageV: 230,
        powerFactor: 0.98,
      }),
    ).toBeCloseTo(22_000 / (230 * 3 * 0.98), 3);
  });

  it("defaults to single-phase 230 V at unity", () => {
    expect(currentAmpsFor(2_300, {})).toBeCloseTo(10);
    expect(DEFAULT_VOLTAGE_V).toBe(230);
  });

  it("is zero at zero power, not NaN", () => {
    expect(currentAmpsFor(0, { currentType: "DC", voltageV: 400 })).toBe(0);
  });

  it("falls back rather than dividing by a nonsense voltage or power factor", () => {
    expect(currentAmpsFor(2_300, { voltageV: 0 })).toBeCloseTo(10);
    expect(currentAmpsFor(2_300, { voltageV: NaN })).toBeCloseTo(10);
    // powerFactor 0 is out of contract; effectivePowerFactor substitutes
    // unity, and the reported Power.Factor sample names that same 1 — see the
    // effectivePowerFactor block below and MeterValueBuilder.curve.test.ts.
    expect(currentAmpsFor(2_300, { powerFactor: 0 })).toBeCloseTo(10);
  });
});

describe("effectiveChargingPowerW (#301)", () => {
  const TAPER_W = [
    { socPercent: 0, powerFraction: 1 },
    { socPercent: 80, powerFraction: 0.5 },
    { socPercent: 100, powerFraction: 0.1 },
  ];

  it("scales the EV ceiling by the curve fraction at the given SoC", () => {
    expect(
      effectiveChargingPowerW({
        evMaxW: 100_000,
        curve: TAPER_W,
        socPercent: 100,
        scheduleLimitWatts: Infinity,
      }),
    ).toBe(10_000);
  });

  it("lets the schedule limit win when it is lower than the curve", () => {
    expect(
      effectiveChargingPowerW({
        evMaxW: 100_000,
        curve: TAPER_W,
        socPercent: 0,
        scheduleLimitWatts: 7_000,
      }),
    ).toBe(7_000);
  });

  it("stays flat at evMaxW with no curve", () => {
    expect(
      effectiveChargingPowerW({
        evMaxW: 100_000,
        curve: undefined,
        socPercent: 90,
        scheduleLimitWatts: Infinity,
      }),
    ).toBe(100_000);
  });

  it("ignores the curve when evMaxW itself is unconfigured (Infinity)", () => {
    expect(
      effectiveChargingPowerW({
        evMaxW: Infinity,
        curve: TAPER_W,
        socPercent: 100,
        scheduleLimitWatts: Infinity,
      }),
    ).toBe(0);
  });
});

describe("effectivePowerFactor (#301)", () => {
  it("is always 1 for DC, regardless of a configured value", () => {
    expect(effectivePowerFactor({ currentType: "DC", powerFactor: 0.5 })).toBe(
      1,
    );
  });

  it("uses the configured value for AC", () => {
    expect(effectivePowerFactor({ currentType: "AC", powerFactor: 0.98 })).toBe(
      0.98,
    );
  });

  it("defaults to unity for AC when unconfigured", () => {
    expect(effectivePowerFactor({ currentType: "AC" })).toBe(1);
  });

  it("keeps a value finer than two decimals exactly", () => {
    // MeterValueBuilder reports this number verbatim, so anything that loses
    // precision here would make Power.Factor disagree with the Current.Import
    // derived from it in the same message (#301).
    expect(
      effectivePowerFactor({ currentType: "AC", powerFactor: 0.004 }),
    ).toBe(0.004);
    expect(MIN_UI_POWER_FACTOR).toBe(0.01);
  });

  it("substitutes unity for a power factor outside (0, 1]", () => {
    // 0 is the case the review caught: schema/scenario.schema.json now has
    // exclusiveMinimum 0 and both browser panels clamp to MIN_UI_POWER_FACTOR,
    // so it can only arrive through raw RPC. cos phi = 0 means no real power
    // flows, so I = P / (V x phases x cos phi) would be infinite — unity is
    // the substitute, and the reported sample names it rather than the 0 the
    // caller asked for (#301).
    expect(effectivePowerFactor({ currentType: "AC", powerFactor: 0 })).toBe(1);
    expect(effectivePowerFactor({ currentType: "AC", powerFactor: -0.5 })).toBe(
      1,
    );
    expect(effectivePowerFactor({ currentType: "AC", powerFactor: 1.5 })).toBe(
      1,
    );
    expect(effectivePowerFactor({ currentType: "AC", powerFactor: NaN })).toBe(
      1,
    );
    expect(
      effectivePowerFactor({ currentType: "AC", powerFactor: Infinity }),
    ).toBe(1);
  });
});

describe("resolveSocForCurve (#301)", () => {
  it("uses the connector's own SoC when it has synced one", () => {
    expect(resolveSocForCurve(42, 10, 20)).toBe(42);
  });

  it("falls back to the transaction's initialSoc before the first sync", () => {
    // `connector.soc` is null before the first synced meter tick — the
    // normal state for a Transaction.Begin sample — so evaluating the curve
    // at 0 would taper (or not taper) for the wrong reason.
    expect(resolveSocForCurve(null, 55, 20)).toBe(55);
  });

  it("falls back to the EV settings' initialSoc when the transaction has none", () => {
    expect(resolveSocForCurve(null, undefined, 30)).toBe(30);
  });

  it("falls back to 0 as a last resort when nothing is configured", () => {
    expect(resolveSocForCurve(null, undefined, undefined)).toBe(0);
  });

  it("treats a synced SoC of exactly 0 as a real reading, not 'unset'", () => {
    // 0 is falsy but a legitimate SoC — `??` (not `||`) must be used so an
    // empty battery isn't mistaken for "no reading yet".
    expect(resolveSocForCurve(0, 55, 20)).toBe(0);
  });
});

describe("powerWattsForCurrent (#301)", () => {
  it("is the exact inverse of currentAmpsFor for the same settings", () => {
    const cases = [
      { currentType: "AC" as const, phases: 3 as const, powerFactor: 0.5 },
      { currentType: "AC" as const, phases: 1 as const, voltageV: 240 },
      { currentType: "DC" as const, voltageV: 400 },
      {},
    ];
    for (const settings of cases) {
      const watts = powerWattsForCurrent(16, settings);
      expect(currentAmpsFor(watts, settings)).toBeCloseTo(16, 9);
    }
  });

  it("ignores the profile's numberPhases on DC, which has no phases", () => {
    expect(
      powerWattsForCurrent(200, { currentType: "DC", voltageV: 400 }, 3),
    ).toBe(200 * 400);
  });

  it("takes the lower of the connector's phases and the profile's", () => {
    const threePhase = { currentType: "AC" as const, phases: 3 as const };
    const onePhase = { currentType: "AC" as const, phases: 1 as const };
    // A profile cannot give a 1-phase connector three phases to draw on.
    expect(powerWattsForCurrent(16, onePhase, 3)).toBe(16 * 230);
    // A profile restricting a 3-phase connector to one phase lowers the cap.
    expect(powerWattsForCurrent(16, threePhase, 1)).toBe(16 * 230);
    expect(powerWattsForCurrent(16, threePhase, 3)).toBe(16 * 230 * 3);
    // Absent numberPhases leaves the connector's own count in charge.
    expect(powerWattsForCurrent(16, threePhase)).toBe(16 * 230 * 3);
  });

  it("honours a numberPhases of 2, which OCPP allows", () => {
    // Restricting this to {1, 3} would make the two halves of the same
    // conversion disagree: the no-model path in ChargingScheduleResolver has
    // always used `numberPhases ?? 3` verbatim, so a legal 2-phase profile
    // was capped at x2 there and silently x3 here.
    const threePhase = { currentType: "AC" as const, phases: 3 as const };
    expect(powerWattsForCurrent(16, threePhase, 2)).toBe(16 * 230 * 2);
  });

  it("falls back to the connector's own count for a phase value it cannot use", () => {
    // Fractional, negative or otherwise smuggled past the types by raw RPC.
    const threePhase = { currentType: "AC" as const, phases: 3 as const };
    for (const bogus of [1.5, -1, NaN, Infinity]) {
      expect(powerWattsForCurrent(16, threePhase, bogus)).toBe(16 * 230 * 3);
    }
  });

  it("never derives a current above the amperage it was given", () => {
    const settings = { currentType: "AC" as const, phases: 3 as const };
    for (const limitPhases of [undefined, 0, 1, 2, 3, 1.5, -1]) {
      const watts = powerWattsForCurrent(16, settings, limitPhases);
      expect(currentAmpsFor(watts, settings)).toBeLessThanOrEqual(16);
    }
  });

  it("returns 0 for a non-positive current", () => {
    expect(powerWattsForCurrent(0, { currentType: "DC" })).toBe(0);
    expect(powerWattsForCurrent(-5, {})).toBe(0);
  });
});

describe("electricalModelOf (#301)", () => {
  it("returns undefined when no electrical field is declared", () => {
    expect(
      electricalModelOf({
        modelName: "Generic EV",
        batteryCapacityKwh: 75,
        maxChargingPowerKw: 150,
        initialSoc: 20,
        targetSoc: 80,
      }),
    ).toBeUndefined();
  });

  it("returns the model as soon as one field is declared", () => {
    expect(
      electricalModelOf({
        modelName: "Generic EV",
        batteryCapacityKwh: 75,
        maxChargingPowerKw: 150,
        initialSoc: 20,
        targetSoc: 80,
        phases: 3,
      }),
    ).toEqual({
      currentType: undefined,
      phases: 3,
      voltageV: undefined,
      powerFactor: undefined,
    });
  });

  it("returns undefined for absent settings", () => {
    expect(electricalModelOf(undefined)).toBeUndefined();
  });
});
