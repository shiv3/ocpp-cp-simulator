import type { Connector } from "./Connector";
import { convertUnit, type SampledValueOverride } from "./MeterRealism";
import type { OperatingPoint } from "./OperatingPoint";

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

/** What a caller can impose on one MeterValues sample instead of the
 *  defaults (`MeterValuesSampledData`, "now"). Clock-aligned samples carry
 *  `MeterValuesAlignedData` and the boundary instant (#454). */
export interface MeterSampleOverrides {
  measurands?: string[];
  timestamp?: Date;
  /** An operating point captured earlier, formatted instead of resolving
   *  anew: a `Transaction.End` sample describes the last charging instant,
   *  not a connector that has already left `Charging` (#607, #327). */
  point?: OperatingPoint;
}

/** SampledValue shape per OCPP 1.6 §7.43. */
export interface SampledValue {
  value: string;
  context?: ReadingContext;
  measurand?: string;
  unit?: string;
  phase?: string;
  location?: string;
  format?: "Raw" | "SignedData";
  /** Power of ten of `value` (2.0.1 `unitOfMeasure.multiplier`, #616). Only
   *  set when the caller asked for it with `unitMultiplier`; 1.6 has none. */
  multiplier?: number;
}

/** How the caller's protocol dialect shapes the samples (#616). */
export interface SampleBuildOptions {
  /** The dialect carries `unitOfMeasure.multiplier` (OCPP 2.x). Without it a
   *  configured multiplier is ignored, never half-applied. */
  unitMultiplier?: boolean;
}

/**
 * Spell the samples for an OCPP-J 1.6 wire message. OCPP-J 1.6 errata (2025-04)
 * §2.1: the original JSON schemas spell the Temperature unit `Celcius`, a
 * Central System validating against them rejects `Celsius`, so Charge Point
 * implementers are "advised to remain using the not corrected version of the
 * spelling Celcius". OCPP-S 1.6 (WSDL) and 2.x keep `Celsius`; they do not call
 * this.
 */
export function toOcppJ16Wire(samples: SampledValue[]): SampledValue[] {
  return samples.map((sample) =>
    sample.unit === "Celsius" ? { ...sample, unit: "Celcius" } : sample,
  );
}

/**
 * The unit OCPP 2.0.1 / 2.1 Part 2 Appendices ch. 2 (Standardized Units of
 * Measure) assigns to a measurand, or `undefined` for a unitless one
 * (`Power.Factor`) and one this table does not know.
 *
 * The builder leaves `Frequency` (1.6 errata 3.86: 1.6 has no Hz) and the
 * measurands it does not model without a unit, which is right for 1.6 but on
 * 2.x the Appendix says the default of `unit` is always `Wh`: a 50 Hz sample
 * without `unitOfMeasure` reads as 50 Wh (#713). The 2.x message handler fills
 * the gap from here; 1.6 never calls this.
 */
