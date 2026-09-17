/**
 * CSMS→CP action names across OCPP versions (#349).
 *
 * Scenario nodes (`csmsCallTrigger`, `responseOverride`, `inboundPolicy`)
 * name the action they wait for or act on. Those names were spelled in
 * OCPP 1.6, and a 2.0.1 station receives `RequestStartTransaction`, not
 * `RemoteStartTransaction`, so the same scenario could not express the
 * same intent under `--ocpp-version OCPP-2.0.1`. The version-agnostic rule
 * ([docs](../../../../docs/concepts/ocpp-versions-and-transports.md#version-agnostic-scenarios))
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

/** Does `expected` (as a scenario spells it) name the action `actual` (as the
 *  wire spelled it), in either version's vocabulary? */
export function csmsActionMatches(expected: string, actual: string): boolean {
  return csmsActionAliases(actual).includes(expected);
}
