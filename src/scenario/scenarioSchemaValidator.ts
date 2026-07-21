/**
 * Advisory JSON Schema validation for scenario files (issue #214).
 *
 * Validates a parsed scenario value against `schema/scenario.schema.json`
 * (Draft 2020-12). This is intentionally WARNING-ONLY: every call site that
 * uses {@link validateScenarioSchema} logs the result and keeps loading the
 * scenario regardless of `valid`. No existing scenario file — including
 * ones authored before this schema existed — should ever fail to load
 * because of a schema mismatch.
 *
 * Uses the same Ajv Draft 2020-12 build (`ajv/dist/2020`) already vendored
 * for this project's generated OCPP payload schemas, with the same
 * permissive compiler options as `src/ocpp/validate.ts` (allErrors so a
 * single warning can list every problem, strict/strictSchema/validateFormats
 * off to match the hand-authored, non-formats-heavy schema here).
 */
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import scenarioSchema from "../../schema/scenario.schema.json";

export interface ScenarioSchemaValidationResult {
  valid: boolean;
  /** Short, human-readable messages, one per Ajv error (empty when valid). */
  errors: string[];
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  strictSchema: false,
  validateFormats: false,
});

let compiled: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (!compiled) {
    compiled = ajv.compile(scenarioSchema);
  }
  return compiled;
}

/** Validate a parsed scenario value against the published scenario schema.
 *  Never throws; a non-object/invalid value simply comes back `valid: false`
 *  with Ajv's error list. Callers use this for advisory warnings only. */
export function validateScenarioSchema(
  value: unknown,
): ScenarioSchemaValidationResult {
  const validate = getValidator();
  const valid = validate(value) === true;
  if (valid) {
    return { valid: true, errors: [] };
  }
  const errors = (validate.errors ?? []).map((error) =>
    `${error.instancePath || "/"} ${error.message ?? ""}`.trim(),
  );
  return { valid: false, errors };
}