export function unitOfMeasurandV2x(measurand: string): string | undefined {
  if (measurand === "Power.Factor") return undefined;
  switch (measurand) {
    case "Frequency":
      return "Hz";
    case "Voltage":
      return "V";
    case "SoC":
      return "Percent";
    case "RPM":
      return "RPM";
    case "Temperature":
      return "Celsius";
  }
  // Quantity families, by the prefix the enum names them with.
  if (measurand.startsWith("Current.")) return "A";
  if (measurand.startsWith("Energy.Active.")) return "Wh";
  if (measurand.startsWith("Energy.Reactive.")) return "varh";
  if (measurand.startsWith("Energy.Apparent.")) return "VAh";
  if (measurand.startsWith("Power.Active.")) return "W";
  if (measurand.startsWith("Power.Reactive.")) return "var";
  if (measurand.startsWith("Power.Offered")) return "W";
  // 2.1-only measurands (Appendix ch. 2 / MeasurandEnumType, #766).
  if (measurand.startsWith("Voltage.")) return "V";
  if (measurand.startsWith("Power.Import.")) return "W";
  if (measurand.startsWith("Power.Export.")) return "W";
  if (measurand.startsWith("Display.RemainingTime")) return "s";
  if (/^Display\..*SOC$/.test(measurand)) return "Percent";
  if (measurand.startsWith("EnergyRequest.")) return "Wh";
  if (measurand === "Display.BatteryEnergyCapacity") return "Wh";
  return undefined;
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
  options: SampleBuildOptions = {},
  capturedPoint?: OperatingPoint,
): SampledValue[] {
  const samples: SampledValue[] = [];
  const meterWh = connector.meterValue;
  const realism = connector.meterRealism;
  // The Interval and Export measurands carry real values only on a connector
  // with meter realism (#615); otherwise they stay the historical zero.
  const real = realism !== undefined;
  const interval =
    real && measurands.some((m) => m.endsWith(".Interval"))
      ? connector.takeIntervalEnergyWh()
      : { importWh: 0, exportWh: 0 };
  // Formatting only: every physical quantity below comes from one operating
  // point resolved at one instant (#327), so the samples of a MeterValue
  // describe one instant and the energy register reads the same record. The
  // read is pure: the code that sends the sample set announces a schedule
  // crossing first (`Connector.announceScheduleCrossingNow`).
  const point = capturedPoint ?? connector.operatingPoint();
  const {
    soc,
    acceptedW: powerW,
    offeredW,
    currentA,
    offeredCurrentA,
    limitA,
    voltageV,
    powerFactor,
    boundW,
    activePhases: phases,
    phaseDetail,
  } = point;

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
      limitW: boundW,
      limitA,
      real,
      exportWh: real ? connector.exportRegisterWh : 0,
      exportW: point.exportW,
      exportCurrentA: point.exportCurrentA,
      intervalImportWh: interval.importWh,
      intervalExportWh: interval.exportWh,
    });
    if (sample) samples.push(sample);
    if (phaseDetail && measurand === "Voltage") {
      const names = ["L1-N", "L2-N", "L3-N"];
      phaseDetail.voltageV.forEach((v, i) =>
        samples.push({ ...voltageSample(v, context), phase: names[i] }),
      );
      if (phaseDetail.lineToLine) {
        const ll = ["L1-L2", "L2-L3", "L3-L1"];
        phaseDetail.lineToLineV.forEach((v, i) =>
          samples.push({ ...voltageSample(v, context), phase: ll[i] }),
        );
      }
    }
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
          // A leg carries a third of the whole-connector power, so the bound
          // that applies to it is a third of the whole-connector bound (the
          // schedule limit narrowed by the charger cap). The
          // current legs each carry the aggregate line current, so their bound
          // is unchanged.
          limitW: boundW / 3,
          limitA,
          real,
          exportWh: 0,
          exportW: 0,
          exportCurrentA: 0,
          intervalImportWh: 0,
          intervalExportWh: 0,
        });
        if (perPhase && phaseDetail) {
          // Independent phases (#615): each leg reads its own quantities.
          const i = ["L1", "L2", "L3"].indexOf(phase);
          if (measurand === "Current.Import") {
            perPhase.value = formatBounded(phaseDetail.currentA[i], limitA, 1);
          } else if (measurand === "Power.Active.Import") {
            perPhase.value = formatBounded(phaseDetail.powerW[i], Infinity, 0);
          }
        }
        if (perPhase) samples.push({ ...perPhase, phase });
      }
    }
  }
  const rules = realism?.sampledValues;
  return rules && rules.length > 0
    ? applySampledValueOverrides(samples, rules, options)
    : samples;
}

function voltageSample(volts: number, context: ReadingContext): SampledValue {
  return {
    value: String(Math.round(volts * 10) / 10),
    context,
    measurand: "Voltage",
    unit: "V",
  };
}

