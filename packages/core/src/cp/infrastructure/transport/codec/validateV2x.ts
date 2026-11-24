import { schemas } from "@ocpp-cp-simulator/ocpp";
import { strictValidationIssues } from "@ocpp-cp-simulator/ocpp/validation";
import type { OCPPErrorCodeV201 } from "@ocpp-cp-simulator/ocpp";
import { OCPP_2_0_1, OCPP_2_1 } from "../../../domain/types/OcppVersion";
import { OCPP2X_RPC_DIALECT } from "@ocpp-cp-simulator/ocpp-rpc/index";
import { requestSchemaKey } from "./requestSchemaKey";
import { violationKind, type ViolationKind } from "./violationKind";

/** What an inbound 2.0.1 / 2.1 CALL is answered with when its payload is invalid. */
export interface InboundV2xViolation {
  readonly errorCode: OCPPErrorCodeV201;
  readonly description: string;
}

const CODE_OF_KIND: Readonly<Record<ViolationKind, OCPPErrorCodeV201>> =
  OCPP2X_RPC_DIALECT.violationCodes;

const v201Schemas = schemas.v201 as Record<string, unknown>;
const v21Schemas = schemas.v21 as Record<string, unknown>;

/**
 * Pick the OCPP-J 2.0.1 / 2.1 Part 4 §4.3 Table 8 error code for a payload the
 * request validator already refused: `OccurrenceConstraintViolation` for a
 * missing required property or a wrong array size, `TypeConstraintViolation`
 * for a wrong JSON type, `PropertyConstraintViolation` for an invalid value
 * (enum, range, length, pattern), `FormatViolation` for a payload that is not
 * an object or has an unknown property. Never throws; a payload the schema
 * cannot explain is a `FormatViolation`.
 *
 * The payload is classified against the schema of the station's own version
 * (#750): a 2.1-only action has no 2.0.1 schema, and a shared action's 2.1
 * schema can differ from the 2.0.1 one.
 */
export function inboundV2xViolation(
  action: string,
  payload: unknown,
  ocppVersion: string = OCPP_2_0_1,
): InboundV2xViolation {
  const schema =
    ocppVersion === OCPP_2_1
      ? v21Schemas[requestSchemaKey(action, "V21")]
      : v201Schemas[requestSchemaKey(action, "V201")];
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
