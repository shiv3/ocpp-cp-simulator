import type { ChargingCurvePoint, EVSettings } from "./EVSettings";

/** Default phase-to-neutral volts when settings name none. */
export const DEFAULT_VOLTAGE_V = 230;

/**
 * The electrical side of {@link EVSettings} — everything needed to convert
 * between watts and amperes in either direction. Both directions live in this
 * module and take this same shape, so they cannot drift apart (#301).
 */
export type ElectricalSettings = Pick<
  EVSettings,
  "currentType" | "phases" | "voltageV" | "powerFactor"
>;

/**
 * Sort a curve by SoC and drop points that cannot be interpolated.
 *
 * Done once, at the boundary, so every evaluation can assume a monotone x-axis
 * rather than re-sorting per sample.
 *
 * Takes `unknown` deliberately. `src/protocol/methods.ts` types `evSettings`
 * as an opaque object and validates none of its fields, and scenario-file
 * schema validation is advisory (the file loads past the warning), so a
 * `chargingCurve` that is not an array — or an array of nulls, strings or
 * objects missing `socPercent` — genuinely reaches this function from
 * `set_ev_settings`, a hand-written scenario file or a browser import. Every
 * such value is **discarded**, exactly like a point that fails the range
 * checks; none of them throws. An empty result is flat acceptance at
 * `maxChargingPowerKw`, the same as no curve at all.
 */
export function normalizeChargingCurve(points: unknown): ChargingCurvePoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter(isChargingCurvePoint)
    .sort((a, b) => a.socPercent - b.socPercent);
}

/** A curve entry we can interpolate: an object with two in-range numbers. */
function isChargingCurvePoint(value: unknown): value is ChargingCurvePoint {
  if (typeof value !== "object" || value === null) return false;
  const { socPercent, powerFraction } = value as Record<string, unknown>;
  return (
    typeof socPercent === "number" &&
    typeof powerFraction === "number" &&
    Number.isFinite(socPercent) &&
    Number.isFinite(powerFraction) &&
    socPercent >= 0 &&
    socPercent <= 100 &&
    powerFraction >= 0 &&
    powerFraction <= 1
  );
}

/**
 * EV settings with their `chargingCurve` normalized — the one guard every
 * boundary that accepts settings from outside the domain uses.
 *
 * Applied at each place untrusted settings enter: `Connector`'s `evSettings`
 * setter (and therefore `applyEvSettingsOverride` / `applyDefaultEvSettings`),
 * {@link setUserDefaultEVSettings} (which `getDefaultEVSettings` feeds
 * straight into a fresh `Connector`'s field initializer, bypassing that
 * setter), and the browser panels that hydrate a scenario's `evSettings` from
 * an imported file. One validator, several call sites — a second one would
 * drift.
 *
 * Settings with no curve are returned unchanged, object identity included, so
 * this never adds a `chargingCurve: undefined` key that an `Object.entries`
 * walk over a partial would then treat as a field the user filled in.
 */
export function withNormalizedChargingCurve<
  T extends { chargingCurve?: ChargingCurvePoint[] },
