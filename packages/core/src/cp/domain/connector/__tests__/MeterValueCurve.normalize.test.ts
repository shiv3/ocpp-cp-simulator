import { describe, it, expect } from "vitest";
import {
  normalizeCurvePoints,
  withNormalizedCurvePoints,
  describeCurvePointCorrection,
  defaultAutoMeterValueConfig,
  getMeterValueAtTime,
  type CurvePoint,
} from "../MeterValueCurve";

describe("normalizeCurvePoints (#332)", () => {
  it("returns an already-sorted, non-decreasing curve point-for-point", () => {
    const written: CurvePoint[] = [
      { time: 0, value: 0 },
      { time: 900, value: 25 },
      { time: 1800, value: 50 },
    ];
    const { points, corrections } = normalizeCurvePoints(written);
    expect(corrections).toEqual([]);
    expect(points).toHaveLength(3);
    points.forEach((point, i) => expect(point).toBe(written[i]));
  });

  it("clamps a descending ordinate up to the value already delivered", () => {
    const { points, corrections } = normalizeCurvePoints([
      { time: 0, value: 0 },
      { time: 60, value: 5 },
      { time: 120, value: 3 },
      { time: 180, value: 7 },
    ]);
    expect(points).toEqual([
      { time: 0, value: 0 },
      { time: 60, value: 5 },
      { time: 120, value: 5 },
      { time: 180, value: 7 },
    ]);
    expect(corrections).toEqual([
      {
        index: 2,
        problem: "decreasing",
        time: 120,
        value: 3,
        correctedTo: 5,
      },
    ]);
  });

  it("raises a negative ordinate to zero — the issue's 0 → -1 kWh curve", () => {
    const { points, corrections } = normalizeCurvePoints([
      { time: 0, value: 0 },
      { time: 60, value: -1 },
    ]);
    expect(points).toEqual([
      { time: 0, value: 0 },
      { time: 60, value: 0 },
    ]);
    expect(corrections[0]?.problem).toBe("negative");
    expect(corrections[0]?.correctedTo).toBe(0);
  });

  it("keeps a corrected point's extension fields, as an uncorrected one keeps its own", () => {
    // `curvePoint` is `additionalProperties: true` and the RPC payload is
    // opaque, so a point may carry metadata. A clamp that rebuilt the point
    // as a bare `{ time, value }` dropped it from the read-back config while
    // its uncorrected neighbours kept theirs.
    const { points } = normalizeCurvePoints([
      { time: 0, value: 5, label: "start" },
      { time: 60, value: 3, label: "dip", note: "x" },
    ]);
    expect(points[1]).toEqual({ time: 60, value: 5, label: "dip", note: "x" });
    expect(points[0]).toEqual({ time: 0, value: 5, label: "start" });
  });

  it("keeps the curve's time span rather than dropping the offending point", () => {
    // The span is what `autoCalculateInterval` divides into a tick interval
    // and what the exported k6 runtime reads as the auto-meter's stop
    // condition, so a clamp has to leave it alone.
    const { points } = normalizeCurvePoints([
      { time: 0, value: 10 },
      { time: 3600, value: 2 },
    ]);
    expect(points.map((p) => p.time)).toEqual([0, 3600]);
    expect(points.map((p) => p.value)).toEqual([10, 10]);
  });

  it("takes the running maximum in time order, not written order", () => {
    const { points, corrections } = normalizeCurvePoints([
      { time: 120, value: 3 },
      { time: 60, value: 5 },
    ]);
    expect(points).toEqual([
      { time: 60, value: 5 },
      { time: 120, value: 5 },
    ]);
    // Named by the index in the curve as written, which is what the operator
    // can go and edit.
    expect(corrections[0]?.index).toBe(0);
  });

  it("drops entries that are not { time, value } pairs of finite numbers", () => {
    const { points, corrections } = normalizeCurvePoints([
      { time: 0, value: 0 },
      null,
      "nope",
      { time: 60 },
      { time: NaN, value: 1 },
      { time: 60, value: 5 },
    ]);
    expect(points).toEqual([
      { time: 0, value: 0 },
      { time: 60, value: 5 },
    ]);
    expect(corrections.map((c) => c.index)).toEqual([1, 2, 3, 4]);
    expect(corrections.every((c) => c.problem === "malformed")).toBe(true);
  });

  it("never throws on a non-array; an empty curve is a register that holds still", () => {
    expect(normalizeCurvePoints(undefined)).toEqual({
      points: [],
      corrections: [],
    });
    expect(normalizeCurvePoints("curve")).toEqual({
      points: [],
      corrections: [],
    });
  });

  it("makes the sampled trajectory non-decreasing at every elapsed time", () => {
    // The scheduler samples the *bezier* of the control points for 3+ points,
    // not the polyline, so the invariant has to hold after De Casteljau too.
    const { points } = normalizeCurvePoints([
      { time: 0, value: 0 },
      { time: 60, value: 20 },
      { time: 120, value: 4 },
      { time: 180, value: 9 },
    ]);
    const config = { ...defaultAutoMeterValueConfig, curvePoints: points };
    let previous = -Infinity;
    for (let t = 0; t <= 180; t += 1) {
      const sample = getMeterValueAtTime(t, config);
      expect(sample).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = sample;
    }
  });
});

