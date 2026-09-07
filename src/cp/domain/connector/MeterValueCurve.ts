/**
 * The auto-meter time curve, as the simulator reads it.
 *
 * The evaluation itself lives in `src/cli/exportK6/runtime/curve.ts` and is
 * re-exported here: the exported k6 runtime is a second implementation of these
 * scenario semantics, and the two used to interpolate differently (Bezier here,
 * piecewise-linear there). One module, imported by both, is what stops that
 * recurring (#329). The module sits under the export runtime because an export
 * bundle is a verbatim copy of that directory and every file in it must be free
 * of repo imports; nothing else about the ownership changes.
 */
import {
  calculateBezierPoint,
  evaluateCurveKwh,
  type CurvePoint,
} from "../../../cli/exportK6/runtime/curve";

export { calculateBezierPoint, evaluateCurveKwh };
export type { CurvePoint };

/**
 * Configuration for automatic MeterValue sending
 */
export interface AutoMeterValueConfig {
  /** Whether auto MeterValue is enabled */
  enabled: boolean;
  /** Control points for the Bezier curve */
  curvePoints: CurvePoint[];
  /** Interval for sending MeterValue (in seconds) */
  intervalSeconds: number;
  /** Whether to calculate interval automatically from curve duration */
  autoCalculateInterval: boolean;
  /**
   * When true, the auto-meter stops and the in-flight transaction is ended
   * once the connector's SoC reaches `EVSettings.targetSoc`. The chart's
   * max time / max value caps are ignored in this mode — the curve runs
   * "until the battery is full".
   */
  stopAtTargetSoc?: boolean;
}

/**
 * Get MeterValue at a specific time based on the curve
 */
export function getMeterValueAtTime(
  elapsedSeconds: number,
  config: AutoMeterValueConfig,
): number {
  return evaluateCurveKwh(config.curvePoints, elapsedSeconds);
}

/**
 * Default auto MeterValue configuration
 */
export const defaultAutoMeterValueConfig: AutoMeterValueConfig = {
  enabled: false,
  // Curve time is in seconds. 1800s = 30 minutes; deliver 50 kWh over that
  // window for a sensible "fast charge" default.
  curvePoints: [
    { time: 0, value: 0 },
    { time: 1800, value: 50 },
  ],
  intervalSeconds: 10,
  autoCalculateInterval: false,
};

/**
 * What kind of contract violation a curve point committed, and what the
 * normalizer did about it. See {@link normalizeCurvePoints}.
 *
 * - `malformed` — not a `{ time, value }` pair of finite numbers; **dropped**.
 * - `negative` — a delivered-energy ordinate below zero; raised to the
 *   running maximum (at least 0).
 * - `decreasing` — a non-negative ordinate below one the curve already
 *   reached at an earlier time; raised to that earlier value.
 */
export type CurvePointProblem = "malformed" | "negative" | "decreasing";

/** One correction {@link normalizeCurvePoints} made, naming the offending
 *  point by its index **in the curve as written** (not in the sorted result),
 *  so a diagnostic points the operator at the entry they can edit. */
export interface CurvePointCorrection {
  index: number;
  problem: CurvePointProblem;
  /** Abscissa of the offending point; absent when the point is `malformed`. */
  time?: number;
  /** Ordinate as written; absent when the point is `malformed`. */
  value?: number;
  /** Ordinate used instead; absent when the point was dropped. */
  correctedTo?: number;
}

export interface CurvePointNormalization {
  /** The curve actually used: sorted by time, non-negative, non-decreasing. */
  points: CurvePoint[];
  /** Every departure from that contract, in the order the points were written. */
  corrections: CurvePointCorrection[];
}

/**
 * Sort an auto-meter curve by time and make its ordinates non-negative and
 * non-decreasing (#332).
 *
 * `curvePoint.value` is **cumulative energy delivered in the session, in
 * kWh**, and `MeterValueScheduler` assigns it (offset onto the register)
 * outright rather than adding a delta. A trajectory that descends over
 * elapsed time therefore drives `Energy.Active.Import.Register` *backwards*,
 * below `meterStart`, and a `meterStop` below `meterStart` is a protocol
 * violation a strict CSMS rejects. `tickCurve`'s `Math.max(delivered, ...)`
 * does not catch it: that clamp lives inside the `cap !== Infinity` branch and
 * so runs only while a charging profile is in force, which is the *unusual*
 * case.
 *
 * Offending ordinates are **clamped to the running maximum, not dropped**.
 * Clamping preserves the curve's time span, which `autoCalculateInterval`
 * divides into an interval and which the exported k6 runtime reads as the
 * auto-meter's stop condition; dropping points would silently shorten the
 * session as well as flatten it. The register then plateaus where the curve
 * descends — energy already delivered is never un-delivered — which is the
 * weakest correction that still honours the documented guarantee that a
 * tapering curve only ever *slows* the register.
 *
 * Takes `unknown` deliberately, exactly like
 * {@link normalizeChargingCurve}: `set_auto_meter_config` types its
 * payload as an opaque record and validates no field of it, and scenario-file
 * schema validation is advisory by design, so an array of nulls or of objects
 * missing `time` genuinely reaches here. Nothing thrown, ever — the worst
 * input yields an empty curve, which `getMeterValueAtTime` reads as a
 * constant 0 and which the scheduler turns into a register that holds still.
 */
