/**
 * The model behind `ScenarioValueField`: how a JSON value a step holds (a
 * switch `value`, a notify `requestId`, a setState `value`, a loop's
 * "until") reads as a constant of some type or as a `{ "$from": "<root>.<path>" }`
 * reference (schema 1.6, docs/concepts/scenario-format.md). Pure, so the
 * round trip can be tested without a DOM.
 */
import type { ScenarioNode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { ScenarioNodeType } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

export const FROM_ROOTS = ["call", "charger", "connector", "state"] as const;
export type FromRoot = (typeof FROM_ROOTS)[number];

/** The paths each fixed root reports (resolveFrom.ts). `call.payload.` is
 *  a free path; `state.` keys come from the scenario's setState steps. */
export const FROM_PATHS: Record<
  Exclude<FromRoot, "state">,
  readonly string[]
> = {
  call: ["payload.", "action", "messageId"],
  charger: ["id", "ocppVersion", "status", "connectorIds"],
  connector: [
    "id",
    "status",
    "availability",
    "transactionId",
    "idTag",
    "power.acceptedW",
    "power.offeredW",
    "power.soc",
    "power.limitedBy",
  ],
};

export const CONSTANT_TYPES = [
  "text",
  "number",
  "boolean",
  "null",
  "json",
] as const;
export type ConstantType = (typeof CONSTANT_TYPES)[number];

export type ValueShape =
  /** No value (an optional field left empty). */
  | { mode: "unset" }
  | { mode: "constant"; type: ConstantType }
  | { mode: "from"; root: FromRoot; path: string };

function isFromRoot(value: string): value is FromRoot {
  return (FROM_ROOTS as readonly string[]).includes(value);
}

/** `{ "$from": "<root>[.<path>]" }`; an empty path names the root alone. */
export function fromValue(root: FromRoot, path: string): { $from: string } {
  return { $from: path === "" ? root : `${root}.${path}` };
}

/** Root and path of a whole `{ "$from": "..." }` value (exactly that one key,
 *  a string) on a known root that writes back to the same text; else null,
 *  and the value is edited as JSON so nothing is lost. */
export function readFrom(
  value: unknown,
): { root: FromRoot; path: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value);
  const from = (value as { $from?: unknown }).$from;
  if (keys.length !== 1 || keys[0] !== "$from" || typeof from !== "string") {
    return null;
  }
  const dot = from.indexOf(".");
  const root = dot < 0 ? from : from.slice(0, dot);
  const path = dot < 0 ? "" : from.slice(dot + 1);
  if (!isFromRoot(root) || fromValue(root, path).$from !== from) return null;
  return { root, path };
}

/** The constant type a value reads as by itself: anything that is not a
 *  string, a finite number, a boolean or null is JSON. */
export function constantTypeOf(value: unknown): ConstantType {
  if (typeof value === "string") return "text";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  if (value === null) return "null";
  return "json";
}

/** How `value` reads by itself. `allowFrom: false` (switch cases: JSON
 *  constants only) reads a `$from` object as JSON. */
export function readValueShape(value: unknown, allowFrom = true): ValueShape {
  if (value === undefined) return { mode: "unset" };
  const from = allowFrom ? readFrom(value) : null;
  if (from) return { mode: "from", ...from };
  return { mode: "constant", type: constantTypeOf(value) };
}

/** Whether `value` can be shown as `type` without changing it. JSON shows
 *  any defined value. */
export function fitsConstantType(value: unknown, type: ConstantType): boolean {
  if (value === undefined) return false;
  return type === "json" || constantTypeOf(value) === type;
}

/** The value a type change starts from: the current value when it already
 *  is of that type, else the nearest one (text of a number, a number read
 *  from text, true, null). JSON keeps the value as it is. */
export function convertConstant(value: unknown, type: ConstantType): unknown {
  switch (type) {
    case "text":
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return "";
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      const parsed = typeof value === "string" ? Number(value) : Number.NaN;
      return value !== "" && Number.isFinite(parsed) ? parsed : 0;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      return value !== "false";
    case "null":
      return null;
    case "json":
      return value === undefined ? null : value;
  }
}

/** The keys the scenario's setState steps store, in file order, once each. */
export function collectStateKeys(
  nodes: ReadonlyArray<Pick<ScenarioNode, "type" | "data">>,
): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    if (node.type !== ScenarioNodeType.SET_STATE) continue;
    const key = (node.data as { key?: unknown }).key;
    if (typeof key === "string" && key !== "" && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/** The paths offered for `root`. */
export function pathSuggestions(
  root: FromRoot,
  stateKeys: readonly string[],
): readonly string[] {
  return root === "state" ? stateKeys : FROM_PATHS[root];
}

export type PathAdvice = "incomplete" | "unknownField" | "unknownStateKey";

/** An advisory note on a path (the run decides; a path that names nothing
 *  fails it): empty or ending in a dot, a field the root does not report, a
 *  state key no setState step stores. */
export function pathAdvice(
  root: FromRoot,
  path: string,
  stateKeys: readonly string[],
): PathAdvice | null {
  if (path === "" || path.endsWith(".")) return "incomplete";
  if (root === "call") {
    return path === "action" ||
      path === "messageId" ||
      path === "payload" ||
      path.startsWith("payload.")
      ? null
      : "unknownField";
  }
  if (root === "state") {
    return stateKeys.includes(path.split(".")[0]!) ? null : "unknownStateKey";
  }
  return FROM_PATHS[root].includes(path) ? null : "unknownField";
}

/** JSON equality, as the executor compares a switch's cases: same type,
 *  same items in order, same keys whatever their order. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return (
      a.length === other.length && a.every((x, i) => jsonEqual(x, other[i]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => key in right && jsonEqual(left[key], right[key]))
  );
}

/** An old index → new index map for a list edit; `null`: removed. */
export type IndexMapping = ReadonlyArray<number | null>;

/** `list` with item `from` moved to `to`, and where each old item went. */
export function moveItem<T>(
  list: readonly T[],
  from: number,
  to: number,
): { next: T[]; mapping: IndexMapping } {
  const order = list.map((_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  const mapping: Array<number | null> = list.map(() => null);
  order.forEach((old, index) => {
    mapping[old] = index;
  });
  return { next: order.map((old) => list[old]!), mapping };
}

/** `list` without item `index`, and where each old item went. */
export function removeItem<T>(
  list: readonly T[],
  index: number,
): { next: T[]; mapping: IndexMapping } {
  return {
    next: list.filter((_, i) => i !== index),
    mapping: list.map((_, i) => (i === index ? null : i < index ? i : i - 1)),
  };
}
