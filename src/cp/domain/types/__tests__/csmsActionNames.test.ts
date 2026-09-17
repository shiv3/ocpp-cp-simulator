import { describe, expect, it } from "vitest";
import {
  csmsActionAliases,
  csmsActionMatches,
  V16_TO_V201_CSMS_ACTION,
} from "../csmsActionNames";

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

  it("matches a scenario's spelling against the wire's, in either direction", () => {
    expect(
      csmsActionMatches("RemoteStartTransaction", "RequestStartTransaction"),
    ).toBe(true);
    expect(
      csmsActionMatches("RequestStartTransaction", "RemoteStartTransaction"),
    ).toBe(true);
    expect(csmsActionMatches("GetDiagnostics", "GetLog")).toBe(true);
    expect(csmsActionMatches("Reset", "Reset")).toBe(true);
    expect(csmsActionMatches("Reset", "ClearCache")).toBe(false);
    expect(
      csmsActionMatches("RemoteStopTransaction", "RequestStartTransaction"),
    ).toBe(false);
  });

  it("maps only names that differ", () => {
    for (const [v16, v201] of Object.entries(V16_TO_V201_CSMS_ACTION)) {
      expect(v16).not.toBe(v201);
    }
  });
});
