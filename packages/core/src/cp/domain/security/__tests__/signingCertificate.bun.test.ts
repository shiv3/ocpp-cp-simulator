import { describe, expect, it } from "bun:test";

import { checkFirmwareSigningCertificate } from "../signingCertificate";
import { selfSignedRoot, signingLeaf } from "./certificateFixtures";

const DAY = 86_400_000;

describe("checkFirmwareSigningCertificate (L01.FR.21 / L01.FR.23)", () => {
  it("accepts a valid certificate", async () => {
    const pem = await signingLeaf();
    expect(checkFirmwareSigningCertificate(pem, new Date())).toEqual({
      ok: true,
    });
  });

  it("refuses garbage and non-strings as Unparsable", () => {
    for (const bad of ["MIIB", "", 42, undefined, null]) {
      expect(checkFirmwareSigningCertificate(bad, new Date())).toMatchObject({
        ok: false,
        problem: "Unparsable",
      });
    }
  });

  it("refuses a certificate outside its validity period", async () => {
    const now = Date.now();
    const expired = await signingLeaf({
      notBefore: new Date(now - 3 * DAY),
      notAfter: new Date(now - DAY),
    });
    const future = await signingLeaf({
      notBefore: new Date(now + DAY),
      notAfter: new Date(now + 3 * DAY),
    });
    expect(checkFirmwareSigningCertificate(expired, new Date())).toMatchObject({
      ok: false,
      problem: "Expired",
    });
    expect(checkFirmwareSigningCertificate(future, new Date())).toMatchObject({
      ok: false,
      problem: "NotYetValid",
    });
  });

  it("requires an installed manufacturer root to be the issuer", async () => {
    const root = await selfSignedRoot("01", "Manufacturer Root");
    const other = await selfSignedRoot("02", "Other Root");
    const issued = await signingLeaf({ issuer: root });
    expect(
      checkFirmwareSigningCertificate(issued, new Date(), [root.pem]),
    ).toEqual({ ok: true });
    expect(
      checkFirmwareSigningCertificate(issued, new Date(), [other.pem]),
    ).toMatchObject({ ok: false, problem: "UntrustedIssuer" });
  });
});
