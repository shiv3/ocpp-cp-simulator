// src/cli/exportK6/runtime/curve.ts
// The auto-meter **time curve**, evaluated. This is the single implementation
// both runtimes use: the simulator reaches it through
// `src/cp/domain/connector/MeterValueCurve.ts`, the exported k6 runtime imports
// it directly, so one scenario can no longer draw two different trajectories
// (#329). The export used to interpolate piecewise-linearly through the control
// points while the simulator evaluated a Bezier over them, which agreed only
// for two-point curves and ran up to ~15% of the curve's span ahead at the
// midpoint of a three-point one.
//
// It lives under `runtime/` rather than under `src/cp` because an export bundle
// is a verbatim copy of this directory (see `runtimeManifest.RUNTIME_FILES`):
// that is how the export "inlines" a helper, and every file here must have zero
// repo imports so the copy still compiles on its own. The dependency therefore
// points domain → this leaf, never the other way. Keep this file
// dependency-free.

/** A control point of the auto-meter time curve. */
export interface CurvePoint {
  /** Time in **seconds** from transaction start. */
  time: number;
  /** MeterValue in kWh. */
  value: number;
}

/**
 * `points` ordered by time, as a new array. Every reader of a curve — the
 * evaluator, and the auto-meter's stop condition — has to agree on which point
 * is last, and `schema/scenario.schema.json` does not require `curvePoints` to
 * be sorted. Sorting once at the point a curve enters a run and passing the
 * result to both is one fewer place for them to disagree.
 *
 * Stable (`Array.prototype.sort` has been required to be so since ES2019) and
 * therefore idempotent, which the k6 path depends on: it sorts here at the
 * start of a run and `evaluateCurveKwh` sorts again on every tick, while the
 * simulator sorts only inside the evaluator. Both reach the same order only
 * because a second stable sort of an already-sorted array is the identity. A
 * repeated `time` keeps its written order, so the later-written point stays
 * later — the same tie-break `powerFractionAtSoc` uses for `chargingCurve`.
 * Returns a new array; the caller's is never reordered.
 */
export function sortCurvePoints(points: readonly CurvePoint[]): CurvePoint[] {
  return [...points].sort((a, b) => a.time - b.time);
}

/**
 * Value of the Bezier defined by `points` at parameter `t` in `[0, 1]`.
 *
 * De Casteljau over **all** control points, so the curve is of degree
 * `points.length - 1` and passes through its first and last point only — an
 * interior control point pulls the curve toward itself without lying on it.
 * Two points degenerate to linear interpolation, which is why the export's old
 * piecewise-linear reading agreed on exactly that case.
 */
export function calculateBezierPoint(t: number, points: CurvePoint[]): number {
  if (points.length === 0) return 0;
  if (points.length === 1) return points[0].value;
  if (points.length === 2) {
    // Linear interpolation
    return points[0].value + (points[1].value - points[0].value) * t;
  }

  // For multiple points, use De Casteljau's algorithm
  const n = points.length - 1;
  let tempPoints = [...points];

  for (let i = 1; i <= n; i++) {
    const newPoints: CurvePoint[] = [];
    for (let j = 0; j <= n - i; j++) {
      newPoints.push({
        time: (1 - t) * tempPoints[j].time + t * tempPoints[j + 1].time,
        value: (1 - t) * tempPoints[j].value + t * tempPoints[j + 1].value,
      });
    }
    tempPoints = newPoints;
  }

  return tempPoints[0].value;
}

/**
 * The curve's ordinate, in kWh, at `elapsedSeconds` from transaction start.
 *
 * Points are sorted by time; the time axis is clamped to the curve's own span
 * (before the first point reads the first point's value, after the last reads
 * the last), then normalized to the Bezier's `t`. Returns 0 for an empty curve.
 *
 * Note that `t` is the *normalized position along the parameter range*, not a
 * time: for three or more points the curve's abscissae move with `t` too, so
 * the value at `elapsedSeconds` is the Bezier's value at that fraction of the
 * span rather than the value of the curve where its abscissa equals
 * `elapsedSeconds`. Both runtimes read it the same way, which is the property
 * that matters here.
 */
export function evaluateCurveKwh(
  points: readonly CurvePoint[],
  elapsedSeconds: number,
): number {
  if (points.length === 0) return 0;

  const sortedPoints = sortCurvePoints(points);
  const minTime = sortedPoints[0].time;
  const maxTime = sortedPoints[sortedPoints.length - 1].time;

  // Clamp elapsed time to curve range
  const clampedTime = Math.max(minTime, Math.min(maxTime, elapsedSeconds));

  // Normalize t to [0, 1] range
  const t =
    maxTime > minTime ? (clampedTime - minTime) / (maxTime - minTime) : 0;

  return calculateBezierPoint(t, sortedPoints);
}
