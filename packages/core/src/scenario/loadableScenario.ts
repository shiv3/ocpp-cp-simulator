/**
 * The one gate every scenario load passes through, in the browser
 * (`parseScenarioJSON`) and in the daemon (`loadScenario`, `--watch`
 * reloads, the console-upload sync).
 *
 * Distinct from {@link validateScenarioSchema}, which checks a definition
 * against the whole published schema and is deliberately advisory (issue #214:
 * no file written before that schema existed should ever fail to load). This
 * check is a hard gate only for what the runtime cannot work without: an
 * object with a non-empty string `id` and `nodes` / `edges` arrays.
 *
 * Why it has to be a gate: `loadScenario` keyed its runtime map on
 * `definition.id` and returned it unchecked. A definition with no `id` was
 * accepted, stored under the key `undefined`, and reported over RPC as `{}`
 * instead of `{ scenarioId }`. `list_scenarios` then showed an entry with a
 * name but no id, which could be neither run nor removed.
 *
 * The browser and the daemon used to gate differently: the browser asked for
 * `id`, `nodes` and `edges` only, the daemon also for a string `name` and a
 * valid `targetType`. Unified without rejecting anything either side
 * accepted: a missing or non-string `name` becomes the `id`, a missing or
 * unknown `targetType` becomes `"connector"`, each reported as an `info`
 * diagnostic on a normalised copy. An `id` the daemon cannot address (blank
 * once trimmed, or longer than `SCENARIO_ID_MAX`) is a `warning` the browser
 * reports and the daemon still refuses, as it always did.
 */

import { SCENARIO_ID_MAX } from "@ocpp-cp-simulator/contracts/limits";

import type { ScenarioDefinition } from "../cp/application/scenario/ScenarioTypes";
import type { Diagnostic } from "./diagnostic";

/** Fields without which nothing can load, in the order they are reported. */
const REQUIRED_FIELDS = ["id", "nodes", "edges"] as const;

const TARGET_TYPES = ["chargePoint", "connector"] as const;

/** What a load fills in when the file leaves it out or gets it wrong. */
export const DEFAULT_TARGET_TYPE =
  "connector" satisfies ScenarioDefinition["targetType"];

export type LoadDiagnosticCode =
  /** `name` missing or not a string: the `id` is used (`data.was`). */
  | "defaultName"
  /** `targetType` missing or unknown: `"connector"` is used (`data.was`). */
  | "defaultTargetType"
  /** The `id` cannot be addressed over the control plane (blank once
   *  trimmed, or too long; `data.message`): the daemon refuses it. */
  | "idNotAddressable";

export type LoadDiagnostic = Diagnostic<LoadDiagnosticCode>;

export interface LoadableScenarioCheck {
  /** The normalised copy, or `null` when `errors` is not empty. */
  definition: ScenarioDefinition | null;
  /** Why the value cannot load anywhere; empty when it can. */
  errors: string[];
  /** Advisory findings about a loadable value. */
  diagnostics: LoadDiagnostic[];
}

/**
 * The shared gate. Never throws: a non-object (null, a JSON string, an array,
 * …) comes back with an error rather than blowing up on property access.
 * `value` is never mutated; `definition` is a shallow copy when something was
 * filled in.
 */
