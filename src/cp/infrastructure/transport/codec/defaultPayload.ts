/**
 * A starting payload for an OCPP request schema (#389): the smallest value the
 * schema accepts, for the operator to edit before sending. Only required
 * properties are filled; enums take their first value, `date-time` strings the
 * current time, numbers their minimum (or 0), strings their minimum length.
 * Handles the subset the vendored OCPP 1.6 / 2.0.1 / 2.1 schemas use — local
 * `#/definitions/…` refs, objects, arrays, scalars — not JSON Schema at large.
 */
type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  format?: string;
  minimum?: number;
  minLength?: number;
  minItems?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  definitions?: Record<string, Schema>;
};

export function defaultPayloadFromSchema(schema: object): unknown {
  const root = schema as Schema;
  return valueFor(root, root);
}

function resolve(schema: Schema, root: Schema): Schema {
  const prefix = "#/definitions/";
  if (schema.$ref?.startsWith(prefix)) {
    const target = root.definitions?.[schema.$ref.slice(prefix.length)];
    if (target) return resolve(target, root);
  }
  return schema;
}

function valueFor(raw: Schema, root: Schema): unknown {
  const schema = resolve(raw, root);
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        const property = schema.properties?.[key];
        if (property) out[key] = valueFor(property, root);
      }
      return out;
    }
    case "array":
      return Array.from({ length: schema.minItems ?? 0 }, () =>
        schema.items ? valueFor(schema.items, root) : null,
      );
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case "string":
      if (schema.format === "date-time") return new Date().toISOString();
      return "x".repeat(schema.minLength ?? 0);
    default:
      return {};
  }
}
