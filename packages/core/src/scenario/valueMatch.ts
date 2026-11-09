/**
 * How a `switch` case (and, later, a loop `until`) decides it matches a value
 * (schema 1.7). A case is either a JSON constant, compared by JSON equality as
 * since 1.6, or a **matcher**: an object whose only key is `"$match"`:
 *
 * ```json
 * { "$match": { "in": ["Blocked", "Invalid", "Expired"] } }
 * { "$match": { "gte": 20, "lt": 80 } }
 * { "$match": { "exists": false } }
 * { "$match": { "not": { "equals": "Charging" } } }
 * ```
 *
 * Operators inside one `$match` are ANDed: `equals`, `in`, `gt`, `gte`, `lt`,
 * `lte`, `exists`, `startsWith`, `endsWith`, `includes`, and `not` (one level:
 * a body of the same operators without another `not`). A matcher never builds
 * a value, it answers yes or no.
 *
 * Ordering (`gt` `gte` `lt` `lte`): two numbers compare numerically, two
 * strings lexicographically (so ISO-8601 instants order correctly), and a
 * string that is a canonical decimal number (`/^-?(0|[1-9]\d*)(\.\d+)?$/`)
 * compares as that number, because OCPP 1.6 carries Configuration values and
 * sampled values as strings. Any other pairing does not match (no error).
 * `equals`, `in` and a bare constant stay strict JSON equality (`"30"` is not
 * `30`).
 *
 * An unknown operator or an argument of the wrong type throws a
 * {@link MatcherError} when the case is evaluated: the file still loads, the
 * switch that reaches it fails the run.
 */

/** What a `switch` value reads as when its `$from` names nothing. Only the
 *  matcher `{ "$match": { "exists": false } }` matches it. */
export const MISSING: unique symbol = Symbol("missing");

/** JSON equality: same type, same value, objects without regard to key order. */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((item, i) => jsonEquals(item, b[i]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        jsonEquals(left[key], right[key]),
    )
  );
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a case is a matcher: an object with `$match` as its only key. */
export function isMatcher(spec: unknown): spec is { $match: unknown } {
  if (!isPlainObject(spec)) return false;
  const keys = Object.keys(spec);
  return keys.length === 1 && keys[0] === "$match";
}

export type MatcherProblemKind = "unknownMatcher" | "badMatcherArgument";

export interface MatcherProblem {
  kind: MatcherProblemKind;
  /** The operator at fault (`""` when `$match` itself is the problem). */
  operator: string;
  message: string;
}

/** A matcher that cannot be evaluated: thrown by {@link matchCase}. */
export class MatcherError extends Error {
  readonly kind: MatcherProblemKind;
  readonly operator: string;
  constructor(problem: MatcherProblem) {
    super(problem.message);
    this.name = "MatcherError";
    this.kind = problem.kind;
    this.operator = problem.operator;
  }
}

const OPERATORS = [
  "equals",
  "in",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "startsWith",
  "endsWith",
  "includes",
  "not",
] as const;
type Operator = (typeof OPERATORS)[number];
const ORDERING = new Set<string>(["gt", "gte", "lt", "lte"]);
const STRING_OPS = new Set<string>(["startsWith", "endsWith", "includes"]);

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** The first problem of an operator object, or null. `inNot`: the body of a
 *  `not`, which cannot nest another `not`. */
function operatorsProblem(ops: unknown, inNot: boolean): MatcherProblem | null {
  if (!isPlainObject(ops) || Object.keys(ops).length === 0) {
    return {
      kind: "badMatcherArgument",
      operator: "",
      message: inNot
        ? '$match: "not" takes an object with at least one operator'
        : "$match takes an object with at least one operator",
    };
  }
  for (const [op, arg] of Object.entries(ops)) {
    if (!(OPERATORS as readonly string[]).includes(op)) {
      return {
        kind: "unknownMatcher",
        operator: op,
        message: `$match: unknown operator "${op}" (known: ${OPERATORS.join(", ")})`,
      };
    }
    const bad = (what: string): MatcherProblem => ({
      kind: "badMatcherArgument",
      operator: op,
      message: `$match: "${op}" takes ${what}, got ${JSON.stringify(arg)}`,
    });
    if (op === "in" && !Array.isArray(arg)) return bad("an array");
    if (ORDERING.has(op) && typeof arg !== "number" && typeof arg !== "string")
      return bad("a number or a string");
    if (ORDERING.has(op) && typeof arg === "number" && !Number.isFinite(arg))
      return bad("a finite number");
    if (op === "exists" && typeof arg !== "boolean")
      return bad("true or false");
    if (STRING_OPS.has(op) && typeof arg !== "string") return bad("a string");
    if (op === "not") {
      if (inNot) return bad("no nested not");
      const inner = operatorsProblem(arg, true);
      if (inner) return inner;
    }
  }
  return null;
}

