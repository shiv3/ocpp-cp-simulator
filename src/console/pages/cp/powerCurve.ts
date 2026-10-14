/**
 * The connector card's curve editor draws **power over the session** (kW over
 * minutes, piecewise linear), while the connector's `AutoMeterValueConfig`
 * stores **cumulative energy** (`curvePoints`: kWh over seconds) that the
 * simulator evaluates as one Bezier over all its control points
 * (`evaluateCurveKwh`). This module converts at that boundary:
 *
 * - writing, a power curve becomes its energy integral sampled at uniform
 *   times (one sample a minute, at most 240). Uniform times keep the Bezier's
 *   abscissa linear, so what the simulator sends is the Bernstein
 *   approximation of the drawn curve: within a few percent, smoothed over a
 *   couple of minutes around a corner. A constant power is the exact
 *   two-point line;
 * - reading, a curve of 12 or more uniform samples is read as samples (what
 *   this module wrote); anything else is evaluated as the simulator evaluates
 *   it, then turned back into the fewest power points that draw it.
 */
import {
  evaluateCurveKwh,
  normalizeCurvePoints,
  type CurvePoint,
} from "../../../cp/domain/connector/MeterValueCurve";

/** One vertex of the editor's power curve. */
export interface PowerPoint {
  /** Minutes from transaction start. */
  minute: number;
  /** Power in kW. */
  kw: number;
}

const MAX_SAMPLES = 240;
const MIN_READ_SAMPLES = 12;

const round = (value: number, step: number) => Math.round(value / step) * step;
const tidy = (value: number, decimals: number) =>
  Number(value.toFixed(decimals));

function sorted(points: readonly PowerPoint[]): PowerPoint[] {
  return [...points].sort((a, b) => a.minute - b.minute);
}

/** The power at `minute`, interpolated; 0 outside the curve. */
export function powerAt(points: readonly PowerPoint[], minute: number): number {
  const pts = sorted(points);
  if (pts.length === 0) return 0;
  if (minute < pts[0].minute || minute > pts[pts.length - 1].minute) return 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (minute <= b.minute) {
      const span = b.minute - a.minute;
      return span <= 0
        ? b.kw
        : a.kw + ((b.kw - a.kw) * (minute - a.minute)) / span;
    }
  }
  return pts[pts.length - 1].kw;
}

/** Energy delivered from the curve's start up to `minute`, in kWh. */
function energyUpTo(pts: readonly PowerPoint[], minute: number): number {
  let kwh = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (minute <= a.minute) break;
    const end = Math.min(minute, b.minute);
    const kwEnd = powerAt([a, b], end);
    kwh += (((a.kw + kwEnd) / 2) * (end - a.minute)) / 60;
  }
  return kwh;
}

/** Energy over the whole curve, in kWh (trapezoids). */
export function curveEnergyKwh(points: readonly PowerPoint[]): number {
  const pts = sorted(points);
  return pts.length < 2 ? 0 : energyUpTo(pts, pts[pts.length - 1].minute);
}

export function curvePeakKw(points: readonly PowerPoint[]): number {
  return points.reduce((max, p) => Math.max(max, p.kw), 0);
}

/** Minutes from transaction start to the curve's last point. */
export function curveDurationMin(points: readonly PowerPoint[]): number {
  return points.reduce((max, p) => Math.max(max, p.minute), 0);
}

/** Power points → the energy control points `AutoMeterValueConfig` stores. */
export function powerToCurvePoints(
  points: readonly PowerPoint[],
): CurvePoint[] {
  const pts = sorted(points);
  if (pts.length < 2) return [];
  const start = pts[0].minute;
  const end = pts[pts.length - 1].minute;
  if (end <= start) return [];
  if (pts.every((p) => p.kw === pts[0].kw)) {
    return [
      { time: tidy(start * 60, 3), value: 0 },
      {
        time: tidy(end * 60, 3),
        value: tidy((pts[0].kw * (end - start)) / 60, 4),
      },
    ];
  }
  const steps = Math.min(MAX_SAMPLES, Math.max(2, Math.round(end - start)));
  const step = (end - start) / steps;
  const out: CurvePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const minute = start + i * step;
    out.push({
      time: tidy(minute * 60, 3),
      value: tidy(energyUpTo(pts, minute), 4),
    });
  }
  return out;
}

