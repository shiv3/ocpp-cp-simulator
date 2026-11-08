import type {
  BehaviorParams,
  JsonObject,
  JsonValue,
  ParamsSchema,
} from "@ocpp-cp-sim/contracts/behavior";

/**
 * Validation of behavior params (docs/concepts/charger-engine.md, "Params").
 * A small, closed subset of JSON Schema written here so that no dependency and
 * no code path is added: the schema and the values are data, and nothing in
 * this file evaluates a string. The rule everywhere is refuse, never coerce.
 */

/** Most bytes of JSON one params object may take. */
export const MAX_PARAMS_BYTES = 16 * 1024;

const KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "title",
  "description",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
]);

const TYPES: ReadonlySet<string> = new Set([
  "object",
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "null",
]);

const MAX_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined
    ? String(value)
    : text.length > 60
      ? `${text.slice(0, 57)}...`
      : text;
}

/** Why `value` is not JSON (functions, undefined, NaN, cycles, class instances), or null. */
export function jsonProblem(
  value: unknown,
  path = "params",
  depth = 0,
): string | null {
  if (depth > MAX_DEPTH) return `${path}: nested more than ${MAX_DEPTH} levels`;
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : `${path}: not a finite number`;
    case "object": {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const problem = jsonProblem(value[i], `${path}[${i}]`, depth + 1);
          if (problem) return problem;
        }
        return null;
      }
      if (!isPlainObject(value)) return `${path}: not a plain JSON object`;
      for (const [key, inner] of Object.entries(value)) {
        if (key === "__proto__") return `${path}: "__proto__" is not a name`;
        const problem = jsonProblem(inner, `${path}.${key}`, depth + 1);
        if (problem) return problem;
      }
      return null;
    }
    default:
      return `${path}: ${typeof value} is not JSON`;
  }
}

/** Why `schema` is not a schema of the supported subset, or null. */
export function schemaProblem(
  schema: unknown,
  path = "schema",
  depth = 0,
): string | null {
  if (depth > MAX_DEPTH) return `${path}: nested more than ${MAX_DEPTH} levels`;
  if (!isPlainObject(schema)) return `${path}: must be an object`;
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) {
      return `${path}: keyword "${key}" is not supported (supported: ${[...KEYWORDS].join(", ")})`;
    }
  }
  const type = schema.type;
  if (type !== undefined && (typeof type !== "string" || !TYPES.has(type))) {
    return `${path}.type: must be one of ${[...TYPES].join(", ")}`;
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength"] as const) {
    if (schema[key] !== undefined && typeof schema[key] !== "number") {
      return `${path}.${key}: must be a number`;
    }
  }
  for (const key of ["minItems", "maxItems"] as const) {
    if (schema[key] !== undefined && typeof schema[key] !== "number") {
      return `${path}.${key}: must be a number`;
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      return `${path}.enum: must be a non-empty array`;
    }
    const problem = jsonProblem(schema.enum, `${path}.enum`);
    if (problem) return problem;
  }
  if (schema.const !== undefined) {
    const problem = jsonProblem(schema.const, `${path}.const`);
    if (problem) return problem;
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    return `${path}.additionalProperties: must be a boolean`;
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((name) => typeof name !== "string")
    ) {
      return `${path}.required: must be an array of names`;
    }
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      return `${path}.properties: must be an object`;
    }
    for (const [name, inner] of Object.entries(schema.properties)) {
      const problem = schemaProblem(inner, `${path}.${name}`, depth + 1);
      if (problem) return problem;
    }
  }
  if (schema.items !== undefined) {
    const problem = schemaProblem(schema.items, `${path}.items`, depth + 1);
    if (problem) return problem;
  }
  return null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Problems of `value` against `schema`, one line each; empty when it fits. */
