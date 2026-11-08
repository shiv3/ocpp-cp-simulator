import { schemas } from "@ocpp-cp-simulator/ocpp/index";
import { OCPP_2_1 } from "../../../domain/types/OcppVersion";

type MeterValuesSchema = {
  definitions?: { MeasurandEnumType?: { enum?: string[] } };
};

function enumOf(schema: unknown): ReadonlySet<string> {
  return new Set(
    (schema as MeterValuesSchema).definitions?.MeasurandEnumType?.enum ?? [],
  );
}

const MEASURANDS_V201 = enumOf(
  (schemas.v201 as Record<string, unknown>).meterValuesRequestV201,
);
const MEASURANDS_V21 = enumOf(
  (schemas.v21 as Record<string, unknown>).meterValuesRequestV21,
);

/**
 * The values of `MeasurandEnumType` of a 2.x station's version (Part 3 JSON
 * schemas). It has no `Temperature` or `RPM`: those are 1.6 measurands (#714).
 */
export function measurandEnumFor(ocppVersion: string): ReadonlySet<string> {
  return ocppVersion === OCPP_2_1 ? MEASURANDS_V21 : MEASURANDS_V201;
}

/** The members of `measurands` outside the station's `MeasurandEnumType`. */
export function unknownMeasurands(
  measurands: readonly string[],
  ocppVersion: string,
): string[] {
  const allowed = measurandEnumFor(ocppVersion);
  return measurands.filter((m) => !allowed.has(m));
}
