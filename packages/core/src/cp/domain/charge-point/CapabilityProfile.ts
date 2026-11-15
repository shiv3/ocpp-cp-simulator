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
 * - `disabledActionErrorCode`: the CALLERROR code a disabled action is
 *   answered with. OCPP-J 1.6 §4.2.3 defines `NotImplemented` ("Requested
 *   Action is not known by receiver", the default) and `NotSupported`
 *   ("Requested Action is recognized but not supported by the receiver"); a
 *   station that knows a message but lacks the feature arguably answers the
 *   latter, so the tester picks the one the CSMS under test must handle.
 * - `statusTransitions`: what an OCPP 1.6J station does with a connector
 *   status change the OCPP 1.6 §4.9 transition table does not list. `warn`
 *   (the default) logs it and sends the StatusNotification anyway; `enforce`
 *   updates the local connector but does not send the StatusNotification, so
 *   a CSMS developer can test against a peer that never reports an illegal
 *   transition. A write made with `allowInvalidTransition` is always sent.
 *
 * Absent keys (and an absent profile) change nothing.
 */
export interface ChargePointCapabilityProfile {
  readonly disabledActions?: readonly string[];
  readonly triggerMessageTargets?: readonly string[];
  readonly disabledActionErrorCode?: DisabledActionErrorCode;
  readonly statusTransitions?: StatusTransitionMode;
}

/** The OCPP-J 1.6 §4.2.3 codes a disabled action may be answered with. */
export const DISABLED_ACTION_ERROR_CODES = [
  "NotImplemented",
  "NotSupported",
] as const;
export type DisabledActionErrorCode =
  (typeof DISABLED_ACTION_ERROR_CODES)[number];

/** See {@link ChargePointCapabilityProfile.statusTransitions}. */
export const STATUS_TRANSITION_MODES = ["warn", "enforce"] as const;
export type StatusTransitionMode = (typeof STATUS_TRANSITION_MODES)[number];

/** The CALLERROR code for a disabled action; `NotImplemented` by default. */
export function disabledActionErrorCode(
  profile: ChargePointCapabilityProfile | undefined,
): DisabledActionErrorCode {
  return profile?.disabledActionErrorCode ?? "NotImplemented";
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

/**
 * The CSMS-initiated messages of each OCPP 1.6 feature profile (OCPP 1.6
 * edition 2, §3 "Feature Profiles"), keyed by the name the
 * `SupportedFeatureProfiles` configuration key uses. Messages the station
 * initiates (BootNotification, StatusNotification, ...) and the Security
 * Whitepaper messages (ExtendedTriggerMessage, GetLog, ...) belong to no
 * profile a station could leave out, and are not listed.
 */
export const OCPP16_FEATURE_PROFILE_CSMS_ACTIONS: Readonly<
  Record<string, readonly string[]>
> = {
  Core: [
    "ChangeAvailability",
    "ChangeConfiguration",
    "ClearCache",
    "DataTransfer",
    "GetConfiguration",
    "RemoteStartTransaction",
    "RemoteStopTransaction",
    "Reset",
    "UnlockConnector",
  ],
  FirmwareManagement: ["GetDiagnostics", "UpdateFirmware"],
  LocalAuthListManagement: ["GetLocalListVersion", "SendLocalList"],
  Reservation: ["CancelReservation", "ReserveNow"],
  SmartCharging: [
    "ClearChargingProfile",
    "GetCompositeSchedule",
    "SetChargingProfile",
  ],
  RemoteTrigger: ["TriggerMessage"],
};

/** The 1.6 feature profile `action` belongs to, if any. */
export function ocpp16FeatureProfileOf(action: string): string | undefined {
  return Object.keys(OCPP16_FEATURE_PROFILE_CSMS_ACTIONS).find((profile) =>
    OCPP16_FEATURE_PROFILE_CSMS_ACTIONS[profile]?.includes(action),
  );
}

/** One way a capability profile contradicts `SupportedFeatureProfiles`. */
export type CapabilityProfileConflict =
  | {
      /** A disabled action belongs to a feature profile the key lists. */
      readonly kind: "disabledActionInListedProfile";
      readonly action: string;
      readonly featureProfile: string;
      readonly message: string;
    }
  | {
      /** `triggerMessageTargets` names targets, but the station cannot
       *  receive a TriggerMessage: it is disabled, or RemoteTrigger is not
       *  listed. */
      readonly kind: "triggerTargetsWithoutTriggerMessage";
      readonly reason: "triggerMessageDisabled" | "remoteTriggerNotListed";
      readonly message: string;
    };

/**
 * Where an OCPP 1.6 capability profile and the `SupportedFeatureProfiles`
 * configuration key disagree. A station that advertises a feature profile
 * claims every message in it (OCPP 1.6 §3), so disabling one of those
 * messages, or listing TriggerMessage targets on a station that cannot
 * receive a TriggerMessage, describes a charge point the CSMS cannot reason
 * about from the key alone. Nothing is rejected (existing setups keep
 * working); the station logs each conflict.
 *
 * `supportedFeatureProfiles` undefined (the key is absent): nothing to compare
 * with, no conflict.
 */
export function capabilityProfileConflicts(
  profile: ChargePointCapabilityProfile | undefined,
  supportedFeatureProfiles: readonly string[] | undefined,
): CapabilityProfileConflict[] {
  if (!profile || supportedFeatureProfiles === undefined) return [];
  const listed = new Set(supportedFeatureProfiles.map((p) => p.trim()));
  const out: CapabilityProfileConflict[] = [];
  for (const action of profile.disabledActions ?? []) {
    const featureProfile = ocpp16FeatureProfileOf(action);
    if (featureProfile !== undefined && listed.has(featureProfile)) {
      out.push({
        kind: "disabledActionInListedProfile",
        action,
        featureProfile,
        message: `capabilityProfile disables ${action}, but SupportedFeatureProfiles lists ${featureProfile}, which includes it (OCPP 1.6 §3)`,
      });
    }
  }
  const targets = profile.triggerMessageTargets;
  if (targets !== undefined && targets.length > 0) {
    if (profile.disabledActions?.includes("TriggerMessage")) {
      out.push({
        kind: "triggerTargetsWithoutTriggerMessage",
        reason: "triggerMessageDisabled",
        message:
          "capabilityProfile lists triggerMessageTargets, but disables TriggerMessage",
      });
    } else if (!listed.has("RemoteTrigger")) {
      out.push({
        kind: "triggerTargetsWithoutTriggerMessage",
        reason: "remoteTriggerNotListed",
        message:
          "capabilityProfile lists triggerMessageTargets, but SupportedFeatureProfiles does not list RemoteTrigger (OCPP 1.6 §3)",
      });
    }
  }
  return out;
}