/**
 * Reshape the built samples with a connector's overrides (#616). A rule
 * matches by measurand (and phase when it names one) and changes the unit
 * (converting inside a family), location, context, phase or value of what it
 * matches; the first matching rule wins. Pure: the input is not changed.
 *
 * The unit names are those of OCPP 1.6 §7.45 UnitOfMeasure and 2.0.1
 * UnitOfMeasureType; a `multiplier` (a power of ten, 2.0.1 only) divides the
 * reported value so that `value × 10^multiplier` is the actual one.
 */
export function applySampledValueOverrides(
  samples: readonly SampledValue[],
  rules: readonly SampledValueOverride[],
  options: SampleBuildOptions = {},
): SampledValue[] {
  const out: SampledValue[] = [];
  for (const sample of samples) {
    const rule = rules.find(
      (r) =>
        r.measurand === sample.measurand &&
        (r.phase === undefined || r.phase === sample.phase),
    );
    if (!rule) {
      out.push(sample);
      continue;
    }
    const { set } = rule;
    if (set.omit) continue;
    const next: SampledValue = { ...sample };
    if (set.value !== undefined) {
      next.value = set.value;
    } else {
      let numeric = Number(sample.value);
      if (Number.isFinite(numeric)) {
        if (set.unit !== undefined && sample.unit !== undefined) {
          const converted = convertUnit(numeric, sample.unit, set.unit);
          if (converted !== null) {
            numeric = converted;
            next.value = trimNumber(numeric, set.decimals ?? 3);
          }
        }
        if (options.unitMultiplier && set.multiplier !== undefined) {
          numeric = numeric / 10 ** set.multiplier;
          next.value = trimNumber(numeric, set.decimals ?? 3);
        } else if (set.decimals !== undefined) {
          next.value = trimNumber(numeric, set.decimals);
        }
      }
    }
    if (set.unit !== undefined) next.unit = set.unit;
    if (options.unitMultiplier && set.multiplier !== undefined) {
      next.multiplier = set.multiplier;
    }
    if (set.location !== undefined) next.location = set.location;
    if (set.context !== undefined) next.context = set.context as ReadingContext;
    if (set.phase !== undefined) next.phase = set.phase;
    out.push(next);
  }
  return out;
}

