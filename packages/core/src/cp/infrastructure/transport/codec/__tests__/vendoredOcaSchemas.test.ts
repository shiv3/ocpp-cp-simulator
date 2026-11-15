import { describe, expect, it } from "vitest";

import { v16Schemas } from "@ocpp-cp-simulator/ocpp/v16/schemas";
import { v201Schemas } from "@ocpp-cp-simulator/ocpp/v201/schemas";
import { validationErrors } from "@ocpp-cp-simulator/ocpp/validate";

/**
 * #1064 — the vendored schemas are the OCA originals, not the patched copies
 * mobilityhouse/ocpp redistributes. These cases pin where the two differ, so
 * a refresh from a patched source shows up here rather than on the wire.
 *
 * It lives here rather than under `packages/ocpp/src/`, which the schema
 * generator rewrites.
 */
const meterValues = (sampledValue: object[]) => ({
  connectorId: 1,
  meterValue: [{ timestamp: "2026-01-01T00:00:00Z", sampledValue }],
});

describe("vendored OCA schemas (#1064)", () => {
  it("OCPP 1.6 MeterValues has no Hertz unit (1.6 has no UnitOfMeasure for frequency)", () => {
    const payload = meterValues([
      { value: "50", measurand: "Frequency", unit: "Hertz" },
    ]);
    expect(
      validationErrors(v16Schemas.meterValuesRequestV16, payload),
    ).not.toEqual([]);
  });

  it("OCPP 1.6 MeterValues accepts a Frequency sample without a unit", () => {
    const payload = meterValues([{ value: "50", measurand: "Frequency" }]);
    expect(validationErrors(v16Schemas.meterValuesRequestV16, payload)).toEqual(
      [],
    );
  });

  it("OCPP 1.6 StopTransaction spells the temperature unit Celcius only", () => {
    const stop = (unit: string) => ({
      meterStop: 0,
      timestamp: "2026-01-01T00:00:00Z",
      transactionId: 1,
      transactionData: [
        {
          timestamp: "2026-01-01T00:00:00Z",
          sampledValue: [{ value: "21", measurand: "Temperature", unit }],
        },
      ],
    });
    const schema = v16Schemas.stopTransactionRequestV16;
    expect(validationErrors(schema, stop("Celcius"))).toEqual([]);
    expect(validationErrors(schema, stop("Celsius"))).not.toEqual([]);
  });

  it("OCPP 2.0.1 Get15118EVCertificateResponse caps exiResponse at 5600", () => {
    const response = (length: number) => ({
      status: "Accepted",
      exiResponse: "A".repeat(length),
    });
    const schema = v201Schemas.get15118EVCertificateResponseV201;
    expect(validationErrors(schema, response(5600))).toEqual([]);
    expect(validationErrors(schema, response(5601))).not.toEqual([]);
  });
});
