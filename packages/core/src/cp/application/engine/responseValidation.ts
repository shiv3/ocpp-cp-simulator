import { schemas, validationErrors } from "@ocpp-cp-sim/ocpp/index";
import { V16_TO_V201_CSMS_ACTION } from "../../domain/types/csmsActionNames";
import { isOcpp2Version } from "../../domain/types/OcppVersion";

function responseSchema(
  action: string,
  ocppVersion: string,
): object | undefined {
  const suffix =
    ocppVersion === "OCPP-2.1"
      ? "V21"
      : isOcpp2Version(ocppVersion)
        ? "V201"
        : "V16";
  const table =
    suffix === "V21"
      ? schemas.v21
      : suffix === "V201"
        ? schemas.v201
        : schemas.v16;
  const key = `${action.charAt(0).toLowerCase()}${action.slice(1)}Response${suffix}`;
  return (table as Record<string, object | undefined>)[key];
}

/**
 * Check a response a behavior produced against the bundled JSON schema of
 * `action`'s response. Returns the problems, or `[]` when it is valid or when
 * no schema is bundled for the action (nothing to check against).
 */
export function responseProblems(
  action: string,
  ocppVersion: string,
  response: unknown,
): string[] {
  const schema = responseSchema(action, ocppVersion);
  if (schema === undefined) return [];
  return validationErrors(schema, response);
}

/**
 * The canned response `ctx.accepted` / `ctx.rejected` return: `{ status }`
 * when the response schema takes that status, `{}` for an acceptance whose
 * response has no fields (1.6 `UpdateFirmware`). Throws when the action has
 * no such response on this version. `action` may be spelled as either
 * version spells it.
 */
export function cannedResponse(
  action: string,
  ocppVersion: string,
  kind: "accepted" | "rejected",
): Record<string, unknown> {
  const name = isOcpp2Version(ocppVersion)
    ? (V16_TO_V201_CSMS_ACTION[action] ?? action)
    : action;
  const helper = kind === "accepted" ? "ctx.accepted" : "ctx.rejected";
  const schema = responseSchema(name, ocppVersion);
  if (schema === undefined) {
    throw new Error(
      `${helper}("${action}"): no response schema is bundled for ${name} on ${ocppVersion}`,
    );
  }
  const status = kind === "accepted" ? "Accepted" : "Rejected";
  const candidates: Array<Record<string, unknown>> = [{ status }];
  if (kind === "accepted") candidates.push({});
  for (const candidate of candidates) {
    if (validationErrors(schema, candidate).length === 0) return candidate;
  }
  throw new Error(
    `${helper}("${action}"): the ${name} response on ${ocppVersion} has no ${status} answer; build the response by hand`,
  );
}

/**
 * The `ctx.accepted` / `ctx.rejected` answers of every 1.6 action that has
 * one; the k6 export writes them into the generated project because the k6
 * host has no schemas.
 */
export function cannedResponses16(): Record<
  string,
  { accepted?: Record<string, unknown>; rejected?: Record<string, unknown> }
> {
  const out: Record<
    string,
    { accepted?: Record<string, unknown>; rejected?: Record<string, unknown> }
  > = {};
  for (const key of Object.keys(schemas.v16)) {
    const m = /^(.+)ResponseV16$/.exec(key);
    if (!m) continue;
    const action = `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}`;
    for (const kind of ["accepted", "rejected"] as const) {
      try {
        (out[action] ??= {})[kind] = cannedResponse(action, "OCPP-1.6J", kind);
      } catch {
        // no such answer for this action
      }
    }
    if (Object.keys(out[action] ?? {}).length === 0) delete out[action];
  }
  return out;
}
