import { describe, expect, it } from "vitest";
import {
  csmsActionAliases,
  csmsActionMatches,
  V16_TO_V201_CSMS_ACTION,
  V201_ACTIONS_WITHOUT_STATUS_RESPONSE,
} from "../csmsActionNames";

const v201 = "OCPP-2.0.1";
const v16 = "OCPP-1.6J";

describe("CSMS→CP action names across versions (#349)", () => {
  it("lists an action under both spellings, its own first", () => {
    expect(csmsActionAliases("RequestStartTransaction")).toEqual([
      "RequestStartTransaction",
      "RemoteStartTransaction",
    ]);
    expect(csmsActionAliases("RemoteStartTransaction")).toEqual([
      "RemoteStartTransaction",
      "RequestStartTransaction",
    ]);
    expect(csmsActionAliases("Reset")).toEqual(["Reset"]);
  });

  it("collects every 1.6 name that folds into one 2.0.1 message", () => {
    expect(csmsActionAliases("UpdateFirmware")).toEqual([
      "UpdateFirmware",
      "SignedUpdateFirmware",
    ]);
    expect(csmsActionAliases("TriggerMessage")).toEqual([
      "TriggerMessage",
      "ExtendedTriggerMessage",
    ]);
  });

  it("matches a scenario's spelling against the wire's on a 2.x station", () => {
    expect(
      csmsActionMatches(
        "RemoteStartTransaction",
        "RequestStartTransaction",
        v201,
      ),
    ).toBe(true);
    expect(
      csmsActionMatches(
        "RequestStartTransaction",
        "RemoteStartTransaction",
        v201,
      ),
    ).toBe(true);
    expect(csmsActionMatches("GetDiagnostics", "GetLog", v201)).toBe(true);
    expect(csmsActionMatches("Reset", "Reset", v201)).toBe(true);
    expect(csmsActionMatches("Reset", "ClearCache", v201)).toBe(false);
    expect(
      csmsActionMatches(
        "RemoteStopTransaction",
        "RequestStartTransaction",
        v201,
      ),
    ).toBe(false);
    expect(
      csmsActionMatches("TriggerMessage", "ExtendedTriggerMessage", "OCPP-2.1"),
    ).toBe(true);
  });

  it("does not translate on a 1.6 station, where the folded pairs are distinct messages", () => {
    expect(
      csmsActionMatches("TriggerMessage", "ExtendedTriggerMessage", v16),
    ).toBe(false);
    expect(csmsActionMatches("GetDiagnostics", "GetLog", v16)).toBe(false);
    expect(
      csmsActionMatches("UpdateFirmware", "SignedUpdateFirmware", v16),
    ).toBe(false);
    expect(
      csmsActionMatches(
        "RemoteStartTransaction",
        "RequestStartTransaction",
        v16,
      ),
    ).toBe(false);
    expect(csmsActionMatches("Reset", "Reset", v16)).toBe(true);
    expect(csmsActionMatches("Reset", "Reset", "OCPP-1.6S")).toBe(true);
  });

  it("maps only names that differ", () => {
    for (const [v16Name, v201Name] of Object.entries(V16_TO_V201_CSMS_ACTION)) {
      expect(v16Name).not.toBe(v201Name);
    }
  });

  it("names the 2.0.1 answers a canned { status } cannot stand in for", () => {
    expect([...V201_ACTIONS_WITHOUT_STATUS_RESPONSE].sort()).toEqual([
      "GetVariables",
      "SetVariables",
    ]);
  });
});
