import { oneToOneCsmsActionAliases } from "../types/csmsActionNames";

/**
 * A static description of what a charge point cannot do (#618), set when the
 * station is created (or by a blueprint) and never changed by a scenario.
 *
 * - `disabledActions`: CSMS→CP actions the station does not implement. An
 *   inbound CALL for one is answered with a CALLERROR `NotImplemented`
 *   (OCPP-J 1.6 §4.2.3; the same answer an action with no handler gets).
 * - `triggerMessageTargets`: the message types TriggerMessage and
 *   ExtendedTriggerMessage may request. A target outside the list is answered
 *   `NotImplemented` (1.6 §5.17 / whitepaper ExtendedTriggerMessage; 2.x F06).
 *   `[]` supports none.
 *
 * Absent keys (and an absent profile) change nothing.
 */
export interface ChargePointCapabilityProfile {
  readonly disabledActions?: readonly string[];
  readonly triggerMessageTargets?: readonly string[];
}

/**
 * Is `action` disabled by `profile`? On OCPP 2.x an action is also matched by
 * its 1.6 spelling (`RemoteStartTransaction` for `RequestStartTransaction`),
 * but only for the one-to-one pairs: disabling `ExtendedTriggerMessage` does
 * not switch off the 2.x `TriggerMessage` (#791). On 1.6 only the exact name
 * counts, so disabling `TriggerMessage` leaves `ExtendedTriggerMessage` alone.
 */
export function isActionDisabled(
  profile: ChargePointCapabilityProfile | undefined,
  action: string,
  translateNames: boolean,
): boolean {
  const disabled = profile?.disabledActions;
  if (!disabled || disabled.length === 0) return false;
  const names = translateNames ? oneToOneCsmsActionAliases(action) : [action];
  return names.some((name) => disabled.includes(name));
}

/**
 * The trigger targets spelled differently on 2.x: the 1.6 Security Whitepaper
 * names (`DiagnosticsStatusNotification`, `SignChargePointCertificate`) and
 * their 2.x counterparts. A profile written for one spelling applies to both
 * on 2.x; on 1.6 they are distinct targets and match exactly.
 */
const TRIGGER_TARGET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["DiagnosticsStatusNotification", "LogStatusNotification"],
  ["SignChargePointCertificate", "SignChargingStationCertificate"],
];

function triggerTargetAliases(target: string): readonly string[] {
  const out = [target];
  for (const [a, b] of TRIGGER_TARGET_PAIRS) {
    if (target === a) out.push(b);
    if (target === b) out.push(a);
  }
  return out;
}

/** May TriggerMessage / ExtendedTriggerMessage request `target`? */
export function isTriggerTargetSupported(
  profile: ChargePointCapabilityProfile | undefined,
  target: string,
  translateNames = false,
): boolean {
  const targets = profile?.triggerMessageTargets;
  if (targets === undefined) return true;
  const names = translateNames ? triggerTargetAliases(target) : [target];
  return names.some((name) => targets.includes(name));
}