export function checkLoadableScenario(value: unknown): LoadableScenarioCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      definition: null,
      errors: ["scenario must be an object"],
      diagnostics: [],
    };
  }

  const def = value as Record<string, unknown>;
  const errors: string[] = [];
  const diagnostics: LoadDiagnostic[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (def[field] === undefined || def[field] === null) {
      errors.push(`scenario is missing required field "${field}"`);
    }
  }

  if (def.id !== undefined && def.id !== null) {
    if (typeof def.id !== "string" || def.id === "") {
      errors.push('scenario "id" must be a non-empty string');
    } else if (def.id.trim() === "") {
      // A whitespace-only id is as unaddressable as a missing one: it can't
      // be typed back into run_scenario / remove_scenario reliably.
      diagnostics.push({
        code: "idNotAddressable",
        severity: "warning",
        data: { message: 'scenario "id" must be a non-empty string' },
      });
    } else if (def.id.length > SCENARIO_ID_MAX) {
      // A definition arriving as an RPC *object* is already bounded by
      // `SCENARIO_MAX_BYTES`, so its id cannot reach this — but one read from
      // a file goes through no object schema at all, and an id past this
      // length loaded happily and then made every `file-reload` event naming
      // it fail envelope validation, where the failure is only logged (#314).
      diagnostics.push({
        code: "idNotAddressable",
        severity: "warning",
        data: {
          message: `scenario "id" must be at most ${SCENARIO_ID_MAX} characters`,
        },
      });
    }
  }

  for (const field of ["nodes", "edges"] as const) {
    if (def[field] !== undefined && def[field] !== null) {
      if (!Array.isArray(def[field])) {
        errors.push(`scenario "${field}" must be an array`);
      }
    }
  }

  if (errors.length > 0) return { definition: null, errors, diagnostics };

  const normalised: Record<string, unknown> = { ...def };
  let changed = false;
  if (typeof def.name !== "string") {
    diagnostics.push({
      code: "defaultName",
      severity: "info",
      data: { was: def.name },
    });
    normalised.name = def.id;
    changed = true;
  }
  if (!TARGET_TYPES.includes(def.targetType as (typeof TARGET_TYPES)[number])) {
    diagnostics.push({
      code: "defaultTargetType",
      severity: "info",
      data: { was: def.targetType },
    });
    normalised.targetType = DEFAULT_TARGET_TYPE;
    changed = true;
  }

  return {
    definition: (changed ? normalised : def) as unknown as ScenarioDefinition,
    errors,
    diagnostics,
  };
}

/** One line for a load diagnostic, for a log or a warning. */
export function describeLoadDiagnostic(diagnostic: LoadDiagnostic): string {
  const was = diagnostic.data?.was;
  switch (diagnostic.code) {
    case "defaultName":
      return was === undefined
        ? 'scenario has no "name"; using the id'
        : `scenario "name" ${JSON.stringify(was)} is not a string; using the id`;
    case "defaultTargetType":
      return was === undefined
        ? `scenario has no "targetType"; using "${DEFAULT_TARGET_TYPE}"`
        : `scenario "targetType" ${JSON.stringify(was)} is not one of ${TARGET_TYPES.map((t) => `"${t}"`).join(" | ")}; using "${DEFAULT_TARGET_TYPE}"`;
    case "idNotAddressable":
      return String(diagnostic.data?.message);
  }
}

export interface LoadableScenarioResult {
  valid: boolean;
  /** One message per problem; empty when valid. */
  errors: string[];
  /** The normalised definition when valid. */
  definition: ScenarioDefinition | null;
  /** The advisory findings (filled-in defaults). */
  diagnostics: LoadDiagnostic[];
}

/**
 * The daemon's gate: {@link checkLoadableScenario}, plus an `id` the control
 * plane can address. Never throws.
 */
export function validateLoadableScenario(
  value: unknown,
): LoadableScenarioResult {
  const check = checkLoadableScenario(value);
  const unaddressable = check.diagnostics.filter(
    (d) => d.code === "idNotAddressable",
  );
  // In the order the daemon always reported them: missing fields, the id,
  // then nodes / edges that are not arrays.
  const missing = check.errors.filter((e) =>
    e.startsWith("scenario is missing"),
  );
  const idErrors = check.errors.filter((e) => e.startsWith('scenario "id"'));
  const rest = check.errors.filter(
    (e) => !missing.includes(e) && !idErrors.includes(e),
  );
  const errors = [
    ...missing,
    ...idErrors,
    ...unaddressable.map(describeLoadDiagnostic),
    ...rest,
  ];
  const valid = errors.length === 0;
  return {
    valid,
    errors,
    definition: valid ? check.definition : null,
    diagnostics: check.diagnostics.filter((d) => d.code !== "idNotAddressable"),
  };
}

/**
 * Throw unless `value` passes the daemon's gate; return the normalised
 * definition. The message lists every problem so an operator fixing a
 * hand-written payload doesn't have to discover them one round-trip at a
 * time. `onAdvisory` hears each default that was filled in.
 */
export function assertLoadableScenario(
  value: unknown,
  onAdvisory?: (message: string) => void,
): ScenarioDefinition {
  const result = validateLoadableScenario(value);
  if (!result.valid) {
    throw new Error(`Invalid scenario: ${result.errors.join("; ")}`);
  }
  for (const d of result.diagnostics) onAdvisory?.(describeLoadDiagnostic(d));
  return result.definition!;
}
