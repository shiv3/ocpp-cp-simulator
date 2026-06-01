import type { Connector } from "./Connector";

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
const DEFAULT_VOLTAGE_V = 230;
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
  const currentA = powerW > 0 ? powerW / DEFAULT_VOLTAGE_V : 0;

  for (const measurand of measurands) {
    const sample = buildSingleSample(measurand, context, {
      meterWh,
      soc,
      powerW,
      currentA,
    });
    if (sample) samples.push(sample);
  }
  return samples;
}

interface MeasurandInputs {
  meterWh: number;
  soc: number | null;
  powerW: number;
  currentA: number;
}

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
        value: String(DEFAULT_VOLTAGE_V),
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
  const maxKw = connector.evSettings?.maxChargingPowerKw ?? 0;
  const evMaxW = maxKw > 0 ? maxKw * 1000 : Infinity;
  // The OCPP charging profile (if any) is the real ceiling — surface it on
  // Power.Active.Import so a CSMS that's verifying its SetChargingProfile
  // landed can read it back here.
  const scheduleW = connector.currentScheduleLimitWatts();
  const effective = Math.min(evMaxW, scheduleW);
  return Number.isFinite(effective)
    ? effective
    : evMaxW === Infinity
      ? 0
      : evMaxW;
}
