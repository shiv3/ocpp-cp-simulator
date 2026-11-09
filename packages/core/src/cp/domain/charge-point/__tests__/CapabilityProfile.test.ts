import { describe, expect, it } from "vitest";
import {
  isActionDisabled,
  isTriggerTargetSupported,
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
