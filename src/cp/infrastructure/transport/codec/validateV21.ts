import {
  actionValidatorV21,
  schemas,
  validationErrors,
} from "../../../../ocpp";

export interface V21ValidationResult {
  valid: boolean;
  errors: string[];
}

// `schemas.v21` keys are camelCase, e.g. "BootNotification" -> "bootNotificationRequestV21".
function requestSchemaKey(action: string): string {
  return `${action.charAt(0).toLowerCase()}${action.slice(1)}RequestV21`;
}

const v21Schemas = schemas.v21 as Record<string, unknown>;

/** Validate an OCPP 2.1 CALL request payload against the bundled JSON schema. Never throws. */
export function validateV21Request(
  action: string,
  payload: unknown,
): V21ValidationResult {
  const validate = actionValidatorV21[action];
  if (!validate) {
    return {
      valid: false,
      errors: [`No v21 request validator for action "${action}"`],
    };
  }
  if (validate(payload)) {
    return { valid: true, errors: [] };
  }
  const schema = v21Schemas[requestSchemaKey(action)];
  const errors = schema
    ? validationErrors(
        schema as Parameters<typeof validationErrors>[0],
        payload,
      )
    : [`Invalid ${action} request payload`];
  return { valid: false, errors };
}

/** Returns a warning string if an outgoing v21 CALL request is schema-invalid, else null. */
export function outgoingV21Warning(
  action: string,
  payload: unknown,
): string | null {
  const result = validateV21Request(action, payload);
  if (result.valid) {
    return null;
  }
  return `Outgoing ${action} failed v21 schema validation: ${result.errors.join("; ")}`;
}
