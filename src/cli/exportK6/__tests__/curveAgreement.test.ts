// src/cli/exportK6/__tests__/curveAgreement.test.ts
// The two runtimes agree on the auto-meter time curve (#329).
//
// `export-k6` is a second implementation of the scenario semantics, and for
// the auto-meter curve the two used to draw different trajectories: the
// simulator evaluated a De Casteljau Bezier over all control points, the
// export interpolated piecewise-linearly through them. They agreed on a
// two-point curve — the common case, which is why it went unnoticed — and
// from three points on the export ran ahead by up to ~15% of the curve's
// span at the midpoint. Both now go through
// `src/cli/exportK6/runtime/curve.ts`.
//
// The k6 side is driven through `runScenario` rather than by calling the
// shared function twice: a private linear helper re-added inside
// `interpreter.ts` has to fail this test, and it only can if the assertion
// runs the interpreter's real path and reads what went on the wire.
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "../runtime/interpreter";
import { wire16 } from "../runtime/wire/v16";
import type { ScenarioJson } from "../runtime/types";
import {
  calculateBezierPoint,
  evaluateCurveKwh,
  sortCurvePoints,
} from "../runtime/curve";
import {
  getMeterValueAtTime,
  type CurvePoint,
} from "../../../cp/domain/connector/MeterValueCurve";
import { FakeHost } from "./support/fakeHost";

/** kWh the *simulator* has delivered `elapsedSeconds` into a session: the
 *  curve's ordinate then, less its ordinate at session start, which is what
 *  `MeterValueScheduler` baselines against before its first tick. */
function domainDeliveredKwh(
  points: CurvePoint[],
  elapsedSeconds: number,
): number {
  const config = {
    enabled: true,
    curvePoints: points,
    intervalSeconds: 1,
    autoCalculateInterval: false,
  };
  return (
    getMeterValueAtTime(elapsedSeconds, config) - getMeterValueAtTime(0, config)
  );
}

function curveScenario(
  startValueWh: number,
  points: CurvePoint[],
  intervalSec: number,
): ScenarioJson {
  const nodes = [
    { id: "a", type: "start", data: {} },
    // Put the register where a previous session left it, without sending.
    {
      id: "b",
      type: "meterValue",
      data: { value: startValueWh, sendMessage: false },
    },
    { id: "c", type: "transaction", data: { action: "start" } },
    {
      id: "d",
      type: "meterValue",
      data: {
        value: startValueWh,
        sendMessage: true,
        autoIncrement: true,
        incrementInterval: intervalSec,
        useCurve: true,
        curvePoints: points,
      },
    },
    // Parks the walk until the samples have been collected.
    { id: "e", type: "csmsCallTrigger", data: { action: "Ping" } },
    { id: "f", type: "transaction", data: { action: "stop" } },
    { id: "g", type: "end", data: {} },
  ];
  return {
    id: "agreement",
    nodes,
    edges: [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "e"],
      ["e", "f"],
      ["f", "g"],
    ].map(([source, target]) => ({ source, target })),
  };
}

function meterSamplesWh(host: FakeHost): number[] {
  return host.sent
    .filter((c) => c.action === "MeterValues")
    .map((c) =>
      Number(
        (
          c.payload.meterValue as Array<{
            sampledValue: Array<{ value: string }>;
          }>
        )[0].sampledValue[0].value,
      ),
    );
}

/** Delivered Wh per auto-meter tick, as the exported runtime puts it on the
 *  wire. `samples[0]` is the meterValue node's own publish at `startWh`;
 *  every later sample is a tick at `intervalSec * i` seconds elapsed. */
async function k6DeliveredWh(
  points: CurvePoint[],
  intervalSec: number,
  ticks: number,
  startValueWh = 0,
): Promise<number[]> {
  const host = new FakeHost();
  host.responses.set("StartTransaction", {
    idTagInfo: { status: "Accepted" },
    transactionId: 42,
  });
  const run = runScenario(
    host,
    wire16,
    curveScenario(startValueWh, points, intervalSec),
  );
  await vi.waitFor(() =>
    expect(meterSamplesWh(host).length).toBeGreaterThan(ticks),
  );
  host.emitCsmsCall("Ping", {});
  await run;
  return meterSamplesWh(host)
    .slice(1, ticks + 1)
    .map((wh) => wh - startValueWh);
}

/** Curves the two runtimes have to agree on. `sampleAt` are elapsed seconds,
 *  each an exact multiple of `intervalSec` so a tick lands on it. */
