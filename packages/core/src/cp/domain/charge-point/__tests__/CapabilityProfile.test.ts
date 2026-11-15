import { describe, expect, it } from "vitest";
import {
  capabilityProfileConflicts,
  disabledActionErrorCode,
  isActionDisabled,
  isTriggerTargetSupported,
  ocpp16FeatureProfileOf,
} from "../CapabilityProfile";

// #791 review follow-ups (PR #811): only the one-to-one pairs are translated
// on 2.x, and the renamed trigger targets are matched across versions.
describe("isActionDisabled", () => {
  it("matches a one-to-one pair across spellings on 2.x", () => {
    const profile = { disabledActions: ["RemoteStartTransaction"] };
    expect(isActionDisabled(profile, "RequestStartTransaction", true)).toBe(
      true,
    );
    expect(isActionDisabled(profile, "RequestStartTransaction", false)).toBe(
      false,
    );
  });

  it("does not let a folded pair switch off the other message", () => {
    expect(
      isActionDisabled(
        { disabledActions: ["ExtendedTriggerMessage"] },
        "TriggerMessage",
        true,
      ),
    ).toBe(false);
    expect(
      isActionDisabled(
        { disabledActions: ["SignedUpdateFirmware"] },
        "UpdateFirmware",
        true,
      ),
    ).toBe(false);
    expect(
      isActionDisabled({ disabledActions: ["GetDiagnostics"] }, "GetLog", true),
    ).toBe(false);
    expect(
      isActionDisabled(
        { disabledActions: ["TriggerMessage"] },
        "TriggerMessage",
        true,
      ),
    ).toBe(true);
  });
});

describe("isTriggerTargetSupported", () => {
  it("translates the renamed targets on 2.x only", () => {
    const profile = {
      triggerMessageTargets: [
        "DiagnosticsStatusNotification",
        "SignChargePointCertificate",
      ],
    };
    expect(
      isTriggerTargetSupported(profile, "LogStatusNotification", true),
    ).toBe(true);
    expect(
      isTriggerTargetSupported(profile, "SignChargingStationCertificate", true),
    ).toBe(true);
    expect(
      isTriggerTargetSupported(profile, "LogStatusNotification", false),
    ).toBe(false);
    expect(isTriggerTargetSupported(profile, "Heartbeat", true)).toBe(false);
    expect(isTriggerTargetSupported({}, "Heartbeat", true)).toBe(true);
  });
});

// #618: the profile against the OCPP 1.6 §3 feature profiles.
describe("capabilityProfileConflicts", () => {
  const ALL = [
    "Core",
    "FirmwareManagement",
    "LocalAuthListManagement",
    "Reservation",
    "SmartCharging",
    "RemoteTrigger",
  ];

  it("maps CSMS-initiated actions to their 1.6 feature profile", () => {
    expect(ocpp16FeatureProfileOf("Reset")).toBe("Core");
    expect(ocpp16FeatureProfileOf("UpdateFirmware")).toBe("FirmwareManagement");
    expect(ocpp16FeatureProfileOf("SendLocalList")).toBe(
      "LocalAuthListManagement",
    );
    expect(ocpp16FeatureProfileOf("ReserveNow")).toBe("Reservation");
    expect(ocpp16FeatureProfileOf("GetCompositeSchedule")).toBe(
      "SmartCharging",
    );
    expect(ocpp16FeatureProfileOf("TriggerMessage")).toBe("RemoteTrigger");
    // Security Whitepaper messages belong to no feature profile.
    expect(ocpp16FeatureProfileOf("ExtendedTriggerMessage")).toBeUndefined();
  });

  it("reports a disabled action whose feature profile is listed", () => {
    const conflicts = capabilityProfileConflicts(
      { disabledActions: ["ReserveNow", "GetLog"] },
      ALL,
    );
    expect(conflicts).toEqual([
      expect.objectContaining({
        kind: "disabledActionInListedProfile",
        action: "ReserveNow",
        featureProfile: "Reservation",
      }),
    ]);
  });

  it("is quiet when the profile is not listed, or the key is absent", () => {
    expect(
      capabilityProfileConflicts({ disabledActions: ["ReserveNow"] }, [
        "Core",
        "RemoteTrigger",
      ]),
    ).toEqual([]);
    expect(
      capabilityProfileConflicts({ disabledActions: ["Reset"] }, undefined),
    ).toEqual([]);
    expect(capabilityProfileConflicts(undefined, ALL)).toEqual([]);
  });

  it("reports trigger targets on a station that cannot receive TriggerMessage", () => {
    expect(
      capabilityProfileConflicts({ triggerMessageTargets: ["Heartbeat"] }, [
        "Core",
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: "triggerTargetsWithoutTriggerMessage",
        reason: "remoteTriggerNotListed",
      }),
    ]);
    expect(
      capabilityProfileConflicts(
        {
          disabledActions: ["TriggerMessage"],
          triggerMessageTargets: ["Heartbeat"],
        },
        ["Core"],
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "triggerTargetsWithoutTriggerMessage",
        reason: "triggerMessageDisabled",
      }),
    ]);
    // [] supports no target: consistent with no TriggerMessage.
    expect(
      capabilityProfileConflicts({ triggerMessageTargets: [] }, ["Core"]),
    ).toEqual([]);
  });

  it("disabledActionErrorCode defaults to NotImplemented", () => {
    expect(disabledActionErrorCode(undefined)).toBe("NotImplemented");
    expect(disabledActionErrorCode({})).toBe("NotImplemented");
    expect(
      disabledActionErrorCode({ disabledActionErrorCode: "NotSupported" }),
    ).toBe("NotSupported");
  });
});
