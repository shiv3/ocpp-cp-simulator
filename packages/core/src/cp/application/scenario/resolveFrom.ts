import type { ScenarioCallExchange } from "./ScenarioTypes";

/**
 * What a `$from` can read. Every root is read-only; none of them derives a
 * value (docs/concepts/scenario-format.md, "What the format will not do").
 */
export interface FromScope {
  /** The CALL the branch took over, for the root `call` (schema 1.5). */
  readonly exchange: ScenarioCallExchange | null;
  /** The latest answer to an `ocppCall` in this branch, for the root
   *  `response` (schema 1.7); absent or `null` when the branch has none. */
  readonly response?: ScenarioOcppResponse | null;
  /** The state of the run, for the root `state` (schema 1.6, `setState`). */
  readonly state: Readonly<Record<string, unknown>>;
  /** The station, for the roots `charger` and `connector` (schema 1.6). */
  readonly station?: (root: "charger" | "connector") => unknown;
}

/**
 * What the root `response` reads (schema 1.7): the answer to the latest
 * `ocppCall` of the branch. `payload` is set for `kind: "result"` only;
 * `errorCode`, `errorDescription` and `errorDetails` for `kind: "error"` only.
 */
export interface ScenarioOcppResponse {
  kind: "result" | "error";
  action: string;
  messageId?: string;
  payload?: unknown;
  errorCode?: string;
  errorDescription?: string;
  errorDetails?: unknown;
}

/** A whole value that reads from a root: `{ "$from": "call.payload.requestId" }`. */
export function isFromReference(value: unknown): value is { $from: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === "$from" &&
    typeof (value as { $from: unknown }).$from === "string"
  );
}

/** Whether `value` holds a `{ "$from": "<root>.…" }` anywhere. */
export function containsRootReference(value: unknown, root: string): boolean {
  if (isFromReference(value)) return value.$from.split(".")[0] === root;
  if (Array.isArray(value))
    return value.some((v) => containsRootReference(v, root));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((v) => containsRootReference(v, root));
  }
  return false;
}

/** Whether `value` holds a `{ "$from": "call.…" }` anywhere
 *  {@link resolveFromExchange} would resolve it, i.e. whether resolving it
 *  needs the CALL the branch took over. The other roots (`charger`,
 *  `connector`, `state`) read the station or the run and need no CALL. */
export function containsCallReference(value: unknown): boolean {
  if (isFromReference(value)) return value.$from.split(".")[0] === "call";
  if (Array.isArray(value)) return value.some(containsCallReference);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(containsCallReference);
  }
  return false;
}

/**
 * Replace every `{ "$from": "<path>" }` that stands for a whole value in
 * `value` with what the path names (schema 1.5, #566; roots 1.6, #654; 1.7). A
 * path starts at one of five roots:
 *
 * - `response`: `response.kind` (`"result"` / `"error"`), `.action`,
 *   `.messageId`, `.payload.<key>…` (result) or `.errorCode`,
 *   `.errorDescription`, `.errorDetails` (error) of the latest `ocppCall`
 *   answered in this branch;
 * - `call`: `call.action`, `call.messageId`, `call.payload.<key>[.<key>…]` of
 *   the CALL the branch took over (array items by index:
 *   `call.payload.items.0.id`);
 * - `charger`: `id`, `ocppVersion`, `status`, `connectorIds` of the station;
 * - `connector`: `id`, `status`, `availability`, `transactionId`, `idTag`,
 *   `power.acceptedW|offeredW|soc|limitedBy` of the connector the scenario is
 *   bound to, as `ctx.connector()` reports them;
 * - `state`: a key a `setState` node stored in this run.
 *
 * A path that names nothing, or a root that has nothing to read, throws: a
 * missing value must fail the run, not become `undefined` on the wire.
 */
export function resolveFrom(
  value: unknown,
  scope: FromScope,
  where: string,
): unknown {
  if (isFromReference(value)) return readPath(value.$from, scope, where);
  if (Array.isArray(value)) {
    return value.map((item) => resolveFrom(item, scope, where));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = resolveFrom(item, scope, where);
    }
    return out;
  }
  return value;
}

/** {@link resolveFrom} over the root `call` alone (schema 1.5). */
export function resolveFromExchange(
  value: unknown,
  exchange: ScenarioCallExchange | null,
  where: string,
): unknown {
  return resolveFrom(value, { exchange, state: {} }, where);
}

const ROOTS = '"call.", "response.", "charger.", "connector." or "state."';

function readPath(path: string, scope: FromScope, where: string): unknown {
  const [root, ...rest] = path.split(".");
  if (
    (root !== "call" &&
      root !== "response" &&
      root !== "charger" &&
      root !== "connector" &&
      root !== "state") ||
    rest.length === 0
  ) {
    throw new Error(
      `${where}: $from "${path}" must start with ${ROOTS} (for example call.payload.<key>, connector.status or state.<key>)`,
    );
  }
  let current: unknown;
  let owner: string;
  if (root === "call") {
    const exchange = scope.exchange;
    if (!exchange) {
      throw new Error(
        `${where}: $from "${path}" needs a CALL taken over by a csmsCallTrigger with behavior "replace" earlier in this branch`,
      );
    }
    current = {
      action: exchange.action,
      messageId: exchange.messageId,
      payload: exchange.payload,
    };
    owner = `the ${exchange.action} CALL`;
  } else if (root === "response") {
    const response = scope.response;
    if (!response) {
      throw new Error(
        `${where}: $from "${path}" needs the answer to an ocppCall earlier in this branch`,
      );
    }
    current = response;
    owner = `the ${response.action} answer`;
  } else if (root === "state") {
    current = scope.state;
    owner = "the state of this run";
  } else {
    current = scope.station?.(root);
    if (current === undefined || current === null) {
      throw new Error(
        `${where}: $from "${path}" has no ${root} to read${root === "connector" ? " (the scenario is not bound to a connector)" : ""}`,
      );
    }
    owner = `the ${root}`;
  }
  for (const key of rest) {
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.prototype.hasOwnProperty.call(current, key)
    ) {
      throw new Error(`${where}: $from "${path}" names nothing in ${owner}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (current === undefined) {
    throw new Error(`${where}: $from "${path}" names nothing in ${owner}`);
  }
  return current;
}