const CURVES: Array<{
  name: string;
  points: CurvePoint[];
  intervalSec: number;
  sampleAt: number[];
  startValueWh: number;
}> = [
  {
    name: "two points — the case the old linear reading already got right",
    points: [
      { time: 0, value: 0 },
      { time: 100, value: 10 },
    ],
    intervalSec: 5,
    sampleAt: [10, 25, 50, 75],
    startValueWh: 0,
  },
  {
    name: "three points — the export used to run ahead by 1.5 kWh at t=50",
    points: [
      { time: 0, value: 0 },
      { time: 50, value: 8 },
      { time: 100, value: 10 },
    ],
    intervalSec: 5,
    sampleAt: [10, 25, 50, 75],
    startValueWh: 0,
  },
  {
    name: "four points",
    points: [
      { time: 0, value: 0 },
      { time: 30, value: 5 },
      { time: 60, value: 8 },
      { time: 100, value: 9 },
    ],
    intervalSec: 5,
    sampleAt: [10, 25, 50, 75],
    startValueWh: 0,
  },
  {
    name: "three points straddling t=0",
    points: [
      { time: -20, value: 5 },
      { time: 30, value: 15 },
      { time: 80, value: 20 },
    ],
    intervalSec: 5,
    sampleAt: [10, 25, 50, 75],
    startValueWh: 7000,
  },
  {
    name: "three points beginning after t=0",
    points: [
      { time: 20, value: 2 },
      { time: 60, value: 9 },
      { time: 100, value: 11 },
    ],
    intervalSec: 5,
    sampleAt: [10, 25, 50, 75],
    startValueWh: 3000,
  },
  {
    // `curvePoint.time` has no uniqueness rule, so two points can share an
    // abscissa. Both runtimes now evaluate one Bezier over every control point,
    // so a repeat is simply another control point on both sides — where the
    // deleted piecewise-linear reading returned the *earlier* of the two
    // (docs/log.md, round 16). Pinned so the repeat cannot start meaning two
    // different things again.
    name: "four points with a repeated time",
    points: [
      { time: 0, value: 0 },
      { time: 50, value: 3 },
      { time: 50, value: 8 },
      { time: 100, value: 10 },
    ],
    intervalSec: 5,
    sampleAt: [10, 25, 50, 75],
    startValueWh: 0,
  },
  {
    name: "three points, descending (#332)",
    points: [
      { time: 0, value: 10 },
      { time: 50, value: 4 },
      { time: 100, value: 2 },
    ],
    intervalSec: 5,
    sampleAt: [10, 25, 50, 75],
    startValueWh: 0,
  },
];

describe("the simulator and the exported k6 runtime read one curve the same way (#329)", () => {
  for (const curve of CURVES) {
    it(`agrees on ${curve.name}`, async () => {
      const maxSample = Math.max(...curve.sampleAt);
      const ticks = maxSample / curve.intervalSec;
      const delivered = await k6DeliveredWh(
        curve.points,
        curve.intervalSec,
        ticks,
        curve.startValueWh,
      );
      for (const at of curve.sampleAt) {
        const k6Wh = delivered[at / curve.intervalSec - 1];
        // The register goes on the wire as an integer (`Math.round`), so the
        // simulator's kWh is rounded the same way before comparing. Every
        // other term is exact: the k6 offset is `startWh − curve(0) * 1000`
        // and `startWh` is an integer, so the rounding commutes with it.
        const expected = Math.round(
          domainDeliveredKwh(curve.points, at) * 1000,
        );
        expect(k6Wh, `${curve.name} at t=${at}s`).toBe(expected);
      }
    });
  }
});

