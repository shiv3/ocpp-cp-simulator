import type { Connector } from "./Connector";
import type { ReadingContext, SampledValue } from "./MeterValueBuilder";
import {
  OCPP_1_2,
  OCPP_1_5,
  OCPP_1_6,
  OCPP_1_6_SOAP,
} from "../types/OcppVersion";

/**
 * Two opt-in ways a station's meter values depart from the clean default,
 * reproducing charge points in the field so a CSMS's parsing can be tested
 * (#1133, #1134). Both are off by default; the default wire is unchanged.
 */

/** The decimal separator of an OCPP 1.6 `SampledValue.value` (#1133). */
export type MeterValueDecimalSeparator = "." | ",";

/** The station options, as set on `cp.create` / the CLI. */
export interface MeterQuirkOptions {
  readonly meterValueDecimalSeparator?: MeterValueDecimalSeparator;
  readonly emptyMeterValues?: boolean;
}

/** The resolved quirks of one station, fixed at construction. */
export interface MeterQuirks {
  /** `","`: every numeric 1.6 `SampledValue.value` with a decimal comma. */
  readonly decimalSeparator: MeterValueDecimalSeparator;
  /** Periodic / clock-aligned samples of a transaction go out empty. */
  readonly emptyMeterValues: boolean;
}

/**
 * Why a station of `ocppVersion` cannot have `options`, or `null` when it
 * can. A comma is OCPP 1.6 only (JSON and SOAP), where `SampledValue.value`
 * is a string; on 2.x it is a JSON number, so a comma cannot be expressed
 * without breaking the schema. The SOAP 1.2 / 1.5 dialects implement neither
 * quirk.
 */
export function meterQuirksProblem(
  ocppVersion: string,
  options: MeterQuirkOptions,
): string | null {
  const v16 = ocppVersion === OCPP_1_6 || ocppVersion === OCPP_1_6_SOAP;
  if (options.meterValueDecimalSeparator === "," && !v16) {
    return `meterValueDecimalSeparator "," is supported on OCPP 1.6 only (${ocppVersion} is not): SampledValue.value is a string there and a number in OCPP 2.x`;
  }
  if (
    options.emptyMeterValues === true &&
    (ocppVersion === OCPP_1_2 || ocppVersion === OCPP_1_5)
  ) {
    return `emptyMeterValues is not supported on ${ocppVersion}: its MeterValues has no sampledValue list`;
  }
  return null;
}

/** The quirks of a station; throws on a combination {@link meterQuirksProblem} refuses. */
export function meterQuirksOf(
  ocppVersion: string,
  options: MeterQuirkOptions,
): MeterQuirks {
  const problem = meterQuirksProblem(ocppVersion, options);
  if (problem) throw new Error(problem);
  return {
    decimalSeparator: options.meterValueDecimalSeparator ?? ".",
    emptyMeterValues: options.emptyMeterValues ?? false,
  };
}

/**
 * The samples with the decimal point of every numeric `value` spelled as
 * `separator` (#1133): `"112.5"` becomes `"112,5"`. A signed reading
 * (`format: "SignedData"`) and a value that is not a plain decimal number (a
 * fixed override value, an empty one) are left alone. Anything but `","`
 * returns the samples unchanged, so the default wire stays byte-identical.
 */
export function withDecimalSeparator<
  T extends Pick<SampledValue, "value" | "format">,
>(samples: T[], separator: MeterValueDecimalSeparator | undefined): T[] {
  if (separator !== ",") return samples;
  return samples.map((sample) =>
    sample.format !== "SignedData" && /^-?\d+\.\d+$/.test(sample.value)
      ? { ...sample, value: sample.value.replace(".", separator) }
      : sample,
  );
}

/** Whether `context` is a sample {@link MeterQuirks.emptyMeterValues} empties. */
export function isEmptiedContext(context: ReadingContext | undefined): boolean {
  return context === "Sample.Periodic" || context === "Sample.Clock";
}

/**
 * Whether this sample goes out with an empty `sampledValue` list (#1134): the
 * station has the option, the sample is a periodic or clock-aligned one and
 * the connector runs a transaction. Trigger, begin / end and idle samples are
 * never emptied. Deliberately non-conformant (`minItems: 1`).
 */
export function emptiesSample(
  station: { readonly meterQuirks?: MeterQuirks },
  connector: Pick<Connector, "hasRunningTransaction"> | undefined,
  context: ReadingContext,
): boolean {
  return (
    station.meterQuirks?.emptyMeterValues === true &&
    connector?.hasRunningTransaction === true &&
    isEmptiedContext(context)
  );
}
