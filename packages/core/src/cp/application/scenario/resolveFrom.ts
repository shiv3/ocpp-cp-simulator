import type { ScenarioCallExchange } from "./ScenarioTypes";

/** A whole value that reads from the CALL of the branch: `{ "$from": "call.payload.requestId" }`. */
function isFromReference(value: unknown): value is { $from: string } {
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

/**
 * Replace every `{ "$from": "<path>" }` that stands for a whole value in
 * `value` with what the path names on the CALL `exchange` holds (schema 1.5,
 * #566). Paths start at `call`: `call.action`, `call.messageId`,
 * `call.payload.<key>[.<key>…]`; array items are addressed by index
 * (`call.payload.items.0.id`). A path that names nothing, or a `$from` with no
 * CALL to read, throws: a missing value must fail the run, not become
 * `undefined` on the wire.
 */
export function resolveFromExchange(
  value: unknown,
  exchange: ScenarioCallExchange | null,
  where: string,
): unknown {
  if (isFromReference(value)) {
    if (!exchange) {
      throw new Error(
        `${where}: $from "${value.$from}" needs a CALL taken over by a csmsCallTrigger with behavior "replace" earlier in this branch`,
      );
    }
    return readPath(value.$from, exchange, where);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveFromExchange(item, exchange, where));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = resolveFromExchange(item, exchange, where);
    }
    return out;
  }
  return value;
}

function readPath(
  path: string,
  exchange: ScenarioCallExchange,
  where: string,
): unknown {
  const [root, ...rest] = path.split(".");
  if (root !== "call" || rest.length === 0) {
    throw new Error(
      `${where}: $from "${path}" must start with "call." (call.action, call.messageId or call.payload.<key>)`,
    );
  }
  let current: unknown = {
    action: exchange.action,
    messageId: exchange.messageId,
    payload: exchange.payload,
  };
  for (const key of rest) {
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.prototype.hasOwnProperty.call(current, key)
    ) {
      throw new Error(
        `${where}: $from "${path}" names nothing in the ${exchange.action} CALL`,
      );
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (current === undefined) {
    throw new Error(
      `${where}: $from "${path}" names nothing in the ${exchange.action} CALL`,
    );
  }
  return current;
}
