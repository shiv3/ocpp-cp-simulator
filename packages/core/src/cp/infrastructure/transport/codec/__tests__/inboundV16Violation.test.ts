import { describe, expect, it } from "vitest";
import { inboundV16Violation } from "../validateV16";

/**
 * #593: the OCPP-J 1.6 §4.2.3 error code for each kind of schema violation.
 * The 1.6 spelling of the occurrence code is `OccurenceConstraintViolation`
 * (one `r`), and the format code is `FormationViolation`.
 */
const cases: Array<{
  name: string;
  action: string;
  payload: unknown;
  code: string | null;
}> = [
  { name: "valid", action: "Reset", payload: { type: "Soft" }, code: null },
  {
    name: "missing required field",
    action: "Reset",
    payload: {},
    code: "OccurenceConstraintViolation",
  },
  {
    name: "wrong type",
    action: "UnlockConnector",
    payload: { connectorId: "1" },
    code: "TypeConstraintViolation",
  },
  {
    name: "enum violation",
    action: "Reset",
    payload: { type: "Warm" },
    code: "PropertyConstraintViolation",
  },
  {
    name: "length violation",
    action: "RemoteStartTransaction",
    payload: { idTag: "X".repeat(21) },
    code: "PropertyConstraintViolation",
  },
  {
    name: "bad date-time format",
    action: "ReserveNow",
    payload: {
      connectorId: 1,
      expiryDate: "tomorrow",
      idTag: "A",
      reservationId: 1,
    },
    code: "PropertyConstraintViolation",
  },
  {
    name: "payload is not an object",
    action: "Reset",
    payload: [],
    code: "FormationViolation",
  },
  {
    name: "unknown property",
    action: "Reset",
    payload: { type: "Soft", extra: true },
    code: "FormationViolation",
  },
  {
    name: "structural beats value: unknown property and bad enum",
    action: "Reset",
    payload: { type: "Warm", extra: true },
    code: "FormationViolation",
  },
  {
    name: "missing beats type",
    action: "ReserveNow",
    payload: { connectorId: "1", idTag: "A", reservationId: 1 },
    code: "OccurenceConstraintViolation",
  },
  {
    name: "action without a schema is left to the handler lookup",
    action: "NoSuchAction",
    payload: {},
    code: null,
  },
];

describe("inboundV16Violation (#593)", () => {
  it.each(cases)("$name", ({ action, payload, code }) => {
    const violation = inboundV16Violation(action, payload);
    expect(violation?.errorCode ?? null).toBe(code);
    if (violation) {
      expect(violation.description.length).toBeLessThanOrEqual(255);
      expect(violation.description).toContain(action);
    }
  });

  it("never uses the 2.x spelling", () => {
    for (const { action, payload } of cases) {
      expect(inboundV16Violation(action, payload)?.errorCode).not.toBe(
        "FormatViolation",
      );
    }
  });
});
