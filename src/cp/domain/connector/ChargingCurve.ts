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
 * The SoC to evaluate the charging curve at when the connector hasn't
 * reported one yet.
 *
 * `connector.soc` is `null` before the first synced meter tick — the normal
 * state for a `Transaction.Begin` sample, and for the whole session when SoC
 * sync is disabled — so falling back to 0 would evaluate the curve as if the
 * battery were empty, tapering (or not tapering) power for the wrong reason.
 * Prefer the transaction's own `initialSoc`, then the EV settings' default,
 * then 0 as the last resort for a session with neither configured (#301).
 */
export function resolveSocForCurve(
  soc: number | null,
  transactionInitialSoc: number | undefined,
  settingsInitialSoc: number | undefined,
): number {
  return soc ?? transactionInitialSoc ?? settingsInitialSoc ?? 0;
}

/**
 * The smallest `powerFactor` the browser panels can express.
 *
 * Their number inputs step by `0.01`, so this is the smallest value a user can
 * dial in there, and both clamp to it rather than to `0`: a cos φ of 0 means
 * no real power flows at all, so `I = P / (V × phases × cos φ)` would be an
 * infinite current for any `P > 0` (#301). It is a UI floor, not the domain
 * contract — `schema/scenario.schema.json` allows any `powerFactor` in
 * `(0, 1]`, and so does {@link effectivePowerFactor}.
 */
export const MIN_UI_POWER_FACTOR = 0.01;

/**
 * The power factor (cos φ) actually used for the current derivation below —
 * 1 for DC, which has no reactive component, else the configured value
 * (default 1, unity).
 *
 * This is the single source of truth for both the derivation and the reported
 * `Power.Factor` sample, and `MeterValueBuilder` reports the returned number
 * verbatim rather than rounding it, so a `Power.Factor` sample can never name
 * a different value than the one that produced `Current.Import` in the same
 * message.
 *
 * A value outside `(0, 1]` is out of contract. `schema/scenario.schema.json`
 * marks it invalid, so every scenario load path warns about it — but that
 * validation is advisory by design and the file still loads — and neither
 * browser panel can produce one. It therefore still reaches here, from a
 * scenario file loaded past the warning or from raw RPC, which validates no
 * `evSettings` field at all. Such a value — `0`, negative, `NaN`, above 1 —
 * is treated as unity rather than producing an infinite or negative current.
 * That substitution is never silent: because the sample reports what this
 * function returned, a session configured with `powerFactor: 0` puts
 * `Power.Factor = 1` on the wire, where a CSMS and the operator can both see
 * that 1, not 0, is what the simulator used.
 */
export function effectivePowerFactor(
  settings: Pick<EVSettings, "currentType" | "powerFactor">,
): number {
  if (settings.currentType === "DC") return 1;
  const configured = settings.powerFactor;
  if (configured === undefined) return 1;
  if (!Number.isFinite(configured)) return 1;
  if (configured <= 0 || configured > 1) return 1;
  return configured;
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
