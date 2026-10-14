import { describe, expect, it } from "vitest";

import { evaluateCurveKwh } from "../../../cp/domain/connector/MeterValueCurve";
import {
  curveEnergyKwh,
  curvePointsToPower,
  describePowerCurve,
  powerAt,
  powerCurvePresets,
  powerToCurvePoints,
  type PowerPoint,
} from "./powerCurve";

const RAMP: PowerPoint[] = [
  { minute: 0, kw: 0 },
  { minute: 3, kw: 7.4 },
  { minute: 50, kw: 7.4 },
  { minute: 60, kw: 0 },
];

function expectClose(actual: PowerPoint[], expected: PowerPoint[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, i) => {
    expect(point.minute).toBeCloseTo(expected[i].minute, 1);
    expect(point.kw).toBeCloseTo(expected[i].kw, 1);
  });
}

describe("powerCurve: the editor's power points and the auto meter's energy curve", () => {
  it("integrates a piecewise-linear power curve", () => {
    // 3 min ramp (0.185 kWh) + 47 min at 7.4 kW (5.797) + 10 min down (0.617).
    expect(curveEnergyKwh(RAMP)).toBeCloseTo(6.598, 3);
    expect(powerAt(RAMP, 1.5)).toBeCloseTo(3.7, 6);
    expect(powerAt(RAMP, 55)).toBeCloseTo(3.7, 6);
  });

  it("writes a constant power as the two-point straight line it is", () => {
    expect(
      powerToCurvePoints([
        { minute: 0, kw: 7.4 },
        { minute: 60, kw: 7.4 },
      ]),
    ).toEqual([
      { time: 0, value: 0 },
      { time: 3600, value: 7.4 },
    ]);
  });

  it("writes any other shape as uniform energy samples, so the Bezier the simulator evaluates follows it", () => {
    const points = powerToCurvePoints(RAMP);
    // One sample a minute: uniform times keep the Bezier's abscissa linear.
    expect(points).toHaveLength(61);
    expect(points[0]).toEqual({ time: 0, value: 0 });
    expect(points[60].time).toBe(3600);
    expect(points[60].value).toBeCloseTo(curveEnergyKwh(RAMP), 3);
    for (let i = 1; i < points.length; i++) {
      expect(points[i].value).toBeGreaterThanOrEqual(points[i - 1].value);
    }
    // What the simulator sends stays within a few percent of the drawing.
    const midway = evaluateCurveKwh(points, 1800);
    expect(Math.abs(midway - 3.515)).toBeLessThan(0.15);
  });

  it("reads back what it wrote", () => {
    expectClose(curvePointsToPower(powerToCurvePoints(RAMP)), RAMP);
    for (const preset of powerCurvePresets(11)) {
      expectClose(
        curvePointsToPower(powerToCurvePoints(preset.points)),
        preset.points,
      );
    }
  });

  it("reads a two-point energy curve (the default) as a constant power", () => {
    expect(
      curvePointsToPower([
        { time: 0, value: 0 },
        { time: 1800, value: 50 },
      ]),
    ).toEqual([
      { minute: 0, kw: 100 },
      { minute: 30, kw: 100 },
    ]);
  });

  it("reads a few Bezier control points as the power of the curve they draw", () => {
    // A quadratic Bezier: energy 2t(1-t)*40 + t^2*50 over 30 min, so the
    // power falls linearly from 160 kW to 40 kW.
    expectClose(
      curvePointsToPower([
        { time: 0, value: 0 },
        { time: 900, value: 40 },
        { time: 1800, value: 50 },
      ]),
      [
        { minute: 0, kw: 160 },
        { minute: 30, kw: 40 },
      ],
    );
  });

  it("reads nothing from an empty or one-point curve", () => {
    expect(curvePointsToPower([])).toEqual([]);
    expect(curvePointsToPower([{ time: 0, value: 3 }])).toEqual([]);
  });

  it("offers the mock's presets under the EV's max power", () => {
    const presets = powerCurvePresets(11);
    expect(presets.map((p) => p.id)).toEqual(["constant", "ramp", "taper"]);
    expect(presets[0].label).toBe("Constant 7.4 kW");
    expect(presets[2].points.some((p) => p.kw === 11)).toBe(true);
    // A 3.7 kW EV caps the constant preset.
    expect(powerCurvePresets(3.7)[0].points[0].kw).toBe(3.7);
  });

  it("summarizes a curve in one line", () => {
    expect(describePowerCurve(RAMP, true)).toBe(
      "6.6 kWh over 60 min, peak 7.4 kW, stop at target SoC",
    );
    expect(describePowerCurve([], false)).toBe("no curve");
  });
});
