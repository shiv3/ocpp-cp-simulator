import { describe, expect, it } from "vitest";

import {
  currentAmpsFor,
  DEFAULT_VOLTAGE_V,
  effectiveChargingPowerW,
  effectivePowerFactor,
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

  it("falls back rather than dividing by a nonsense voltage", () => {
    expect(currentAmpsFor(2_300, { voltageV: 0 })).toBeCloseTo(10);
    expect(currentAmpsFor(2_300, { voltageV: NaN })).toBeCloseTo(10);
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
