import type { ValidationIssue } from "@ocpp-cp-simulator/ocpp/validate";

/**
 * The four kinds of payload violation OCPP-J tells apart (1.6 §4.2.3 and
 * 2.0.1 / 2.1 Part 4 §4.3 Table 8), independent of the version's spelling of
 * the error code.
 */
export type ViolationKind = "format" | "occurrence" | "type" | "property";

const OCCURRENCE_KEYWORDS = new Set(["required", "minItems", "maxItems"]);
const PROPERTY_KEYWORDS = new Set([
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
]);

const RANK: readonly ViolationKind[] = [
  "format",
  "occurrence",
  "type",
  "property",
];

function kindOf(issue: ValidationIssue): ViolationKind {
  // A payload that is not an object at all is a PDU structure problem.
  if (issue.instancePath === "" && issue.keyword === "type") return "format";
  if (OCCURRENCE_KEYWORDS.has(issue.keyword)) return "occurrence";
  if (issue.keyword === "type") return "type";
  if (PROPERTY_KEYWORDS.has(issue.keyword)) return "property";
  // additionalProperties and anything else: the payload does not fit the PDU.
  return "format";
}

/**
 * The kind of the first (most structural) violation among `issues`: format,
 * then missing / surplus occurrences, then wrong JSON type, then invalid value.
 * An empty list is a `format` violation (the caller found the payload invalid
 * by another route).
 */
export function violationKind(
  issues: readonly ValidationIssue[],
): ViolationKind {
  if (issues.length === 0) return "format";
  return issues
    .map(kindOf)
    .reduce((best, kind) =>
      RANK.indexOf(kind) < RANK.indexOf(best) ? kind : best,
    );
}
