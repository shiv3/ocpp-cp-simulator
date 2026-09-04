import type { Connector } from "./Connector";
import {
  currentAmpsFor,
  effectiveChargingPowerW,
  effectiveVoltageV,
  effectivePowerFactor,
  resolveSocForCurve,
} from "./ChargingCurve";

/** Subset of ReadingContext values we actually use (§7.35). */
export type ReadingContext =
  | "Sample.Periodic"
  | "Sample.Clock"
  | "Transaction.Begin"
  | "Transaction.End"
  | "Trigger"
  | "Interruption.Begin"
  | "Interruption.End"
  | "Other";

/** SampledValue shape per OCPP 1.6 §7.43. */
export interface SampledValue {
  value: string;
  context?: ReadingContext;
  measurand?: string;
  unit?: string;
  phase?: string;
  location?: string;
  format?: "Raw" | "SignedData";
}

/**
 * Default electrical characteristics used when the connector domain doesn't
 * model the value directly. Real Charge Points read these off the meter
 * hardware; the simulator synthesizes plausible numbers so CSMS-side parsers
 * see well-formed MeterValues.req payloads.
 */
const DEFAULT_TEMPERATURE_C = 25;
const DEFAULT_FREQUENCY_HZ = 50;

/**
 * Build a SampledValue array for a MeterValue PDU based on the configured
 * measurand list (CSL form, e.g. `"Energy.Active.Import.Register,Voltage,
 * Current.Import,Power.Active.Import,SoC"`).
 *
 * Unknown measurands are emitted with an empty value rather than being
 * dropped — that matches §3.16.4's spirit (the CP rejects a
 * ChangeConfiguration that requests unsupported measurands, so by the time
 * we get here every measurand in the list is "supported", even if our
 * synthesized value is 0).
 */
export function buildSampledValues(
  connector: Connector,
  measurands: string[],
  context: ReadingContext,
): SampledValue[] {
  const samples: SampledValue[] = [];
  const meterWh = connector.meterValue;
  const soc = connector.soc;
  // Power.Active.Import — what the battery actually accepts right now,
  // curve included — and Power.Offered — what the EVSE/profile makes
  // available, independent of the battery's own acceptance (#301: a 100 kW
  // charger still *offers* 100 kW to a nearly-full battery that only draws
  // 10 kW of it).
  const powerW = derivedInstantaneousPowerW(connector);
  const offeredW = derivedOfferedPowerW(connector);
  const settings = connector.evSettings;
  const currentA = currentAmpsFor(powerW, settings ?? {});
  const offeredCurrentA = currentAmpsFor(offeredW, settings ?? {});
  // The voltage that actually produced `currentA`, not the raw configured
  // value: a `voltageV` of 0, negative or non-finite falls back to 230 in the
  // derivation, and reporting the raw number here would put a `Voltage` sample
  // on the wire that the `Current.Import` beside it contradicts (#301).
  const voltageV = effectiveVoltageV(settings ?? {});
  const powerFactor = effectivePowerFactor(settings ?? {});
  // The phases actually in use — the connector's wiring narrowed by the
  // active profile's `numberPhases`, the same count that produced the watt cap
  // (#301) — not the wiring alone.
  const phases = connector.activePhaseCount();

  for (const measurand of measurands) {
    const sample = buildSingleSample(measurand, context, {
      meterWh,
      soc,
      powerW,
      currentA,
      offeredW,
      offeredCurrentA,
      voltageV,
      powerFactor,
    });
    if (sample) samples.push(sample);
    // Per-phase samples, but only when all three phases are actually in use.
    // A profile restricting a 3-phase connector to fewer would otherwise have
    // the message claim consumption on phases the CSMS excluded — and OCPP's
    // `numberPhases` says how many phases, never which, so naming a subset of
    // L1/L2/L3 would invent an allocation the profile never expressed. The
    // aggregate sample alone is the honest answer there (#301).
    if (phases === 3 && PER_PHASE_MEASURANDS.has(measurand)) {
      for (const phase of ["L1", "L2", "L3"] as const) {
        const perPhase = buildSingleSample(measurand, context, {
          meterWh,
          soc,
          powerW: powerW / 3,
          currentA,
          offeredW: offeredW / 3,
          offeredCurrentA,
          voltageV,
          powerFactor,
        });
        if (perPhase) samples.push({ ...perPhase, phase });
      }
    }
  }
  return samples;
}

interface MeasurandInputs {
  meterWh: number;
  soc: number | null;
  powerW: number;
  currentA: number;
  /** What the EVSE/profile offers, independent of battery acceptance. */
  offeredW: number;
  offeredCurrentA: number;
  voltageV: number;
  powerFactor: number;
}

/**
 * Measurands a 3-phase connector also reports per phase.
 *
 * Only the ones where a per-phase value means something: an energy register is
 * a whole-meter total, so splitting it would invent three counters that do not
 * exist.
 */
const PER_PHASE_MEASURANDS = new Set(["Current.Import", "Power.Active.Import"]);

