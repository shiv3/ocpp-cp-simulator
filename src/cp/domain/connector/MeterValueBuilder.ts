import type { Connector } from "./Connector";
import {
  currentAmpsFor,
  DEFAULT_VOLTAGE_V,
  powerFractionAtSoc,
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
  // Power.Active.Import — derived from auto-meter increment if active,
  // else 0. We don't have a true instantaneous-power model so use the
  // most recently observed configuration where possible.
  const powerW = derivedInstantaneousPowerW(connector);
  const settings = connector.evSettings;
  const currentA = currentAmpsFor(powerW, settings ?? {});
  const voltageV = settings?.voltageV ?? DEFAULT_VOLTAGE_V;
  const phases = settings?.currentType === "DC" ? 1 : (settings?.phases ?? 1);

  for (const measurand of measurands) {
    const sample = buildSingleSample(measurand, context, {
      meterWh,
      soc,
      powerW,
      currentA,
      voltageV,
    });
    if (sample) samples.push(sample);
    // Per-phase current on a 3-phase AC connector: the aggregate above is the
    // total, and these are what a CSMS reading L1/L2/L3 expects to sum to it.
    if (phases === 3 && PER_PHASE_MEASURANDS.has(measurand)) {
      for (const phase of ["L1", "L2", "L3"] as const) {
        const perPhase = buildSingleSample(measurand, context, {
          meterWh,
          soc,
          powerW: powerW / 3,
          currentA,
          voltageV,
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
  voltageV: number;
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
        value: inputs.currentA.toFixed(1),
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
        value: String(Math.round(inputs.powerW)),
        context,
        measurand,
        unit: "W",
      };
    case "Power.Factor":
      return { value: "1.0", context, measurand };
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
 */
function derivedInstantaneousPowerW(connector: Connector): number {
  // `OCPPStatus.Charging` import is avoided here to keep this module free
  // of cycles; check via the public string value.
  if (connector.status !== "Charging") return 0;
  const settings = connector.evSettings;
  const maxKw = settings?.maxChargingPowerKw ?? 0;
  const evMaxW = maxKw > 0 ? maxKw * 1000 : Infinity;

  // The charging curve lowers demand; it never raises it (#301). A battery
  // near full accepts less than the connector could deliver, so the curve
  // scales the EV's own ceiling before the profile is considered.
  const curve = settings?.chargingCurve;
  const acceptedW =
    curve && curve.length > 0 && Number.isFinite(evMaxW)
      ? evMaxW * powerFractionAtSoc(curve, connector.soc ?? 0)
      : evMaxW;

  // The OCPP charging profile (if any) is the real ceiling — surface it on
  // Power.Active.Import so a CSMS that's verifying its SetChargingProfile
  // landed can read it back here. `min(curve, profile)`: the profile always
  // wins, so a curve can never let a session draw above an active limit.
  const scheduleW = connector.currentScheduleLimitWatts();
  const effective = Math.min(acceptedW, scheduleW);
  return Number.isFinite(effective)
    ? effective
    : acceptedW === Infinity
      ? 0
      : acceptedW;
}
