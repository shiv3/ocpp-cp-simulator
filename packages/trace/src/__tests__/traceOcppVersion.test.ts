import { describe, expect, it } from "vitest";
import { toTraceOcppVersion } from "../traceOcppVersion";

describe("toTraceOcppVersion", () => {
  it.each([
    ["OCPP-1.2", "1.2"],
    ["OCPP-1.5", "1.5"],
    ["OCPP-1.6J", "1.6"],
    ["OCPP-1.6S", "1.6"],
    ["OCPP-2.0.1", "2.0.1"],
    ["OCPP-2.1", "2.1"],
  ])("maps %s to %s", (ocppVersion, expected) => {
    expect(toTraceOcppVersion(ocppVersion)).toBe(expected);
  });

  it("falls back to 1.6 for an unset version, like parseOcppVersion", () => {
    expect(toTraceOcppVersion(undefined)).toBe("1.6");
  });
});