// The evaluator and the stop condition are two readers of one array, and they
// have to agree on which point is last. `evaluateCurveKwh` sorts; `shouldStop`
// asks for `curve[curve.length - 1].time`. On a curve whose points are not
// written in time order those were different points, so the auto-meter stopped
// at the last *written* time while the evaluator still had curve left — and the
// export silently dropped every MeterValue after it. `schema/scenario.schema.json`
// does not require `curvePoints` to be sorted, and `MeterValueScheduler` sorts
// before reading its own last point, so the simulator was right and the export
// was not (#329).
describe("an out-of-order curve is sorted once and read in that order by both readers", () => {
  // Written 100, 0, 50: the greatest time is 100 and the *last written* time is
  // 50. An already-ordered curve cannot tell the two apart, so it would not
  // discriminate this.
  const unordered: CurvePoint[] = [
    { time: 100, value: 10 },
    { time: 0, value: 0 },
    { time: 50, value: 8 },
  ];
  const intervalSec = 5;

  /** Runs until the auto-meter loop stops sending of its own accord, then ends
   *  the walk. Stability is judged by the sample count standing still across
   *  several macrotasks — each `FakeHost.sleep` yields one. */
  async function runToAutoMeterStop(points: CurvePoint[]): Promise<number[]> {
    const host = new FakeHost();
    host.responses.set("StartTransaction", {
      idTagInfo: { status: "Accepted" },
      transactionId: 42,
    });
    const run = runScenario(
      host,
      wire16,
      curveScenario(0, points, intervalSec),
    );
    let previous = -1;
    for (let i = 0; i < 200 && previous !== meterSamplesWh(host).length; i++) {
      previous = meterSamplesWh(host).length;
      for (let t = 0; t < 5; t++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    host.emitCsmsCall("Ping", {});
    await run;
    return meterSamplesWh(host);
  }

  it("runs to the curve's greatest time, not to its last written point", async () => {
    const samples = await runToAutoMeterStop(unordered);
    // samples[0] is the meterValue node's own publish; the rest are ticks.
    const ticks = samples.length - 1;
    expect(
      ticks,
      "the auto-meter must tick to t=100s (the curve's greatest time), not stop at t=50s (its last written point)",
    ).toBe(100 / intervalSec);
  });

  it("agrees with the simulator over the whole span, including past the last written point", async () => {
    const samples = await runToAutoMeterStop(unordered);
    for (const at of [10, 25, 50, 75, 100]) {
      const k6Wh = samples[at / intervalSec];
      const expected = Math.round(domainDeliveredKwh(unordered, at) * 1000);
      expect(k6Wh, `unordered curve at t=${at}s`).toBe(expected);
    }
  });

  it("is identical for the same curve written in order", async () => {
    // Differential, and it does discriminate: with the sort removed the two
    // runs produce different sample counts. Stated because writing order is
    // exactly the thing that is supposed to make no difference.
    const ordered = [...unordered].sort((a, b) => a.time - b.time);
    expect(await runToAutoMeterStop(ordered)).toEqual(
      await runToAutoMeterStop(unordered),
    );
  });
});

// The agreement test above cannot see both runtimes drifting together — if the
// shared function went back to piecewise-linear, both columns would move and
// still match. These pin the shape itself, computed by hand from the Bernstein
// form rather than read off the implementation:
//
//   quadratic  B(t) = (1-t)^2 P0 + 2t(1-t) P1 + t^2 P2
//   cubic      B(t) = (1-t)^3 P0 + 3t(1-t)^2 P1 + 3t^2(1-t) P2 + t^3 P3
//
// They go through `evaluateCurveKwh` — the entry point both runtimes call —
// and not only through `calculateBezierPoint`, so linearising the shared
// evaluator itself is caught rather than only a change to the kernel it
// delegates to. The trailing comments are what a piecewise-linear reading of
// the same control points gives: the trajectory this issue removed, and the
// export column of the table in #329.
describe("the shared curve is a Bezier over all control points, not a polyline", () => {
  const quad: CurvePoint[] = [
    { time: 0, value: 0 },
    { time: 50, value: 8 },
    { time: 100, value: 10 },
  ];
  const cubic: CurvePoint[] = [
    { time: 0, value: 0 },
    { time: 30, value: 5 },
    { time: 60, value: 8 },
    { time: 100, value: 9 },
  ];

  it("evaluates a three-point curve as a quadratic Bezier", () => {
    // t = 10/100 = 0.1: 2(0.1)(0.9)(8) + (0.1)^2(10) = 1.44 + 0.10
    expect(evaluateCurveKwh(quad, 10)).toBeCloseTo(1.54, 10); // linear: 1.60
    // 2(0.25)(0.75)(8) + (0.25)^2(10) = 3.000 + 0.625
    expect(evaluateCurveKwh(quad, 25)).toBeCloseTo(3.625, 10); // linear: 4.00
    // 2(0.5)(0.5)(8) + (0.5)^2(10) = 4.000 + 2.500 — the interior control
    // point is 8, and the curve does not pass through it.
    expect(evaluateCurveKwh(quad, 50)).toBeCloseTo(6.5, 10); // linear: 8.00
    // 2(0.75)(0.25)(8) + (0.75)^2(10) = 3.000 + 5.625
    expect(evaluateCurveKwh(quad, 75)).toBeCloseTo(8.625, 10); // linear: 9.00
  });

  it("evaluates a four-point curve as a cubic Bezier", () => {
    // 3(0.1)(0.81)(5) + 3(0.01)(0.9)(8) + (0.001)(9) = 1.215 + 0.216 + 0.009
    expect(evaluateCurveKwh(cubic, 10)).toBeCloseTo(1.44, 10); // linear: 1.6667
    expect(evaluateCurveKwh(cubic, 25)).toBeCloseTo(3.375, 10); // linear: 4.1667
    expect(evaluateCurveKwh(cubic, 50)).toBeCloseTo(6.0, 10); // linear: 7.0
    expect(evaluateCurveKwh(cubic, 75)).toBeCloseTo(7.875, 10); // linear: 8.375
  });

  it("passes through the endpoints and clamps outside the curve's span", () => {
    expect(evaluateCurveKwh(quad, 0)).toBe(0);
    expect(evaluateCurveKwh(quad, 100)).toBe(10);
    expect(evaluateCurveKwh(quad, -30)).toBe(0);
    expect(evaluateCurveKwh(quad, 500)).toBe(10);
    expect(evaluateCurveKwh([], 10)).toBe(0);
  });

  // The exception to "three or more points changes the output". `t` is the
  // normalized position along the *span*, not an abscissa, so the Bezier
  // coincides with the polyline only when its own time coordinates are affine
  // in `t` too — that is, when the points are evenly spaced on a straight line,
  // or when every point carries the same value (which kills the abscissa term).
  // Collinearity alone is NOT enough: measured, `(0,0) (5,5) (20,20)` is
  // collinear, unevenly spaced, and differs by 2.5 kWh at its widest. The docs
  // state this exception; this is what stops them overstating or understating
  // it.
  it("coincides with a polyline exactly when the points are evenly spaced on a line", () => {
    const evenLine: CurvePoint[] = [
      { time: 0, value: 0 },
      { time: 10, value: 10 },
      { time: 20, value: 20 },
    ];
    expect(evaluateCurveKwh(evenLine, 5)).toBeCloseTo(5, 10);
    expect(evaluateCurveKwh(evenLine, 15)).toBeCloseTo(15, 10);

    const flat: CurvePoint[] = [
      { time: 0, value: 7 },
      { time: 5, value: 7 },
      { time: 20, value: 7 },
    ];
    expect(evaluateCurveKwh(flat, 12)).toBeCloseTo(7, 10);

    // Collinear but unevenly spaced — the case a "collinear curves are safe"
    // reading would get wrong.
    const unevenLine: CurvePoint[] = [
      { time: 0, value: 0 },
      { time: 5, value: 5 },
      { time: 20, value: 20 },
    ];
    // t = 10/20 = 0.5: 2(0.5)(0.5)(5) + (0.5)^2(20) = 2.5 + 5.0
    expect(evaluateCurveKwh(unevenLine, 10)).toBeCloseTo(7.5, 10); // polyline: 10
  });

  it("degenerates to a line on two points, which is why they always agreed", () => {
    const two: CurvePoint[] = [
      { time: 0, value: 0 },
      { time: 100, value: 10 },
    ];
    expect(evaluateCurveKwh(two, 50)).toBeCloseTo(5, 10);
    expect(calculateBezierPoint(0.5, two)).toBeCloseTo(5, 10);
  });

  // The sort has to be stable, because a repeated `time` otherwise reorders the
  // points that share it and the Bezier's control polygon changes with them.
  // `Array.prototype.sort` has been required to be stable since ES2019; this
  // asserts it rather than trusting it, and fixes the tie-break as "written
  // order kept, so the later-written point stays later" — the same rule
  // `powerFractionAtSoc` uses for a repeated SoC in `chargingCurve` (#341).
  it("sorts stably, so a repeated time keeps its written order", () => {
    const repeated: CurvePoint[] = [
      { time: 100, value: 10 },
      { time: 50, value: 3 },
      { time: 0, value: 0 },
      { time: 50, value: 8 },
    ];
    expect(sortCurvePoints(repeated)).toEqual([
      { time: 0, value: 0 },
      { time: 50, value: 3 },
      { time: 50, value: 8 },
      { time: 100, value: 10 },
    ]);
    // And the array it is given is not reordered in place — the scenario's own
    // `curvePoints` array is read again elsewhere.
    expect(repeated[0]).toEqual({ time: 100, value: 10 });
  });

  it("sorts its control points before evaluating", () => {
    const shuffled: CurvePoint[] = [
      { time: 100, value: 10 },
      { time: 0, value: 0 },
      { time: 50, value: 8 },
    ];
    expect(evaluateCurveKwh(shuffled, 50)).toBeCloseTo(6.5, 10);
  });
});
