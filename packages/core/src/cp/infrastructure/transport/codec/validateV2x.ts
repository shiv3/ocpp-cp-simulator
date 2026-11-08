import { schemas } from "@ocpp-cp-sim/ocpp/index";
import { strictValidationIssues } from "@ocpp-cp-sim/ocpp/validate";
import { OCPPErrorCodeV201 } from "@ocpp-cp-sim/ocpp/enums";
import { requestSchemaKey } from "./requestSchemaKey";
import { violationKind, type ViolationKind } from "./violationKind";

/** What an inbound 2.0.1 / 2.1 CALL is answered with when its payload is invalid. */
export interface InboundV2xViolation {
  readonly errorCode: OCPPErrorCodeV201;
  readonly description: string;
}

const CODE_OF_KIND: Record<ViolationKind, OCPPErrorCodeV201> = {
  format: OCPPErrorCodeV201.FormatViolation,
  occurrence: OCPPErrorCodeV201.OccurrenceConstraintViolation,
  type: OCPPErrorCodeV201.TypeConstraintViolation,
  property: OCPPErrorCodeV201.PropertyConstraintViolation,
};

const v201Schemas = schemas.v201 as Record<string, unknown>;

/**
 * Pick the OCPP-J 2.0.1 / 2.1 Part 4 §4.3 Table 8 error code for a payload the
 * request validator already refused: `OccurrenceConstraintViolation` for a
 * missing required property or a wrong array size, `TypeConstraintViolation`
 * for a wrong JSON type, `PropertyConstraintViolation` for an invalid value
 * (enum, range, length, pattern), `FormatViolation` for a payload that is not
 * an object or has an unknown property. Never throws; a payload the schema
 * cannot explain is a `FormatViolation`.
 */
export function inboundV2xViolation(
  action: string,
  payload: unknown,
): InboundV2xViolation {
  const schema = v201Schemas[requestSchemaKey(action, "V201")];
  let issues: ReturnType<typeof strictValidationIssues> = [];
  if (schema) {
    try {
      issues = strictValidationIssues(schema as object, payload);
    } catch {
      issues = [];
    }
  }
  const detail = issues.map((issue) => issue.message).join("; ");
  return {
    errorCode: CODE_OF_KIND[violationKind(issues)],
    // OCPP-J 2.0.1 / 2.1 Part 4 §4.2.3: ErrorDescription is string[255].
    description: (detail
      ? `Invalid ${action} payload: ${detail}`
      : `Invalid ${action} payload`
    ).slice(0, 255),
  };
}