/** `value` to at most `decimals` decimals, without trailing zeros. */
function trimNumber(value: number, decimals: number): string {
  return String(Number(value.toFixed(decimals)));
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
  /** Active charging-profile cap in watts, `Infinity` when uncapped. */
  limitW: number;
  /** The same cap in amperes, `Infinity` when uncapped. */
  limitA: number;
  /** The connector has meter realism: Interval and Export measurands carry
   *  real values (#615). */
  real: boolean;
  exportWh: number;
  exportW: number;
  exportCurrentA: number;
  intervalImportWh: number;
  intervalExportWh: number;
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
        // A fluctuated voltage is a long float: one decimal, as a meter reads.
        value: inputs.real
          ? String(Math.round(inputs.voltageV * 10) / 10)
          : String(inputs.voltageV),
        context,
        measurand,
        unit: "V",
      };
    case "Current.Import":
      return {
        value: formatBounded(inputs.currentA, inputs.limitA, 1),
        context,
        measurand,
        unit: "A",
      };
    case "Current.Offered":
      return {
        value: formatBounded(inputs.offeredCurrentA, inputs.limitA, 1),
        context,
        measurand,
        unit: "A",
      };
    case "Power.Active.Import":
      return {
        value: formatBounded(inputs.powerW, inputs.limitW, 0),
        context,
        measurand,
        unit: "W",
      };
    case "Power.Offered":
      return {
        value: formatBounded(inputs.offeredW, inputs.limitW, 0),
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
        value: formatPowerFactor(inputs.powerFactor),
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
      if (!inputs.real) return { value: "0", context, measurand };
      return {
        value: String(inputs.intervalImportWh),
        context,
        measurand,
        unit: "Wh",
      };
    case "Energy.Active.Export.Register":
      if (!inputs.real) return { value: "0", context, measurand };
      return {
        value: String(inputs.exportWh),
        context,
        measurand,
        unit: "Wh",
      };
    case "Energy.Active.Export.Interval":
      if (!inputs.real) return { value: "0", context, measurand };
      return {
        value: String(inputs.intervalExportWh),
        context,
        measurand,
        unit: "Wh",
      };
    case "Power.Active.Export":
      if (!inputs.real) return { value: "0", context, measurand };
      return {
        value: formatBounded(inputs.exportW, Infinity, 0),
        context,
        measurand,
        unit: "W",
      };
    case "Current.Export":
      if (!inputs.real) return { value: "0", context, measurand };
      return {
        value: formatBounded(inputs.exportCurrentA, Infinity, 1),
        context,
        measurand,
        unit: "A",
      };
    case "Energy.Reactive.Import.Register":
    case "Energy.Reactive.Import.Interval":
    case "Energy.Reactive.Export.Register":
    case "Energy.Reactive.Export.Interval":
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
 * Print a sample that an active charging profile can bound, without letting
 * the rounding carry it above that bound.
 *
 * `Current.Import` is reported to one decimal and `Power.Active.Import` to a
 * whole watt, and rounding to nearest can round *up*: a binding 16.06 A limit
 * derives 16.06 A correctly and then sends `"16.1"`, so the station reports
 * more than the CSMS allowed. That falsifies the guarantee stated one module
 * away — that a binding amp limit comes back as exactly that amperage, never
 * above it (#301).
 *
 * Rounding down is applied **only when rounding to nearest would cross the
 * limit**, not as a blanket change of rounding mode. Flooring every sample
 * would move `22000 / 230 = 95.652…` from `"95.7"` to `"95.6"` and break the
 * byte-identity every pre-v1.2 scenario relies on; the two guarantees are
 * compatible precisely because this only bites where the limit binds and the
 * printed value would otherwise exceed it. "Never above" is the half that has
 * to hold: a limit is a ceiling, so under-reporting by less than one printed
 * digit is a rounding artefact, while over-reporting is a profile violation.
 *
 * `limit` is `Infinity` when no profile is active, which makes this exactly
 * `toFixed`.
 */
function formatBounded(value: number, limit: number, decimals: number): string {
  const rounded = value.toFixed(decimals);
  if (!Number.isFinite(limit) || Number(rounded) <= limit) return rounded;
  const scale = 10 ** decimals;
  return (Math.floor(Math.min(value, limit) * scale) / scale).toFixed(decimals);
}

/**
 * `Power.Factor`'s string form: unity as `"1.0"`, anything else verbatim.
 *
 * Before v1.2 this sample was the literal `"1.0"` for every connector, and
 * this PR promises a scenario with no electrical fields produces byte-identical
 * MeterValues. `effectivePowerFactor` returns the number `1` for all of those
 * connectors — no `powerFactor` configured, or DC, or a value outside
 * `(0, 1]` — so stringifying it moved the wire bytes from `"1.0"` to `"1"`.
 * The two parse to the same number, but a raw-payload or snapshot consumer
 * compares text (#301).
 *
 * Exact configured values are still reported exactly, which is what stopping
 * the old `toFixed(2)` was for: `0.004` stays `"0.004"`, and never becomes a
 * cos φ that did not produce the `Current.Import` beside it.
 */
function formatPowerFactor(value: number): string {
  return value === 1 ? "1.0" : String(value);
}

/**
 * #538: the instantaneous active power, in whole watts, exactly as a
 * `Power.Active.Import` sample would report it now, but without announcing
 * a schedule crossing (see `Connector.operatingPoint`).
 */
export function reportedActivePowerW(connector: Connector): number {
  // Not charging draws nothing: skip resolving the schedule.
  if (connector.status !== "Charging") return 0;
  const point = connector.operatingPoint();
  return Number(formatBounded(point.acceptedW, point.boundW, 0));
}
