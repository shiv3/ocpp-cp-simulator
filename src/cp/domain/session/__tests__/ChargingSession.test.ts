import { describe, expect, it } from "vitest";

import {
  classifyEndedSession,
  deriveDurationMs,
  deriveEnergyWh,
} from "../ChargingSession";

describe("deriveEnergyWh", () => {
  it.each([
    { start: 1000, stop: 4500, expected: 3500 },
    { start: 1000, stop: 1000, expected: 0 },
    { start: 1000, stop: null, expected: null },
    // The register went backwards (an operator `meter_value` set): no
    // meaningful energy, rather than a negative one.
    { start: 4500, stop: 1000, expected: null },
  ])("start $start, stop $stop → $expected", ({ start, stop, expected }) => {
    expect(deriveEnergyWh(start, stop)).toBe(expected);
  });
});

describe("deriveDurationMs", () => {
  it("is the span between start and end", () => {
    expect(
      deriveDurationMs("2026-10-28T10:00:00.000Z", "2026-10-28T10:30:00.000Z"),
    ).toBe(30 * 60_000);
  });

  it("is null while the end is unknown", () => {
    expect(deriveDurationMs("2026-10-28T10:00:00.000Z", null)).toBeNull();
  });

  it("is null when the end precedes the start", () => {
    expect(
      deriveDurationMs("2026-10-28T10:30:00.000Z", "2026-10-28T10:00:00.000Z"),
    ).toBeNull();
  });
});

describe("classifyEndedSession", () => {
  it.each([
    { reason: undefined, expected: "completed" },
    { reason: "Local", expected: "completed" },
    { reason: "Remote", expected: "completed" },
    { reason: "EVDisconnected", expected: "completed" },
    { reason: "Other", expected: "completed" },
    { reason: "EnergyLimitReached", expected: "completed" },
    { reason: "SOCLimitReached", expected: "completed" },
    { reason: "StoppedByEV", expected: "completed" },
    { reason: "EmergencyStop", expected: "interrupted" },
    { reason: "HardReset", expected: "interrupted" },
    { reason: "SoftReset", expected: "interrupted" },
    { reason: "ImmediateReset", expected: "interrupted" },
    { reason: "Reboot", expected: "interrupted" },
    { reason: "PowerLoss", expected: "interrupted" },
    { reason: "UnlockCommand", expected: "interrupted" },
    { reason: "GroundFault", expected: "interrupted" },
    { reason: "OvercurrentFault", expected: "interrupted" },
    { reason: "PowerQuality", expected: "interrupted" },
    { reason: "Timeout", expected: "interrupted" },
    // DeAuthorized without a CSMS rejection on record: the authorization
    // was withdrawn mid-session.
    { reason: "DeAuthorized", expected: "interrupted" },
  ])("reason $reason → $expected", ({ reason, expected }) => {
    expect(classifyEndedSession({ reason, authorizationStatus: null })).toBe(
      expected,
    );
  });

  it("is failed when the CSMS rejected the id and the station stopped on it", () => {
    expect(
      classifyEndedSession({
        reason: "DeAuthorized",
        authorizationStatus: "Invalid",
      }),
    ).toBe("failed");
  });

  it("is interrupted when a 2.x Updated answer withdrew the id mid-session", () => {
    expect(
      classifyEndedSession({
        reason: "DeAuthorized",
        authorizationStatus: "Invalid",
        rejectedMidSession: true,
      }),
    ).toBe("interrupted");
  });

  it("keeps a rejected session that ran to a normal end completed", () => {
    // StopTransactionOnInvalidId=false: the station kept charging.
    expect(
      classifyEndedSession({ reason: "Local", authorizationStatus: "Invalid" }),
    ).toBe("completed");
  });
});