function isUniform(points: readonly CurvePoint[]): boolean {
  const step = points[1].time - points[0].time;
  return (
    step > 0 &&
    points.every(
      (p, i) =>
        i === 0 ||
        Math.abs(p.time - points[i - 1].time - step) <= step * 1e-6 + 1e-6,
    )
  );
}

interface Segment {
  /** Sample indices covered (inclusive). */
  a: number;
  b: number;
  /** A line through 3+ collinear samples; a lone sample otherwise. */
  line: boolean;
  slope: number;
  intercept: number;
}

const valueOn = (s: Segment, m: number) => s.intercept + s.slope * m;

/**
 * Per-step average powers (at the step midpoints) back to vertices: runs of
 * collinear samples become lines, adjacent lines meet where they intersect,
 * and a sample that straddles a corner is dropped when the two lines around
 * it meet inside it.
 */
function samplesToPower(
  startMin: number,
  stepMin: number,
  powers: number[],
): PowerPoint[] {
  const n = powers.length;
  const endMin = startMin + n * stepMin;
  if (n === 1) {
    return [
      { minute: startMin, kw: powers[0] },
      { minute: endMin, kw: powers[0] },
    ];
  }
  const mid = (j: number) => startMin + (j + 0.5) * stepMin;
  const peak = Math.max(...powers.map(Math.abs));
  const tol = Math.max(0.02, peak * 0.002);
  const lineThrough = (a: number, c: number) => {
    const slope = (powers[c] - powers[a]) / (mid(c) - mid(a));
    return { slope, intercept: powers[a] - slope * mid(a) };
  };
  const fits = (a: number, c: number) => {
    const { slope, intercept } = lineThrough(a, c);
    for (let j = a + 1; j < c; j++) {
      if (Math.abs(powers[j] - (intercept + slope * mid(j))) > tol) {
        return false;
      }
    }
    return true;
  };

  const segments: Segment[] = [];
  let a = 0;
  while (a < n) {
    if (a + 2 < n && fits(a, a + 2)) {
      let b = a + 2;
      while (b + 1 < n && fits(a, b + 1)) b++;
      segments.push({ a, b, line: true, ...lineThrough(a, b) });
      a = b + 1;
    } else {
      segments.push({ a, b: a, line: false, slope: 0, intercept: powers[a] });
      a += 1;
    }
  }

  const out: PowerPoint[] = [];
  const push = (minute: number, kw: number) => out.push({ minute, kw });
  const first = segments[0];
  push(startMin, first.line ? valueOn(first, startMin) : powers[first.a]);

  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (!seg.line) {
      if (i > 0 && i < segments.length - 1) push(mid(seg.a), powers[seg.a]);
      i += 1;
      continue;
    }
    // The lone samples up to the next line.
    let k = i + 1;
    while (k < segments.length && !segments[k].line) k++;
    if (k >= segments.length) {
      if (k - i - 1 > 0)
        push(mid(seg.b) + stepMin / 2, valueOn(seg, mid(seg.b) + stepMin / 2));
      i += 1;
      continue;
    }
    const next = segments[k];
    const lo = mid(seg.b);
    const hi = mid(next.a);
    const meet =
      seg.slope !== next.slope
        ? (next.intercept - seg.intercept) / (seg.slope - next.slope)
        : Number.NaN;
    if (k - i - 1 <= 1 && meet >= lo - 1e-9 && meet <= hi + 1e-9) {
      push(meet, valueOn(seg, meet));
      i = k;
      continue;
    }
    // No clean corner: end this line at its last step, keep the lone
    // samples, start the next line at its first step.
    const endHere = lo + stepMin / 2;
    const startNext = hi - stepMin / 2;
    push(endHere, valueOn(seg, endHere));
    for (let j = i + 1; j < k; j++)
      push(mid(segments[j].a), powers[segments[j].a]);
    if (
      startNext !== endHere ||
      Math.abs(valueOn(next, startNext) - valueOn(seg, endHere)) > tol
    ) {
      push(startNext, valueOn(next, startNext));
    }
    i = k;
  }
  const last = segments[segments.length - 1];
  push(endMin, last.line ? valueOn(last, endMin) : powers[last.a]);

  return out.map((p) => ({
    minute: tidy(round(p.minute, 0.1), 1),
    kw: tidy(Math.max(0, round(p.kw, 0.1)), 1),
  }));
}