function valueProblems(
  schema: ParamsSchema,
  value: unknown,
  path: string,
  out: string[],
): void {
  const type = schema.type;
  if (type !== undefined) {
    const actual = typeName(value);
    const ok =
      type === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : actual === type;
    if (!ok) {
      out.push(
        `${path}: expected ${type}, got ${show(value)}${
          type !== actual && typeof value === "string"
            ? " (strings are not converted)"
            : ""
        }`,
      );
      return;
    }
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) {
    out.push(`${path}: must be ${show(schema.const)}, got ${show(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.some((option) => sameJson(option, value))) {
    out.push(
      `${path}: must be one of ${schema.enum.map(show).join(", ")}, got ${show(value)}`,
    );
    return;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      out.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      out.push(`${path}: ${value} is above the maximum ${schema.maximum}`);
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.push(`${path}: shorter than ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      out.push(`${path}: longer than ${schema.maxLength} characters`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, i) =>
        valueProblems(schema.items!, item, `${path}[${i}]`, out),
      );
    }
  }
  if (isPlainObject(value)) {
    const known = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) out.push(`${path}.${name}: required`);
    }
    for (const [name, inner] of Object.entries(value)) {
      const inside = Object.hasOwn(known, name) ? known[name] : undefined;
      if (inside) {
        valueProblems(inside, inner, `${path}.${name}`, out);
      } else if (schema.additionalProperties !== true) {
        out.push(
          `${path}.${name}: unknown parameter (known: ${Object.keys(known).join(", ") || "none"})`,
        );
      }
    }
  }
}

/** Why `params` do not fit `schema`, or null. Never converts a value. */
export function validateParams(
  schema: ParamsSchema,
  params: unknown,
): string | null {
  const json = jsonProblem(params);
  if (json) return json;
  if (JSON.stringify(params).length > MAX_PARAMS_BYTES) {
    return `params: larger than ${MAX_PARAMS_BYTES} bytes`;
  }
  const out: string[] = [];
  valueProblems(schema, params, "params", out);
  return out.length > 0 ? out.join("; ") : null;
}

/**
 * Why a behavior's `params` declaration is unusable: a schema outside the
 * subset, a root that is not an object, `defaults` that are not JSON or do not
 * fit the schema. Null when it is fine (or there is none).
 */
export function paramsDeclarationProblem(
  declared: BehaviorParams | undefined,
): string | null {
  if (declared === undefined) return null;
  if (!isPlainObject(declared)) return "params: must be { schema, defaults }";
  const problem = schemaProblem(declared.schema);
  if (problem) return `params.${problem}`;
  if (declared.schema.type !== "object") {
    return 'params.schema: the root must have type "object"';
  }
  if (!isPlainObject(declared.defaults)) {
    return "params.defaults: must be an object";
  }
  const bad = validateParams(declared.schema, declared.defaults);
  return bad ? `params.defaults: ${bad}` : null;
}

/**
 * The params of a behavior for a station: `defaults`, then each layer over it
 * (shallow: a key a layer sets replaces the key, whatever it holds). Throws a
 * message naming the behavior when the result does not fit its schema, or when
 * a layer sets params on a behavior that declares none.
 */
export function mergeParams(
  behaviorId: string,
  declared: BehaviorParams | undefined,
  layers: readonly JsonObject[],
): JsonObject {
  const set = layers.filter((layer) => Object.keys(layer).length > 0);
  if (!declared) {
    if (set.length > 0) {
      throw new Error(
        `Behavior ${behaviorId} declares no params; it cannot take ${Object.keys(set[0]!).join(", ")}`,
      );
    }
    return EMPTY_PARAMS;
  }
  const merged: Record<string, JsonValue> = { ...declared.defaults };
  for (const layer of set) {
    // A layer is checked for JSON-ness below, but copy by definition so a
    // "__proto__" key can never reach the object's prototype.
    for (const [key, value] of Object.entries(layer)) {
      Object.defineProperty(merged, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  const problem = validateParams(declared.schema, merged);
  if (problem) {
    throw new Error(`Behavior ${behaviorId}: invalid params: ${problem}`);
  }
  return merged;
}

export const EMPTY_PARAMS: JsonObject = Object.freeze({});

/** A deep, frozen copy: what `ctx.params` hands out. */
export function freezeParams(value: JsonObject): JsonObject {
  const copy = JSON.parse(JSON.stringify(value)) as JsonObject;
  const freeze = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    for (const inner of Object.values(node)) freeze(inner);
    Object.freeze(node);
  };
  freeze(copy);
  return copy;
}
