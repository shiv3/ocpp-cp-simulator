/**
 * The minimum shape a scenario definition must have to be *loadable*.
 *
 * Distinct from {@link validateScenarioSchema}, which checks a definition
 * against the whole published schema and is deliberately advisory (issue #214:
 * no file written before that schema existed should ever fail to load). This
 * check is a hard gate, and it covers only the fields the runtime cannot work
 * without — the same set the schema marks `required`.
 *
 * Why it has to be a gate: `loadScenario` keyed its runtime map on
 * `definition.id` and returned it unchecked. A definition with no `id` was
 * accepted, stored under the key `undefined`, and reported over RPC as `{}`
 * instead of `{ scenarioId }`. `list_scenarios` then showed an entry with a
 * name but no id, which could be neither run nor removed.
 */

/** Fields the schema marks required, in the order they are reported. */
const REQUIRED_FIELDS = ["id", "name", "targetType", "nodes", "edges"] as const;

const TARGET_TYPES = ["chargePoint", "connector"] as const;

export interface LoadableScenarioResult {
  valid: boolean;
  /** One message per problem; empty when valid. */
  errors: string[];
}

/**
 * Check `value` against the loadable-scenario invariants. Never throws: a
 * non-object (null, a JSON string, an array, …) comes back invalid rather than
 * blowing up on property access.
 */
export function validateLoadableScenario(
  value: unknown,
): LoadableScenarioResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      valid: false,
      errors: ["scenario must be an object"],
    };
  }

  const def = value as Record<string, unknown>;
  const errors: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (def[field] === undefined || def[field] === null) {
      errors.push(`scenario is missing required field "${field}"`);
    }
  }

  // A whitespace-only id is as unaddressable as a missing one: it can't be
  // typed back into run_scenario / remove_scenario reliably.
  if (def.id !== undefined && def.id !== null) {
    if (typeof def.id !== "string" || def.id.trim() === "") {
      errors.push('scenario "id" must be a non-empty string');
    }
  }

  if (def.name !== undefined && def.name !== null) {
    if (typeof def.name !== "string") {
      errors.push('scenario "name" must be a string');
    }
  }

  if (def.targetType !== undefined && def.targetType !== null) {
    if (
      !TARGET_TYPES.includes(def.targetType as (typeof TARGET_TYPES)[number])
    ) {
      errors.push(
        `scenario "targetType" must be one of ${TARGET_TYPES.map((t) => `"${t}"`).join(" | ")}`,
      );
    }
  }

  for (const field of ["nodes", "edges"] as const) {
    if (def[field] !== undefined && def[field] !== null) {
      if (!Array.isArray(def[field])) {
        errors.push(`scenario "${field}" must be an array`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Throw unless `value` satisfies the loadable-scenario invariants. The message
 * lists every problem so an operator fixing a hand-written payload doesn't have
 * to discover them one round-trip at a time.
 */
export function assertLoadableScenario(value: unknown): void {
  const result = validateLoadableScenario(value);
  if (!result.valid) {
    throw new Error(`Invalid scenario: ${result.errors.join("; ")}`);
  }
}
