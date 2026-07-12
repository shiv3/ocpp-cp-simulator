import { describe, expect, test } from "bun:test";
import {
  authNote,
  formatAvailableLine,
  formatUnavailableLine,
  type ProbeOutcome,
} from "../capability-probe";

// capability-probe.ts's HTTP-driven functions (probeGet/probeOperationsInvalid/
// probeCapabilities/printCapabilityProbe) are exercised live against a
// running SteVe 3.13.0 instead of mocked here -- same split as
// steve-api.ts's buildOperationBody() vs. SteveApiOps#op() (see the #184
// Task 4 report for the live capture). These tests pin the pure line
// formatters against synthetic ProbeOutcomes.

const http = (status: number): ProbeOutcome => ({ kind: "http", status });
const error = (message: string): ProbeOutcome => ({ kind: "error", message });

describe("authNote", () => {
  test("401 gets a pointer to the known auth causes", () => {
    expect(authNote(401)).toMatch(/STEVE_API_USER/);
  });

  test("any other status has no auth note", () => {
    expect(authNote(200)).toBeUndefined();
    expect(authNote(403)).toBeUndefined();
    expect(authNote(500)).toBeUndefined();
  });
});

describe("formatAvailableLine", () => {
  const isOperationsSuccess = (status: number) =>
    status === 400 || (status >= 200 && status < 300);
  const isGetSuccess = (status: number) => status >= 200 && status < 300;

  test("operations probe: 400 (validation-rejected empty chargeBoxIdList) -> available", () => {
    expect(
      formatAvailableLine(
        "SteVe API operations",
        http(400),
        isOperationsSuccess,
      ),
    ).toBe("SteVe API operations: available");
  });

  test("operations probe: 200 (some future SteVe accepting an empty list) -> available", () => {
    expect(
      formatAvailableLine(
        "SteVe API operations",
        http(200),
        isOperationsSuccess,
      ),
    ).toBe("SteVe API operations: available");
  });

  test("GET probe: 200 -> available", () => {
    expect(
      formatAvailableLine("Transaction API", http(200), isGetSuccess),
    ).toBe("Transaction API: available");
  });

  test("401 -> unknown, with the auth-cause hint inlined", () => {
    expect(formatAvailableLine("OCPP tag API", http(401), isGetSuccess)).toBe(
      'OCPP tag API: unknown (unexpected HTTP 401 -- check STEVE_API_USER/STEVE_API_PASS, or web_user.api_password seeding -- see README\'s "Environment / configuration" section)',
    );
  });

  test("an unexpected status -> unknown, no auth hint for non-401", () => {
    expect(
      formatAvailableLine("Transaction API", http(500), isGetSuccess),
    ).toBe("Transaction API: unknown (unexpected HTTP 500)");
  });

  test("a network/timeout error -> unknown (probe failed: <message>), never throws", () => {
    expect(
      formatAvailableLine(
        "SteVe API operations",
        error("fetch failed: ECONNREFUSED"),
        isOperationsSuccess,
      ),
    ).toBe(
      "SteVe API operations: unknown (probe failed: fetch failed: ECONNREFUSED)",
    );
  });
});

describe("formatUnavailableLine", () => {
  test("403 (filter-chain reject, no such controller) -> unavailable, using the documented fallback", () => {
    expect(
      formatUnavailableLine(
        "Reservation query API",
        http(403),
        "DB fallback",
        "steve-community/steve#2074",
      ),
    ).toBe(
      "Reservation query API: unavailable, using DB fallback (steve-community/steve#2074)",
    );
  });

  test("404 (routing miss) is treated the same as 403 -- both confirm no such endpoint", () => {
    expect(
      formatUnavailableLine(
        "Charge point provisioning API",
        http(404),
        "DB fallback",
        "steve-community/steve#2068",
      ),
    ).toBe(
      "Charge point provisioning API: unavailable, using DB fallback (steve-community/steve#2068)",
    );
  });

  test("a 2xx flips the line to available(!) instead of silently repeating the known gap", () => {
    expect(
      formatUnavailableLine(
        "Charging Profile API",
        http(200),
        "UI fallback",
        "steve-community/steve#2069",
      ),
    ).toBe(
      "Charging Profile API: available (!) -- SteVe now appears to expose this endpoint; " +
        "this runner's UI fallback (tracked at steve-community/steve#2069) may be retireable, worth a follow-up",
    );
  });

  test("401 -> unknown, with the auth-cause hint inlined (same as formatAvailableLine)", () => {
    expect(
      formatUnavailableLine(
        "Reservation query API",
        http(401),
        "DB fallback",
        "steve-community/steve#2074",
      ),
    ).toBe(
      'Reservation query API: unknown (unexpected HTTP 401 -- check STEVE_API_USER/STEVE_API_PASS, or web_user.api_password seeding -- see README\'s "Environment / configuration" section)',
    );
  });

  test("a network/timeout error -> unknown (probe failed: <message>), never throws", () => {
    expect(
      formatUnavailableLine(
        "Charge point provisioning API",
        error("timed out"),
        "DB fallback",
        "steve-community/steve#2068",
      ),
    ).toBe("Charge point provisioning API: unknown (probe failed: timed out)");
  });
});
