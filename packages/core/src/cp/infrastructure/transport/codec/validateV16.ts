import {
  actionValidatorV16,
  schemas,
  validationErrors,
} from "@ocpp-cp-simulator/ocpp/index";
import { strictValidationIssues } from "@ocpp-cp-simulator/ocpp/validate";
import { OCPPErrorCodeV16 } from "@ocpp-cp-simulator/ocpp/enums";
import { requestSchemaKey } from "./requestSchemaKey";
import { violationKind, type ViolationKind } from "./violationKind";

export interface V16ValidationResult {
  valid: boolean;
  errors: string[];
}

const V16_CODE_OF_KIND: Record<ViolationKind, OCPPErrorCodeV16> = {
  format: OCPPErrorCodeV16.FormationViolation,
  occurrence: OCPPErrorCodeV16.OccurenceConstraintViolation,
  type: OCPPErrorCodeV16.TypeConstraintViolation,
  property: OCPPErrorCodeV16.PropertyConstraintViolation,
};

const v16Schemas = schemas.v16 as Record<string, unknown>;

/** Validate an OCPP 1.6 CALL request payload against the bundled JSON schema. Never throws. */
export function validateV16Request(
  action: string,
  payload: unknown,
): V16ValidationResult {
  const validate = actionValidatorV16[action];
  if (!validate) {
    return {
      valid: false,
      errors: [`No v16 request validator for action "${action}"`],
    };
  }
  if (validate(payload)) {
    return { valid: true, errors: [] };
  }
  const schema = v16Schemas[requestSchemaKey(action, "V16")];
  const errors = schema
    ? validationErrors(
        schema as Parameters<typeof validationErrors>[0],
        payload,
      )
    : [`Invalid ${action} request payload`];
  return { valid: false, errors };
}

/** Returns a warning string if an outgoing v16 CALL request is schema-invalid, else null. */
export function outgoingV16Warning(
  action: string,
  payload: unknown,
): string | null {
  const result = validateV16Request(action, payload);
  if (result.valid) {
    return null;
  }
  return `Outgoing ${action} failed v16 schema validation: ${result.errors.join("; ")}`;
}

/** What an inbound 1.6J CALL is answered with when its payload is invalid. */
export interface InboundV16Violation {
  readonly errorCode: OCPPErrorCodeV16;
  readonly description: string;
}

/**
 * Check an inbound 1.6J CALL payload against the bundled request schema and
 * pick the OCPP-J 1.6 §4.2.3 error code for the first kind of violation, most
 * structural first:
 *
 * - `FormationViolation`: the payload is not an object, has a property the
 *   schema does not declare, or breaks the PDU structure in another way
 * - `OccurenceConstraintViolation` (the spelling of the 1.6 spec): a required
 *   field is missing, or an array has too few / many items
 * - `TypeConstraintViolation`: a field has the wrong JSON type
 * - `PropertyConstraintViolation`: a field has the right type and an invalid
 *   value (enum, range, length, pattern, format)
 *
 * Returns `null` when valid, and for an action without a request schema
 * (the handler lookup answers `NotImplemented` for those). Never throws.
 */
export function inboundV16Violation(
  action: string,
  payload: unknown,
): InboundV16Violation | null {
  const schema = v16Schemas[requestSchemaKey(action, "V16")];
  if (!schema) return null;
  let issues;
  try {
    issues = strictValidationIssues(schema as object, payload);
  } catch {
    return null;
  }
  if (issues.length === 0) return null;
  const description = `Invalid ${action} payload: ${issues
    .map((issue) => issue.message)
    .join("; ")}`.slice(0, 255);
  const errorCode = V16_CODE_OF_KIND[violationKind(issues)];
  return { errorCode, description };
}
