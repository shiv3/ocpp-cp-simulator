/**
 * Advisory JSON Schema validation for scenario files (issue #214).
 *
 * Validates a parsed scenario value against `schema/scenario.schema.json`
 * (Draft 2020-12). This is intentionally WARNING-ONLY: every call site that
 * uses {@link validateScenarioSchema} logs the result and keeps loading the
 * scenario regardless of `valid`. No existing scenario file — including
 * ones authored before this schema existed — should ever fail to load
 * because of a schema mismatch. The one caller that treats `valid: false` as
 * fatal is `runExportK6`, which is a build step and not a load.
 *
 * A handful of rules the schema states in prose but Draft 2020-12 cannot
 * express are checked here alongside Ajv and reported in the same
 * `<instancePath> <message>` shape, so that every caller gets them for free:
 * currently just the auto-meter curve's non-decreasing ordinates (#332).
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
import { normalizeCurvePoints } from "../cp/domain/connector/MeterValueCurve";

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
  const curveErrors = descendingCurveErrors(value);
  if (valid && curveErrors.length === 0) {
    return { valid: true, errors: [] };
  }
  const errors = (validate.errors ?? []).map((error) =>
    `${error.instancePath || "/"} ${error.message ?? ""}`.trim(),
  );
  return { valid: false, errors: [...errors, ...curveErrors] };
}

/**
 * The auto-meter curve's ordering rule, which JSON Schema cannot state (#332).
 *
 * `curvePoint.value` is cumulative energy delivered, so a point below one the
 * curve already reached at an earlier time drives the energy register
 * backwards and can put `meterStop` below `meterStart`. Only the *descending*
 * case is reported here: a negative ordinate already fails the schema's
 * `minimum: 0` and a point that is not a `{ time, value }` pair already fails
 * its `required` / `type`, and repeating either would put the same point in
 * the warning twice.
 *
 * Defensive about shape throughout — this runs on a freshly parsed JSON value
 * that has, by construction, just failed or not yet passed validation.
 */
function descendingCurveErrors(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const { nodes } = value as { nodes?: unknown };
  if (!Array.isArray(nodes)) return [];

  const errors: string[] = [];
  nodes.forEach((node, nodeIndex) => {
    if (typeof node !== "object" || node === null) return;
    const { type, data } = node as { type?: unknown; data?: unknown };
    if (type !== "meterValue") return;
    if (typeof data !== "object" || data === null) return;
    const { curvePoints } = data as { curvePoints?: unknown };
    if (!Array.isArray(curvePoints)) return;

    for (const correction of normalizeCurvePoints(curvePoints).corrections) {
      if (correction.problem !== "decreasing") continue;
      errors.push(
        `/nodes/${nodeIndex}/data/curvePoints/${correction.index}/value ` +
          `must be >= ${correction.correctedTo}, the value already delivered ` +
          `at an earlier time (a curve ordinate is cumulative energy in kWh)`,
      );
    }
  });
  return errors;
}