function buildSingleSample(
  measurand: string,
  context: ReadingContext,
  inputs: MeasurandInputs,
): SampledValue | null {
  switch (measurand) {
    case "Energy.Active.Import.Register":
      return {
        value: String(inputs.meterWh),
        context,
        measurand,
        unit: "Wh",
      };
    case "Voltage":
      return {
        value: String(inputs.voltageV),
        context,
        measurand,
        unit: "V",
      };
    case "Current.Import":
      return {
        value: inputs.currentA.toFixed(1),
        context,
        measurand,
        unit: "A",
      };
    case "Current.Offered":
      return {
        value: inputs.offeredCurrentA.toFixed(1),
        context,
        measurand,
        unit: "A",
      };
    case "Power.Active.Import":
      return {
        value: String(Math.round(inputs.powerW)),
        context,
        measurand,
        unit: "W",
      };
    case "Power.Offered":
      return {
        value: String(Math.round(inputs.offeredW)),
        context,
        measurand,
        unit: "W",
      };
    case "Power.Factor":
      // Reported verbatim, not rounded. `Current.Import` in this same sample
      // set is derived from `effectivePowerFactor`'s exact return value, so
      // rounding here would let one MeterValue name a cos φ that did not
      // produce its own current — `powerFactor: 0.004` used to report
      // `Power.Factor = 0.00` next to a current computed from 0.004, and
      // rounding the derivation to match instead would divide by zero (#301).
      return {
        value: String(inputs.powerFactor),
        context,
        measurand,
      };
    case "SoC":
      if (inputs.soc === null) return null;
      return {
        value: inputs.soc.toFixed(1),
        context,
        measurand,
        unit: "Percent",
      };
    case "Temperature":
      return {
        value: String(DEFAULT_TEMPERATURE_C),
        context,
        measurand,
        unit: "Celsius",
      };
    case "Frequency":
      // Errata 3.86: OCPP 1.6 has no UnitOfMeasure for Hz, so unit is
      // intentionally omitted.
      return {
        value: String(DEFAULT_FREQUENCY_HZ),
        context,
        measurand,
      };
    case "Energy.Active.Import.Interval":
    case "Energy.Reactive.Import.Register":
    case "Energy.Reactive.Import.Interval":
    case "Energy.Active.Export.Register":
    case "Energy.Active.Export.Interval":
    case "Energy.Reactive.Export.Register":
    case "Energy.Reactive.Export.Interval":
    case "Current.Export":
    case "Power.Active.Export":
    case "Power.Reactive.Import":
    case "Power.Reactive.Export":
    case "RPM":
      // We don't model these — return 0 so CSMS sees a well-formed sample.
      return { value: "0", context, measurand };
    default:
      // Spec-unknown measurand. Emit a Raw zero so the request stays valid.
      return { value: "0", context, measurand };
  }
}

/**
 * Best-effort instantaneous power estimate based on whatever rate the
 * scheduler is currently driving. We don't expose the scheduler's tick
 * delta, so we fall back to the EV-settings max charging power when
 * charging, or 0 when not. Good enough for CSMS-side parser testing.
 *
 * This is what the battery actually *accepts* — the charging curve lowers
 * demand here (#301) — and it is also the same effective power
 * {@link Connector}'s meter scheduler accumulates the energy register
 * against, via `effectiveChargingPowerW` (see `Connector.ts`). A billing
 * MeterValue built from this module and the register it reads therefore
 * always agree with each other.
 */
function derivedInstantaneousPowerW(connector: Connector): number {
  // `OCPPStatus.Charging` import is avoided here to keep this module free
  // of cycles; check via the public string value.
  if (connector.status !== "Charging") return 0;
  const settings = connector.evSettings;
  const maxKw = settings?.maxChargingPowerKw ?? 0;
  const evMaxW = maxKw > 0 ? maxKw * 1000 : Infinity;
  return effectiveChargingPowerW({
    evMaxW,
    curve: settings?.chargingCurve,
    socPercent: resolveSocForCurve(
      connector.soc,
      connector.transaction?.initialSoc,
      settings?.initialSoc,
    ),
    scheduleLimitWatts: connector.currentScheduleLimitWatts(),
  });
}

/**
 * What the EVSE offers right now — `Power.Offered` / `Current.Offered` — as
 * distinct from what the battery accepts (#301). The charging curve
 * describes battery acceptance, not EVSE capability: a 100 kW charger still
 * *offers* 100 kW to a nearly-full battery even though the battery only
 * draws a fraction of it, so the curve is deliberately not passed here.
 * Still capped by the active charging profile — that cap is the EVSE's own
 * limit, set by the CSMS, not a battery-acceptance concern.
 */
function derivedOfferedPowerW(connector: Connector): number {
  if (connector.status !== "Charging") return 0;
  const settings = connector.evSettings;
  const maxKw = settings?.maxChargingPowerKw ?? 0;
  const evMaxW = maxKw > 0 ? maxKw * 1000 : Infinity;
  return effectiveChargingPowerW({
    evMaxW,
    curve: undefined,
    socPercent: connector.soc,
    scheduleLimitWatts: connector.currentScheduleLimitWatts(),
  });
}