/** Why `spec` (a case) cannot be evaluated, or null. A constant never has a
 *  problem; neither does a matcher made of known operators with right-typed
 *  arguments. */
export function matcherProblem(spec: unknown): MatcherProblem | null {
  if (!isMatcher(spec)) return null;
  return operatorsProblem(spec.$match, false);
}

/** A number, or the number a canonical decimal string stands for. */
function asOrdinal(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && DECIMAL.test(v)) return Number(v);
  return null;
}

/** -1, 0, 1, or null when the two do not compare (other type pairings). */
function compare(a: unknown, b: unknown): number | null {
  const na = asOrdinal(a);
  const nb = asOrdinal(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return null;
}

function applyOperators(value: unknown, ops: Record<string, unknown>): boolean {
  const present = value !== MISSING;
  for (const [op, arg] of Object.entries(ops) as Array<[Operator, unknown]>) {
    let ok: boolean;
    switch (op) {
      case "exists":
        ok = arg === present;
        break;
      case "not":
        ok = !applyOperators(value, arg as Record<string, unknown>);
        break;
      case "equals":
        ok = present && jsonEquals(value, arg);
        break;
      case "in":
        ok = present && (arg as unknown[]).some((v) => jsonEquals(value, v));
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const c = present ? compare(value, arg) : null;
        ok =
          c !== null &&
          (op === "gt"
            ? c > 0
            : op === "gte"
              ? c >= 0
              : op === "lt"
                ? c < 0
                : c <= 0);
        break;
      }
      case "startsWith":
        ok = typeof value === "string" && value.startsWith(arg as string);
        break;
      case "endsWith":
        ok = typeof value === "string" && value.endsWith(arg as string);
        break;
      case "includes":
        ok = typeof value === "string" && value.includes(arg as string);
        break;
    }
    if (!ok) return false;
  }
  return true;
}

/**
 * Whether `value` matches the case `spec`. A constant matches by
 * {@link jsonEquals}; `{ "$match": {...} }` by its operators (ANDed). A
 * `value` of {@link MISSING} (a path that names nothing) matches only a
 * matcher that is exactly `{ "exists": false }`. Throws a {@link MatcherError}
 * for an unknown operator or an argument of the wrong type.
 */
export function matchCase(value: unknown, spec: unknown): boolean {
  if (!isMatcher(spec)) return value !== MISSING && jsonEquals(value, spec);
  const problem = operatorsProblem(spec.$match, false);
  if (problem) throw new MatcherError(problem);
  const ops = spec.$match as Record<string, unknown>;
  if (value === MISSING) {
    const keys = Object.keys(ops);
    return keys.length === 1 && ops.exists === false;
  }
  return applyOperators(value, ops);
}

const short = (v: unknown): string =>
  typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));

function describeOperators(ops: Record<string, unknown>): string {
  if (Object.keys(ops).length === 1 && ops.exists === false) return "missing";
  return Object.entries(ops)
    .map(([op, arg]) => {
      switch (op) {
        case "equals":
          return `= ${short(arg)}`;
        case "in":
          return Array.isArray(arg) ? `in ${arg.map(short).join("|")}` : "in ?";
        case "gt":
          return `> ${short(arg)}`;
        case "gte":
          return `≥ ${short(arg)}`;
        case "lt":
          return `< ${short(arg)}`;
        case "lte":
          return `≤ ${short(arg)}`;
        case "exists":
          return arg === true ? "exists" : "missing";
        case "startsWith":
          return `starts with ${short(arg)}`;
        case "endsWith":
          return `ends with ${short(arg)}`;
        case "includes":
          return `contains ${short(arg)}`;
        case "not":
          return isPlainObject(arg)
            ? `not (${describeOperators(arg)})`
            : "not ?";
        default:
          return `${op} ?`;
      }
    })
    .join(", ");
}

/** A short text for a matcher, for chips: `in Blocked|Invalid|Expired`,
 *  `≥ 80`, `missing`, `≥ 20, < 80`. Never throws, whatever `spec` holds. */
export function describeMatcher(spec: unknown): string {
  if (!isMatcher(spec)) return short(spec);
  return isPlainObject(spec.$match) && Object.keys(spec.$match).length > 0
    ? describeOperators(spec.$match)
    : "match ?";
}

/** Whether `spec` matches every present value (`exists: true`, `not:
 *  { exists: false }`): a later case can only be reached by a missing value. */
export function matchesEveryPresentValue(spec: unknown): boolean {
  if (!isMatcher(spec) || matcherProblem(spec)) return false;
  const ops = spec.$match as Record<string, unknown>;
  const keys = Object.keys(ops);
  if (keys.length !== 1) return false;
  if (ops.exists === true) return true;
  const inner = ops.not;
  return (
    isPlainObject(inner) &&
    Object.keys(inner).length === 1 &&
    inner.exists === false
  );
}
