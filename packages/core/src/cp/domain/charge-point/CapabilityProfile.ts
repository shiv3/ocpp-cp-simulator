import { csmsActionAliases } from "../types/csmsActionNames";

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
 * as scenario policies are; on 1.6 only the exact name counts, so disabling
 * `TriggerMessage` leaves `ExtendedTriggerMessage` alone.
 */
export function isActionDisabled(
  profile: ChargePointCapabilityProfile | undefined,
  action: string,
  translateNames: boolean,
): boolean {
  const disabled = profile?.disabledActions;
  if (!disabled || disabled.length === 0) return false;
  const names = translateNames ? csmsActionAliases(action) : [action];
  return names.some((name) => disabled.includes(name));
}

/** May TriggerMessage / ExtendedTriggerMessage request `target`? */
export function isTriggerTargetSupported(
  profile: ChargePointCapabilityProfile | undefined,
  target: string,
): boolean {
  const targets = profile?.triggerMessageTargets;
  return targets === undefined || targets.includes(target);
}