>(settings: T): T {
  if (settings.chargingCurve == null) return settings;
  return {
    ...settings,
    chargingCurve: normalizeChargingCurve(settings.chargingCurve),
  };
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
 * The phase-to-neutral voltage actually used for the derivations below —
 * the configured `voltageV`, or 230 V when it is absent, zero, negative or
 * non-finite.
 *
 * This is the single source of truth for both the derivation and the reported
 * `Voltage` sample, for the same reason `effectivePowerFactor` is: a
 * `voltageV: 0` used to put `Voltage = 0` on the wire next to a
 * `Current.Import` derived from 230 V, two numbers in one MeterValue that
 * cannot both be true. The substitution is not silent — the sample names the
 * 230 that produced the current (#301).
 */
export function effectiveVoltageV(
  settings: Pick<EVSettings, "voltageV">,
): number {
  return positiveOr(settings.voltageV, DEFAULT_VOLTAGE_V);
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
  settings: ElectricalSettings,
): number {
  const voltage = effectiveVoltageV(settings);
  if (powerW <= 0) return 0;
  if (settings.currentType === "DC") return powerW / voltage;
  return (
    powerW / (voltage * acPhases(settings) * effectivePowerFactor(settings))
  );
}

/**
 * Real power drawn at a given current — the exact inverse of
 * {@link currentAmpsFor} for the same settings, and the reason an amp-based
 * `SetChargingProfile` limit is not violated by the MeterValues that report
 * it (#301).
 *
 * `ChargingScheduleResolver` turns a `ChargingRateUnit=A` period limit into
 * the watt cap the meter accumulates against, and `MeterValueBuilder` turns
 * that wattage back into the reported `Current.Import`. When the two halves
 * do not share an electrical model the round trip is lossy: a 3-phase 10 A
 * profile on a `powerFactor: 0.5` connector used to resolve to
 * `10 × 230 × 3 = 6900 W` and then report `6900 / (230 × 3 × 0.5) = 20 A`,
 * twice the limit the CSMS set. Routing the A → W half through this function
 * makes the trip exact.
 *
 * `limitPhases` is the profile period's `numberPhases` (OCPP 1.6 §7.21). The
 * conversion uses `min(connector phases, limitPhases)`: a CSMS restricting a
 * 3-phase connector to one phase must lower the cap, and a profile naming
 * more phases than the connector is wired for cannot raise it. Because
 * {@link currentAmpsFor} always divides by the connector's own phase count,
 * that `min` is what guarantees the reported current stays at or below the
 * limit in both mismatch directions. DC ignores `limitPhases` entirely —
 * there are no phases to restrict.
 */
export function powerWattsForCurrent(
  amps: number,
  settings: ElectricalSettings,
  limitPhases?: number,
): number {
  if (amps <= 0) return 0;
  const voltage = effectiveVoltageV(settings);
  if (settings.currentType === "DC") return amps * voltage;
  const connectorPhases = acPhases(settings);
  // Any non-negative integer, not just 1 or 3: OCPP allows `numberPhases: 2`,
  // and the no-model path below this one has always honoured whatever the
  // profile named (`numberPhases ?? 3`). Restricting to {1, 3} here would
  // make the two halves of the same conversion disagree for a legal profile,
  // and would contradict the `min(connector phases, limitPhases)` rule stated
  // above. Anything else -- absent, fractional, negative, smuggled past the
  // types by raw RPC -- falls back to the connector's own count.
  const phases =
    typeof limitPhases === "number" &&
    Number.isInteger(limitPhases) &&
    limitPhases >= 0
      ? Math.min(limitPhases, connectorPhases)
      : connectorPhases;
  return amps * voltage * phases * effectivePowerFactor(settings);
}

/** AC phase count for the derivations above. `phases` is `1 | 3`; anything
 *  else (absent, or a value smuggled past the types by raw RPC) is 1. */
function acPhases(settings: Pick<EVSettings, "phases">): number {
  return settings.phases === 3 ? 3 : 1;
}

/**
 * The electrical model a connector actually declares, or `undefined` when it
 * declares none.
 *
 * `defaultEVSettings` leaves all four fields absent, so "no model" is the
 * state of every connector that predates #301 and of every scenario that does
 * not mention them. Callers that would otherwise change behaviour for those
 * connectors — {@link powerWattsForCurrent} implies single-phase where OCPP
 * §7.21 defaults `numberPhases` to 3 — use this to tell "the operator
 * configured single-phase" apart from "the operator configured nothing", and
 * keep the pre-#301 conversion for the latter.
 */
export function electricalModelOf(
  settings: EVSettings | undefined,
): ElectricalSettings | undefined {
  if (!settings) return undefined;
  const { currentType, phases, voltageV, powerFactor } = settings;
  if (
    currentType === undefined &&
    phases === undefined &&
    voltageV === undefined &&
    powerFactor === undefined
  ) {
    return undefined;
  }
  return { currentType, phases, voltageV, powerFactor };
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
