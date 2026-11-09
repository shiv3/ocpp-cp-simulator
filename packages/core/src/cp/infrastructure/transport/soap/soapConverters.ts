/**
 * Pure conversions of the SOAP client: parsed response values to OCPP
 * fields, and domain meter samples to their 1.5 / 1.6 SOAP wire shape.
 */
import type { SampledValue } from "../../../domain/connector/MeterValueBuilder";
import type { SoapParsedValue, SoapPayload } from "./soapEnvelope";
import type {
  IdTagInfo,
  IdTagInfoStatus,
  Ocpp15Location,
  Ocpp15Measurand,
  Ocpp15MeterSample,
  Ocpp15ReadingContext,
  Ocpp15UnitOfMeasure,
  Ocpp16SampledValue,
} from "./soapWireTypes";

export function textValue(
  value: SoapParsedValue | undefined,
): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export function numericValue(
  value: SoapParsedValue | undefined,
): number | undefined {
  const text = textValue(value);
  if (text === undefined || text.trim() === "") return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function recordValue(
  value: SoapParsedValue | undefined,
): Record<string, SoapParsedValue> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return undefined;
}

export function idTagInfoFromPayload(
  value: SoapParsedValue | undefined,
): IdTagInfo {
  const record = recordValue(value);
  const rawStatus = textValue(record?.status);
  const status: IdTagInfoStatus =
    rawStatus === "Accepted" ||
    rawStatus === "Blocked" ||
    rawStatus === "Expired" ||
    rawStatus === "Invalid" ||
    rawStatus === "ConcurrentTx"
      ? rawStatus
      : "Invalid";
  return {
    status,
    ...(textValue(record?.expiryDate)
      ? { expiryDate: textValue(record?.expiryDate) }
      : {}),
    ...(textValue(record?.parentIdTag)
      ? { parentIdTag: textValue(record?.parentIdTag) }
      : {}),
  };
}

export function soapPayload(payload: object): SoapPayload {
  return payload as unknown as SoapPayload;
}

function toOcpp15ReadingContext(
  context: string | undefined,
): Ocpp15ReadingContext | undefined {
  switch (context) {
    case "Interruption.Begin":
    case "Interruption.End":
    case "Sample.Clock":
    case "Sample.Periodic":
    case "Transaction.Begin":
    case "Transaction.End":
      return context;
    case "Trigger":
    case "Other":
    default:
      return undefined;
  }
}

function toOcpp15Measurand(
  measurand: string | undefined,
): Ocpp15Measurand | null | undefined {
  switch (measurand) {
    case undefined:
      return undefined;
    case "Energy.Active.Export.Register":
    case "Energy.Active.Import.Register":
    case "Energy.Reactive.Export.Register":
    case "Energy.Reactive.Import.Register":
    case "Energy.Active.Export.Interval":
    case "Energy.Active.Import.Interval":
    case "Energy.Reactive.Export.Interval":
    case "Energy.Reactive.Import.Interval":
    case "Power.Active.Export":
    case "Power.Active.Import":
    case "Power.Reactive.Export":
    case "Power.Reactive.Import":
    case "Current.Export":
    case "Current.Import":
    case "Voltage":
    case "Temperature":
      return measurand;
    default:
      // OCPP 1.5 has no Power.Offered, Current.Offered, Power.Factor, SoC,
      // Frequency, RPM, phase-aware, or custom measurand equivalent; drop the
      // sample instead of mislabeling it.
      //
      // The two Offered measurands used to be aliased onto
      // Power.Active.Import / Current.Import, which was harmless only while
      // Offered and Import always carried the same number. #301 makes them
      // differ (Offered is the EVSE's offer, Import is what the curve says
      // the battery accepts), so a connector sampling both would have put two
      // identically labelled samples with contradictory values into one
      // MeterValue. Dropping the unsupported sample is the lesser loss: a 1.5
      // CSMS sees fewer measurands, never two answers to the same question.
      return null;
  }
}

function toOcpp15UnitOfMeasure(
  unit: string | undefined,
): Ocpp15UnitOfMeasure | undefined {
  switch (unit) {
    case "Wh":
    case "kWh":
    case "varh":
    case "kvarh":
    case "W":
    case "kW":
    case "var":
    case "kvar":
    case "Celsius":
      return unit;
    case "A":
      return "Amp";
    case "V":
      return "Volt";
    case "Celcius":
      return "Celsius";
    default:
      return undefined;
  }
}

function toOcpp15Location(
  location: string | undefined,
): Ocpp15Location | undefined {
  switch (location) {
    case "Inlet":
    case "Outlet":
    case "Body":
      return location;
    default:
      return undefined;
  }
}

export function toOcpp15MeterSample(
  sample: SampledValue,
): Ocpp15MeterSample | null {
  // OCPP 1.5's SampledValue has no phase attribute (no Errata-3-era additions
  // like 1.6/2.0.1 have). Emitting the L1/L2/L3 samples anyway would produce
  // duplicates indistinguishable from the aggregate — same measurand,
  // context, unit and value shape, just missing the one field that told them
  // apart — so drop the per-phase extras rather than confuse a CSMS with
  // four identical-looking Current.Import/Power.Active.Import samples
  // (#301). The aggregate sample (no `phase`) still goes through.
  if (sample.phase) return null;
  const measurand = toOcpp15Measurand(sample.measurand);
  if (measurand === null) return null;
  const context = toOcpp15ReadingContext(sample.context);
  const location = toOcpp15Location(sample.location);
  const unit = toOcpp15UnitOfMeasure(sample.unit);

  return {
    "#text": sample.value,
    ...(context ? { "@_context": context } : {}),
    ...(sample.format ? { "@_format": sample.format } : {}),
    ...(measurand ? { "@_measurand": measurand } : {}),
    ...(location ? { "@_location": location } : {}),
    ...(unit ? { "@_unit": unit } : {}),
  };
}

export function toOcpp16SampledValue(sample: SampledValue): Ocpp16SampledValue {
  // 1.6 SOAP: SampledValue is a complex type with child elements, all optional except value.
  // Passthrough all fields without mapping or dropping.
  return {
    value: sample.value,
    ...(sample.context ? { context: sample.context } : {}),
    ...(sample.format ? { format: sample.format } : {}),
    ...(sample.measurand ? { measurand: sample.measurand } : {}),
    ...(sample.phase ? { phase: sample.phase } : {}),
    ...(sample.location ? { location: sample.location } : {}),
    ...(sample.unit ? { unit: sample.unit } : {}),
  };
}
