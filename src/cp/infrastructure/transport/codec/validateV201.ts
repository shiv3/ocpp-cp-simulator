import {
  actionValidatorV201,
  schemas,
  validationErrors,
} from "../../../../ocpp";

export interface V201ValidationResult {
  valid: boolean;
  errors: string[];
}

// `schemas.v201` keys are camelCase, e.g. "BootNotification" -> "bootNotificationRequestV201".
function requestSchemaKey(action: string): string {
  return `${action.charAt(0).toLowerCase()}${action.slice(1)}RequestV201`;
}

const v201Schemas = schemas.v201 as Record<string, unknown>;

/** Validate an OCPP 2.0.1 CALL request payload against the bundled JSON schema. Never throws. */
export function validateV201Request(
  action: string,
  payload: unknown,
): V201ValidationResult {
  const validate = actionValidatorV201[action];
  if (!validate) {
    return {
      valid: false,
      errors: [`No v201 request validator for action "${action}"`],
    };
  }
  if (validate(payload)) {
    return { valid: true, errors: [] };
  }
  const schema = v201Schemas[requestSchemaKey(action)];
  const errors = schema
    ? validationErrors(
        schema as Parameters<typeof validationErrors>[0],
        payload,
      )
    : [`Invalid ${action} request payload`];
  return { valid: false, errors };
}

/** Returns a warning string if an outgoing v201 CALL request is schema-invalid, else null. */
export function outgoingV201Warning(
  action: string,
  payload: unknown,
): string | null {
  const result = validateV201Request(action, payload);
  if (result.valid) {
    return null;
  }
  return `Outgoing ${action} failed v201 schema validation: ${result.errors.join("; ")}`;
}
