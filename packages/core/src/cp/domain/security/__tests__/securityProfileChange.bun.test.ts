import { describe, expect, it } from "bun:test";

import {
  checkSecurityProfileChange,
  isCertificateCurrentlyValid,
  isValidAuthorizationKey,
  type SecurityProfileChangeInput,
} from "../securityProfileChange";
import { selfSignedRoot } from "./certificateFixtures";

const KEY = "00112233445566778899aabbccddeeff";

const ready: SecurityProfileChangeInput = {
  current: 0,
  next: 1,
  authorizationKey: KEY,
  hasCentralSystemRoot: true,
  hasChargePointCertificate: true,
};

describe("checkSecurityProfileChange (whitepaper A05)", () => {
  it.each([
    [3, 2],
    [2, 2],
    [3, 3],
  ])("refuses %i → %i (A05.FR.01)", (current, next) => {
    expect(
      checkSecurityProfileChange({ ...ready, current, next }),
    ).toMatchObject({ allowed: false, requirement: "A05.FR.01" });
  });

  it.each([
    [2, 1],
    [3, 1],
    [1, 0],
    [2, 0],
  ])("refuses lowering %i → %i (A00.FR.005)", (current, next) => {
    expect(
      checkSecurityProfileChange({ ...ready, current, next }),
    ).toMatchObject({ allowed: false, requirement: "A00.FR.005" });
  });

  it.each([
    [0, 0],
    [1, 1],
  ])("allows the unchanged %i → %i without an upgrade", (current, next) => {
    expect(checkSecurityProfileChange({ ...ready, current, next })).toEqual({
      allowed: true,
      upgrade: false,
    });
  });

  it.each([1, 2])(
    "refuses an upgrade to %i without a valid AuthorizationKey (A05.FR.02)",
    (next) => {
      for (const authorizationKey of [
        "",
        "short",
        KEY.slice(1),
        `${KEY}00000`,
      ]) {
        expect(
          checkSecurityProfileChange({ ...ready, next, authorizationKey }),
        ).toMatchObject({ allowed: false, requirement: "A05.FR.02" });
      }
    },
  );

  it.each([2, 3])(
    "refuses an upgrade to %i without a CentralSystemRootCertificate (A05.FR.03)",
    (next) => {
      expect(
        checkSecurityProfileChange({
          ...ready,
          next,
          hasCentralSystemRoot: false,
        }),
      ).toMatchObject({ allowed: false, requirement: "A05.FR.03" });
    },
  );

  it("refuses an upgrade to 3 without a ChargePointCertificate (A05.FR.04)", () => {
    expect(
      checkSecurityProfileChange({
        ...ready,
        next: 3,
        authorizationKey: "",
        hasChargePointCertificate: false,
      }),
    ).toMatchObject({ allowed: false, requirement: "A05.FR.04" });
  });

  it("allows an upgrade whose prerequisites are met (A05.FR.05)", () => {
    expect(checkSecurityProfileChange({ ...ready, next: 1 })).toEqual({
      allowed: true,
      upgrade: true,
    });
    expect(
      checkSecurityProfileChange({ ...ready, current: 1, next: 2 }),
    ).toEqual({ allowed: true, upgrade: true });
    // Profile 3 authenticates with the certificate, not the key.
    expect(
      checkSecurityProfileChange({
        ...ready,
        current: 2,
        next: 3,
        authorizationKey: "",
      }),
    ).toEqual({ allowed: true, upgrade: true });
  });
});

describe("isValidAuthorizationKey (§7.2)", () => {
  it("takes 16 to 20 bytes written as hex (32 to 40 digits)", () => {
    expect(isValidAuthorizationKey("ab".repeat(16))).toBe(true);
    expect(isValidAuthorizationKey("AB".repeat(20))).toBe(true);
    expect(isValidAuthorizationKey("ab".repeat(15))).toBe(false);
    expect(isValidAuthorizationKey("ab".repeat(21))).toBe(false);
    expect(isValidAuthorizationKey("zz".repeat(16))).toBe(false);
    // The plain 16-20 character form the connection code also accepts (#839).
    expect(isValidAuthorizationKey("correct-horse-1234")).toBe(true);
    expect(isValidAuthorizationKey("short-key")).toBe(false);
    expect(isValidAuthorizationKey("has space in key!!!")).toBe(false);
  });
});

describe("isCertificateCurrentlyValid", () => {
  it("checks the validity period of the first certificate", async () => {
    const day = 86_400_000;
    const { pem } = await selfSignedRoot("01", "Root");
    expect(isCertificateCurrentlyValid(pem, new Date())).toBe(true);
    expect(
      isCertificateCurrentlyValid(pem, new Date(Date.now() + 2 * day)),
    ).toBe(false);
    expect(isCertificateCurrentlyValid("garbage", new Date())).toBe(false);
  });
});
