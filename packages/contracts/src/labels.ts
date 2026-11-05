import { z } from "zod";

/**
 * Charge-point labels (#446): free-form `key → value` metadata an operator
 * uses to group charge points (site, tenant, environment, lab, hardware
 * family, …) without the simulator modelling any of those concepts.
 *
 * Labels belong to the control and query surfaces only — `cp.list` filters on
 * them, the console shows them. They are never Prometheus label values: an
 * operator can create any number of distinct values, which is exactly the
 * unbounded cardinality the metrics deliberately avoid (no `cpId` label
 * either).
 */

export const LABELS_MAX_ENTRIES = 32;
export const LABEL_KEY_MAX = 63;
export const LABEL_VALUE_MAX = 256;

/**
 * Starts and ends with an ASCII letter or digit; `.`, `_`, `-` and `/` may sit
 * in between. Narrow on purpose: a key has to survive a URL query
 * (`label=key:value`), a log line and a future selector syntax unescaped, so
 * `:`, `=`, `,` and whitespace are out — and so is `__proto__`.
 */
export const labelKeySchema = z
  .string()
  .max(LABEL_KEY_MAX)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/)
  .describe(
    `Label key: ASCII letters, digits, '.', '_', '-', '/', starting and ending with a letter or digit, at most ${LABEL_KEY_MAX} characters`,
  );

/** Any string, the empty one included; bounded like every wire string. */
export const labelValueSchema = z
  .string()
  .max(LABEL_VALUE_MAX)
  .describe(`Label value, at most ${LABEL_VALUE_MAX} characters`);

export const labelsSchema = z
  .record(labelKeySchema, labelValueSchema)
  .refine((labels) => Object.keys(labels).length <= LABELS_MAX_ENTRIES, {
    message: `at most ${LABELS_MAX_ENTRIES} labels`,
  })
  .describe(
    `Generic key/value labels used to group and select charge points, at most ${LABELS_MAX_ENTRIES} entries`,
  );

export type Labels = Readonly<Record<string, string>>;

/**
 * True when every `key: value` pair of `selector` is present on `labels` with
 * exactly that value (case-sensitive). An absent or empty selector matches
 * every charge point, a labelless one included.
 */
export function matchesLabelSelector(
  labels: Labels | undefined,
  selector: Labels | undefined,
): boolean {
  if (!selector) return true;
  return Object.entries(selector).every(
    ([key, value]) =>
      labels !== undefined &&
      Object.hasOwn(labels, key) &&
      labels[key] === value,
  );
}

/**
 * The one representation of "no labels": `undefined`. An empty map and an
 * absent one mean the same thing, and folding them here keeps a charge point
 * from reading `{}` before a restart and nothing after it.
 */
export function normalizeLabels(
  labels: Labels | undefined,
): Labels | undefined {
  if (!labels || Object.keys(labels).length === 0) return undefined;
  return { ...labels };
}
