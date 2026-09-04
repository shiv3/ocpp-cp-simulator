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
 * The effective power a session draws right now, in watts.
 *
 * Combines two independent ceilings the same way for every caller — the
 * battery's own acceptance (the curve, scaled off `evMaxW`) and the OCPP
 * charging-schedule limit — so a reported sample and an accumulated register
 * can never disagree about what "now" means. `min(curve, schedule)`: a curve
 * lowers demand and never raises it, so an active `SetChargingProfile` always
 * wins.
 *
 * `curve` is applied only when `evMaxW` is finite — a fraction of an unknown
 * ceiling isn't a wattage — matching the historical (pre-curve) flat
 * behaviour when no `maxChargingPowerKw` is configured.
 *
 * Returns 0 rather than `Infinity` when neither ceiling is finite (no
 * `maxChargingPowerKw` and no active profile) — there is no sensible power
 * number to report for an uncapped, curve-less session, and 0 is the
 * historical fallback `derivedInstantaneousPowerW` used before this was
 * factored out.
 */
export function effectiveChargingPowerW(params: {
  /** EV's own ceiling in watts, or `Infinity` when unconfigured. */
  evMaxW: number;
  /** Battery-acceptance curve, or `undefined`/empty for flat acceptance. */
  curve: readonly ChargingCurvePoint[] | undefined;
  socPercent: number | null;
  /** Active OCPP charging-profile cap, or `Infinity` when uncapped. */
  scheduleLimitWatts: number;
}): number {
  const { evMaxW, curve, socPercent, scheduleLimitWatts } = params;
  const acceptedW =
    curve && curve.length > 0 && Number.isFinite(evMaxW)
      ? evMaxW * powerFractionAtSoc(curve, socPercent ?? 0)
      : evMaxW;
  const effective = Math.min(acceptedW, scheduleLimitWatts);
  return Number.isFinite(effective)
    ? effective
    : acceptedW === Infinity
      ? 0
      : acceptedW;
}

/**
 * The power factor (cos φ) actually used for the current derivation below —
 * 1 for DC, which has no reactive component, else the configured value
 * (default 1, unity). Exported so a reported `Power.Factor` sample can never
 * name a different value than the one that produced `Current.Import` in the
 * same message.
 */
export function effectivePowerFactor(
  settings: Pick<EVSettings, "currentType" | "powerFactor">,
): number {
  if (settings.currentType === "DC") return 1;
  return clamp01(settings.powerFactor ?? 1) || 1;
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
  return powerW / (voltage * phases * effectivePowerFactor(settings));
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
