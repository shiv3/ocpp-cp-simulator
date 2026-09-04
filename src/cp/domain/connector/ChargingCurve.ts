import type { ChargingCurvePoint, EVSettings } from "./EVSettings";

/** Default phase-to-neutral volts when settings name none. */
export const DEFAULT_VOLTAGE_V = 230;

/**
 * Sort a curve by SoC and drop points that cannot be interpolated.
 *
 * Done once, at the boundary, so every evaluation can assume a monotone x-axis
 * rather than re-sorting per sample.
 */
export function normalizeChargingCurve(
  points: readonly ChargingCurvePoint[],
): ChargingCurvePoint[] {
  return points
    .filter(
      (p) =>
        Number.isFinite(p.socPercent) &&
        Number.isFinite(p.powerFraction) &&
        p.socPercent >= 0 &&
        p.socPercent <= 100 &&
        p.powerFraction >= 0 &&
        p.powerFraction <= 1,
    )
    .slice()
    .sort((a, b) => a.socPercent - b.socPercent);
}

/**
 * The fraction of maximum power the battery accepts at this SoC.
 *
 * Piecewise-linear between the given points, clamped to the first and last —
 * a curve that starts at 20% says nothing about 10%, and extrapolating there
 * would invent a number rather than admit the curve does not cover it.
 *
 * Returns 1 for an empty curve, which is the historical flat behaviour.
 */
export function powerFractionAtSoc(
  curve: readonly ChargingCurvePoint[],
  socPercent: number,
): number {
  if (curve.length === 0) return 1;
  const soc = Number.isFinite(socPercent) ? socPercent : 0;
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  if (soc <= first.socPercent) return first.powerFraction;
  if (soc >= last.socPercent) return last.powerFraction;

  for (let i = 1; i < curve.length; i++) {
    const lo = curve[i - 1]!;
    const hi = curve[i]!;
    if (soc > hi.socPercent) continue;
    const span = hi.socPercent - lo.socPercent;
    // Two points at the same SoC: take the later one rather than dividing by
    // zero. A curve is allowed to step.
    if (span <= 0) return hi.powerFraction;
    const t = (soc - lo.socPercent) / span;
    return lo.powerFraction + t * (hi.powerFraction - lo.powerFraction);
  }
  return last.powerFraction;
}

/**
 * The ramp factor at `progress` (0-1) through the ramp window.
 *
 * `linear` is the identity. `sigmoid` is a logistic curve pinned at f(0)=0 and
 * f(1)=1, which models the CCS/CHAdeMO handshake and pre-charge more faithfully
 * than a straight line: real sessions spend a moment near zero, climb quickly,
 * then settle.
 */
export function rampFactor(
  progress: number,
  shape: EVSettings["rampShape"],
): number {
  const t = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 1));
  if (shape !== "sigmoid") return t;
  const k = 12;
  const raw = (x: number) => 1 / (1 + Math.exp(-k * (x - 0.5)));
  const lo = raw(0);
  const hi = raw(1);
  // Pinned, so the ramp genuinely starts at 0 and reaches 1 rather than
  // asymptotically approaching them.
  return (raw(t) - lo) / (hi - lo);
}

/**
 * Current for a given real power, by current type.
 *
 * DC has no reactive component, so `I = P / V`. AC divides across phases and
 * by the power factor: `I = P / (V × phases × cos φ)`, with `voltageV` read as
 * **phase-to-neutral**. Applying `powerFactor` to DC — as a single shared
 * formula would — reports a current the hardware could not draw.
 */
export function currentAmpsFor(
  powerW: number,
  settings: Pick<
    EVSettings,
    "currentType" | "phases" | "voltageV" | "powerFactor"
  >,
): number {
  const voltage = positiveOr(settings.voltageV, DEFAULT_VOLTAGE_V);
  if (powerW <= 0) return 0;
  if (settings.currentType === "DC") return powerW / voltage;
  const phases = settings.phases === 3 ? 3 : 1;
  const powerFactor = clamp01(settings.powerFactor ?? 1) || 1;
  return powerW / (voltage * phases * powerFactor);
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