describe("withNormalizedCurvePoints (#332)", () => {
  it("returns the same object when the curve is already within contract", () => {
    const config = {
      ...defaultAutoMeterValueConfig,
      curvePoints: [
        { time: 0, value: 0 },
        { time: 60, value: 5 },
      ],
    };
    expect(withNormalizedCurvePoints(config)).toBe(config);
  });

  it.each([
    ['"" (an empty string)', ""],
    ["{ length: 0 }", { length: 0 }],
    ["a number", 0],
    ["a plain object", {}],
    ["a string of points", "abc"],
  ])(
    "normalizes a non-array curvePoints to an empty curve rather than throwing: %s",
    (_label, value) => {
      // `set_auto_meter_config` validates no field of the config, so any of
      // these genuinely reaches this function, and before #332 the scheduler
      // read them as an empty curve without complaint. The two with
      // `length === 0` are the sharp ones: they passed `sameOrder`'s length
      // test and then threw on `String.prototype.every`, which does not exist.
      const config = { curvePoints: value } as unknown as {
        curvePoints?: CurvePoint[];
      };
      let result!: { curvePoints?: CurvePoint[] };
      expect(() => {
        result = withNormalizedCurvePoints(config);
      }).not.toThrow();
      expect(result.curvePoints).toEqual([]);
    },
  );

  it("leaves a config with no curve alone, identity included", () => {
    const config = { intervalSeconds: 10 } as { curvePoints?: CurvePoint[] };
    expect(withNormalizedCurvePoints(config)).toBe(config);
  });

  it("reports one diagnostic naming each offending point", () => {
    const messages: string[] = [];
    const result = withNormalizedCurvePoints(
      {
        ...defaultAutoMeterValueConfig,
        curvePoints: [
          { time: 0, value: 0 },
          { time: 60, value: -1 },
        ],
      },
      (message) => messages.push(message),
    );
    expect(result.curvePoints[1].value).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("curvePoints[1]");
    expect(messages[0]).toContain("time 60s");
    expect(messages[0]).toContain("-1 kWh");
  });
});

describe("describeCurvePointCorrection (#332)", () => {
  it("names the point, the value written and the value used", () => {
    expect(
      describeCurvePointCorrection({
        index: 2,
        problem: "decreasing",
        time: 120,
        value: 3,
        correctedTo: 5,
      }),
    ).toBe(
      "curvePoints[2] (time 120s) delivers 3 kWh, below the 5 kWh the curve already reached at an earlier time; using 5 kWh",
    );
    expect(
      describeCurvePointCorrection({ index: 1, problem: "malformed" }),
    ).toBe(
      "curvePoints[1] is not a { time, value } pair of finite numbers; point discarded",
    );
  });
});