export function normalizeCurvePoints(points: unknown): CurvePointNormalization {
  if (!Array.isArray(points)) {
    return { points: [], corrections: [] };
  }

  const corrections: CurvePointCorrection[] = [];
  const kept: { index: number; point: CurvePoint }[] = [];
  points.forEach((candidate, index) => {
    if (isCurvePoint(candidate)) {
      kept.push({ index, point: candidate });
    } else {
      corrections.push({ index, problem: "malformed" });
    }
  });

  // Monotonicity is a statement about *time*, so the running maximum has to
  // be taken in time order. `Array.prototype.sort` is stable, so a curve that
  // names the same time twice keeps the order it was written in — the later
  // point wins the running maximum, which is the same "last point at this
  // abscissa" rule `powerFractionAtSoc` uses for the other curve field.
  kept.sort((a, b) => a.point.time - b.point.time);

  const normalized: CurvePoint[] = [];
  let runningMaxKwh = 0;
  for (const { index, point } of kept) {
    const corrected = Math.max(runningMaxKwh, point.value);
    if (corrected !== point.value) {
      corrections.push({
        index,
        problem: point.value < 0 ? "negative" : "decreasing",
        time: point.time,
        value: point.value,
        correctedTo: corrected,
      });
      // Spread, not a fresh literal: the schema allows extra keys on a point
      // and the RPC payload is opaque, so a corrected point must keep whatever
      // metadata it carried, exactly as an uncorrected one does.
      normalized.push({ ...point, value: corrected });
    } else {
      normalized.push(point);
    }
    runningMaxKwh = corrected;
  }

  corrections.sort((a, b) => a.index - b.index);
  return { points: normalized, corrections };
}

/** A curve entry the scheduler can interpolate: an object with two finite
 *  numbers. Mirrors `isChargingCurvePoint` for the other curve field. */
function isCurvePoint(value: unknown): value is CurvePoint {
  if (typeof value !== "object" || value === null) return false;
  const { time, value: ordinate } = value as Record<string, unknown>;
  return (
    typeof time === "number" &&
    typeof ordinate === "number" &&
    Number.isFinite(time) &&
    Number.isFinite(ordinate)
  );
}

/** A one-line diagnostic naming the offending point, for the operator who has
 *  to go and fix the file or the RPC payload. */
export function describeCurvePointCorrection(
  correction: CurvePointCorrection,
): string {
  const { index, problem, time, value, correctedTo } = correction;
  const at = `curvePoints[${index}]`;
  switch (problem) {
    case "malformed":
      return `${at} is not a { time, value } pair of finite numbers; point discarded`;
    case "negative":
      return `${at} (time ${time}s) delivers ${value} kWh, which is negative; using ${correctedTo} kWh`;
    case "decreasing":
      return `${at} (time ${time}s) delivers ${value} kWh, below the ${correctedTo} kWh the curve already reached at an earlier time; using ${correctedTo} kWh`;
  }
}

/**
 * An auto-meter config with its `curvePoints` normalized — the one guard the
 * boundary that accepts a config from outside the domain uses, mirroring
 * {@link withNormalizedChargingCurve} for `EVSettings.chargingCurve` (#332).
 *
 * Applied on `Connector`'s `autoMeterValueConfig` setter, which every path
 * that can set one funnels through: the browser panels
 * (`LocalChargePointService`), the CLI's `service.ts`, and the control plane's
 * `set_auto_meter_config`, whose payload schema validates no field at
 * all.
 *
 * A config whose curve is already sorted, non-negative and non-decreasing is
 * returned **unchanged, object identity included**, so a round trip through
 * this function cannot make an equality check fail or fire a spurious
 * `autoMeterValueChange`.
 *
 * `onCorrection` is called once per departure from the contract, before the
 * corrected config is returned.
 */
export function withNormalizedCurvePoints<
  T extends { curvePoints?: CurvePoint[] },
>(config: T, onCorrection?: (message: string) => void): T {
  if (config.curvePoints == null) return config;
  const { points, corrections } = normalizeCurvePoints(config.curvePoints);
  // `Array.isArray` first, and not merely for the type: `sameOrder` reads
  // `.length` and then calls `.every`, so any non-array whose `length` happens
  // to be 0 — `""`, `{ length: 0 }` — passed the length test and then threw on
  // the missing `every`. `set_auto_meter_config` validates no field of the
  // config, so such a value genuinely arrives here, and before #332 it was
  // quietly read as an empty curve. An identity check is only meaningful on
  // the caller's own array anyway; everything else falls through to the
  // normalized `[]`.
  if (
    Array.isArray(config.curvePoints) &&
    corrections.length === 0 &&
    sameOrder(config.curvePoints, points)
  ) {
    return config;
  }
  for (const correction of corrections) {
    onCorrection?.(describeCurvePointCorrection(correction));
  }
  return { ...config, curvePoints: points };
}

/** Whether normalization was a no-op down to the identity of every point, so
 *  the caller's own object can be handed straight back. */
function sameOrder(written: readonly CurvePoint[], points: CurvePoint[]) {
  return (
    written.length === points.length &&
    written.every((point, index) => point === points[index])
  );
}
