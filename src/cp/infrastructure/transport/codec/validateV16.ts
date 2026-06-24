import { actionValidatorV16, schemas, validationErrors } from "@cshil/ocpp-tools";

export interface V16ValidationResult {
  valid: boolean;
  errors: string[];
}

// `schemas.v16` keys are camelCase, e.g. "BootNotification" -> "bootNotificationRequestV16".
function requestSchemaKey(action: string): string {
  return `${action.charAt(0).toLowerCase()}${action.slice(1)}RequestV16`;
}

const v16Schemas = schemas.v16 as Record<string, unknown>;

/** Validate an OCPP 1.6 CALL request payload against the bundled JSON schema. Never throws. */
export function validateV16Request(action: string, payload: unknown): V16ValidationResult {
  const validate = actionValidatorV16[action];
  if (!validate) {
    return { valid: false, errors: [`No v16 request validator for action "${action}"`] };
  }
  if (validate(payload)) {
    return { valid: true, errors: [] };
  }
  const schema = v16Schemas[requestSchemaKey(action)];
  const errors = schema
    ? validationErrors(schema as Parameters<typeof validationErrors>[0], payload)
    : [`Invalid ${action} request payload`];
  return { valid: false, errors };
}
