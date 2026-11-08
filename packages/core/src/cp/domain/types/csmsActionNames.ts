import { isOcpp2Version } from "./OcppVersion";

/**
 * CSMS→CP action names across OCPP versions (#349).
 *
 * Scenario nodes (`csmsCallTrigger`, `responseOverride`, `inboundPolicy`)
 * name the action they wait for or act on. Those names were spelled in
 * OCPP 1.6, and a 2.0.1 station receives `RequestStartTransaction`, not
 * `RemoteStartTransaction`, so the same scenario could not express the
 * same intent under `--ocpp-version OCPP-2.0.1`. The version-agnostic rule
 * ([docs](../../../../../../docs/concepts/ocpp-versions-and-transports.md#version-agnostic-scenarios))
 * says the engine translates; this table is that translation, for the pairs
 * whose spelling differs. Every other CSMS→CP action is spelled identically in
 * both versions and needs no row.
 */
export const V16_TO_V201_CSMS_ACTION: Readonly<Record<string, string>> = {
  RemoteStartTransaction: "RequestStartTransaction",
  RemoteStopTransaction: "RequestStopTransaction",
  ChangeConfiguration: "SetVariables",
  GetConfiguration: "GetVariables",
  GetDiagnostics: "GetLog",
  // 1.6 Security Whitepaper names; in 2.0.1 they are the base messages.
  SignedUpdateFirmware: "UpdateFirmware",
  ExtendedTriggerMessage: "TriggerMessage",
};

const V201_TO_V16: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const [v16, v201] of Object.entries(V16_TO_V201_CSMS_ACTION)) {
    out.set(v201, [...(out.get(v201) ?? []), v16]);
  }
  return out;
})();

/**
 * Every spelling that names the same CSMS→CP action as `action`, `action`
 * itself first. `"RequestStartTransaction"` → `["RequestStartTransaction",
 * "RemoteStartTransaction"]`; `"Reset"` → `["Reset"]`.
 */
export function csmsActionAliases(action: string): readonly string[] {
  const out = [action];
  const v201 = V16_TO_V201_CSMS_ACTION[action];
  if (v201 !== undefined && v201 !== action) out.push(v201);
  for (const v16 of V201_TO_V16.get(action) ?? []) {
    if (!out.includes(v16)) out.push(v16);
  }
  return out;
}

/**
 * Does `expected` (as a scenario spells it) name the action `actual` (as the
 * wire spelled it)? Translation applies only on a 2.x station: on 1.6 the
 * "folded" pairs — `GetDiagnostics` / `GetLog`, `TriggerMessage` /
 * `ExtendedTriggerMessage`, `UpdateFirmware` / `SignedUpdateFirmware` — are
 * distinct messages on the same wire, so a 1.6 node must keep matching
 * exactly what it names.
 */
export function csmsActionMatches(
  expected: string,
  actual: string,
  ocppVersion: string,
): boolean {
  if (!translatesCsmsActionNames(ocppVersion)) return expected === actual;
  return csmsActionAliases(actual).includes(expected);
}

/**
 * The 1.6 actions whose 2.x spelling is one-to-one: nothing else is spelled
 * the 2.x way on 1.6, so a name in the other vocabulary is unambiguous there.
 * (The folded pairs, `GetDiagnostics` / `GetLog` and the like, are distinct
 * messages on 1.6.)
 */
const ONE_TO_ONE_V16: ReadonlySet<string> = new Set([
  "RemoteStartTransaction",
  "RemoteStopTransaction",
  "ChangeConfiguration",
  "GetConfiguration",
]);

/**
 * `action` and its other-version spelling, for the one-to-one pairs only
 * (`RequestStartTransaction` / `RemoteStartTransaction`). The folded pairs
 * (`TriggerMessage` / `ExtendedTriggerMessage`, `GetLog` / `GetDiagnostics`,
 * `UpdateFirmware` / `SignedUpdateFirmware`) stay apart: they are different
 * messages, and naming one must not switch the other off (#791).
 */
export function oneToOneCsmsActionAliases(action: string): readonly string[] {
  const out = [action];
  for (const v16 of ONE_TO_ONE_V16) {
    const v201 = V16_TO_V201_CSMS_ACTION[v16];
    if (action === v16 && !out.includes(v201)) out.push(v201);
    if (action === v201 && !out.includes(v16)) out.push(v16);
  }
  return out;
}

/**
 * Like {@link csmsActionMatches}, for the rules of code behaviors, whose
 * contract accepts an action "in either OCPP version's spelling": on 1.6 the
 * 2.x name of a one-to-one pair (`RequestStartTransaction`) names the 1.6
 * action (`RemoteStartTransaction`) too.
 */
export function behaviorActionMatches(
  expected: string,
  actual: string,
  ocppVersion: string,
): boolean {
  if (csmsActionMatches(expected, actual, ocppVersion)) return true;
  return (
    !translatesCsmsActionNames(ocppVersion) &&
    ONE_TO_ONE_V16.has(actual) &&
    V16_TO_V201_CSMS_ACTION[actual] === expected
  );
}

/** OCPP 2.x JSON stations translate; 1.x (JSON and SOAP) spell 1.6. */
export function translatesCsmsActionNames(ocppVersion: string): boolean {
  return isOcpp2Version(ocppVersion);
}

/**
 * 2.0.1 actions whose CALLRESULT is not `{ status }`, so a `responseOverride`
 * armed under their 1.6 alias (`ChangeConfiguration` / `GetConfiguration`)
 * cannot be honoured: the handler ignores it with a warning instead of
 * sending a schema-invalid answer.
 */
export const V201_ACTIONS_WITHOUT_STATUS_RESPONSE: ReadonlySet<string> =
  new Set(["SetVariables", "GetVariables"]);