/** The energy control points of an `AutoMeterValueConfig` → power points. */
export function curvePointsToPower(
  curvePoints: readonly CurvePoint[],
): PowerPoint[] {
  const pts = normalizeCurvePoints(curvePoints).points;
  if (pts.length < 2) return [];
  const start = pts[0].time;
  const end = pts[pts.length - 1].time;
  if (end <= start) return [];
  if (pts.length === 2) {
    const kw = tidy(((pts[1].value - pts[0].value) / (end - start)) * 3600, 4);
    return [
      { minute: tidy(start / 60, 3), kw },
      { minute: tidy(end / 60, 3), kw },
    ];
  }
  let energies: number[];
  if (pts.length >= MIN_READ_SAMPLES && isUniform(pts)) {
    energies = pts.map((p) => p.value);
  } else {
    const steps = Math.min(
      MAX_SAMPLES,
      Math.max(MIN_READ_SAMPLES, Math.round((end - start) / 60)),
    );
    energies = Array.from({ length: steps + 1 }, (_, i) =>
      evaluateCurveKwh(pts, start + ((end - start) * i) / steps),
    );
  }
  const steps = energies.length - 1;
  const stepMin = (end - start) / 60 / steps;
  const powers = energies
    .slice(1)
    .map((e, i) => ((e - energies[i]) / stepMin) * 60);
  return samplesToPower(start / 60, stepMin, powers);
}

export interface PowerCurvePreset {
  id: "constant" | "ramp" | "taper";
  label: string;
  points: PowerPoint[];
}

const formatKw = (kw: number) => String(tidy(kw, 1));

/** The mock's three shapes, kept under the EV's max power: an AC-like
 *  7.4 kW (or less) for the first two, the EV's own peak for the taper. */
export function powerCurvePresets(maxKw: number): PowerCurvePreset[] {
  const ac = Math.min(7.4, maxKw);
  const f = maxKw / 11;
  const r = (kw: number) => tidy(round(kw, 0.1), 1);
  return [
    {
      id: "constant",
      label: `Constant ${formatKw(ac)} kW`,
      points: [
        { minute: 0, kw: ac },
        { minute: 60, kw: ac },
      ],
    },
    {
      id: "ramp",
      label: "Ramp and hold",
      points: [
        { minute: 0, kw: 0 },
        { minute: 3, kw: ac },
        { minute: 50, kw: ac },
        { minute: 60, kw: 0 },
      ],
    },
    {
      id: "taper",
      label: "Taper (DC-like)",
      points: [
        { minute: 0, kw: r(2 * f) },
        { minute: 4, kw: maxKw },
        { minute: 30, kw: maxKw },
        { minute: 45, kw: r(6 * f) },
        { minute: 60, kw: r(2 * f) },
      ],
    },
  ];
}

export function formatMinutes(minutes: number): string {
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}

/** "6.6 kWh over 60 min, peak 7.4 kW, stop at target SoC". */
export function describePowerCurve(
  points: readonly PowerPoint[],
  stopAtTargetSoc: boolean,
): string {
  if (points.length < 2) return "no curve";
  return `${curveEnergyKwh(points).toFixed(1)} kWh over ${formatMinutes(
    curveDurationMin(points),
  )} min, peak ${curvePeakKw(points).toFixed(1)} kW${
    stopAtTargetSoc ? ", stop at target SoC" : ""
  }`;
}
