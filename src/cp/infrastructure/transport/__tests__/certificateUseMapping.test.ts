import { describe, expect, it } from "vitest";

import {
  installedCertificateQueryFromV201,
  installedCertificateQueryFromV21,
  installedCertificateQueryToV201,
  installedCertificateQueryToV21,
  rootUseFromV16,
  rootUseFromV201,
  rootUseFromV21,
  rootUseToV16,
  rootUseToV201,
  rootUseToV21,
  signedUseFromV201,
  signedUseFromV21,
  signedUseToV201,
  signedUseToV21,
} from "../certificateUseMapping";
import {
  ROOT_CERTIFICATE_USES,
  SIGNED_CERTIFICATE_USES,
} from "../../../domain/security/certificateUse";

/**
 * #456: the domain keeps a version-neutral superset of certificate uses;
 * each OCPP version maps onto it explicitly and refuses what it does not
 * define. The tables below are the contract, one row per wire value.
 */
describe("certificate use mapping", () => {
  describe("OCPP 1.6 Security Whitepaper", () => {
    it.each([
      ["CentralSystemRootCertificate", "CsmsRootCertificate"],
      ["ManufacturerRootCertificate", "ManufacturerRootCertificate"],
    ] as const)("maps root %s <-> %s", (wire, domain) => {
      expect(rootUseFromV16(wire)).toBe(domain);
      expect(rootUseToV16(domain)).toBe(wire);
    });

    it.each([
      "CSMSRootCertificate",
      "V2GRootCertificate",
      "MORootCertificate",
      "OEMRootCertificate",
      "V2GCertificateChain",
      "CsmsRootCertificate",
      "__proto__",
      "",
    ])("refuses %j inbound", (wire) => {
      expect(rootUseFromV16(wire)).toBeUndefined();
    });

    it.each([
      "V2GRootCertificate",
      "MORootCertificate",
      "OEMRootCertificate",
    ] as const)("has no 1.6 name for %s", (domain) => {
      expect(rootUseToV16(domain)).toBeUndefined();
    });
  });

  describe("OCPP 2.0.1", () => {
    it.each([
      ["CSMSRootCertificate", "CsmsRootCertificate"],
      ["ManufacturerRootCertificate", "ManufacturerRootCertificate"],
      ["V2GRootCertificate", "V2GRootCertificate"],
      ["MORootCertificate", "MORootCertificate"],
    ] as const)("maps root %s <-> %s", (wire, domain) => {
      expect(rootUseFromV201(wire)).toBe(domain);
      expect(rootUseToV201(domain)).toBe(wire);
      expect(installedCertificateQueryFromV201(wire)).toBe(domain);
      expect(installedCertificateQueryToV201(domain)).toBe(wire);
    });

    it("refuses the 2.1-only OEMRootCertificate and the 1.6 name", () => {
      expect(rootUseFromV201("OEMRootCertificate")).toBeUndefined();
      expect(rootUseFromV201("CentralSystemRootCertificate")).toBeUndefined();
      expect(rootUseToV201("OEMRootCertificate")).toBeUndefined();
      expect(
        installedCertificateQueryFromV201("OEMRootCertificate"),
      ).toBeUndefined();
      expect(
        installedCertificateQueryToV201("OEMRootCertificate"),
      ).toBeUndefined();
    });

    it("treats V2GCertificateChain as a GetInstalledCertificateIds query only", () => {
      expect(installedCertificateQueryFromV201("V2GCertificateChain")).toBe(
        "V2GCertificateChain",
      );
      expect(installedCertificateQueryToV201("V2GCertificateChain")).toBe(
        "V2GCertificateChain",
      );
      expect(rootUseFromV201("V2GCertificateChain")).toBeUndefined();
    });

    it.each([
      ["ChargingStationCertificate", "ChargingStationCertificate"],
      ["V2GCertificate", "V2GCertificate"],
    ] as const)("maps signing use %s <-> %s", (wire, domain) => {
      expect(signedUseFromV201(wire)).toBe(domain);
      expect(signedUseToV201(domain)).toBe(wire);
    });

    it("refuses the 2.1-only V2G20Certificate", () => {
      expect(signedUseFromV201("V2G20Certificate")).toBeUndefined();
      expect(signedUseToV201("V2G20Certificate")).toBeUndefined();
    });
  });

  describe("OCPP 2.1", () => {
    it.each([
      ["CSMSRootCertificate", "CsmsRootCertificate"],
      ["ManufacturerRootCertificate", "ManufacturerRootCertificate"],
      ["V2GRootCertificate", "V2GRootCertificate"],
      ["MORootCertificate", "MORootCertificate"],
      ["OEMRootCertificate", "OEMRootCertificate"],
    ] as const)("maps root %s <-> %s", (wire, domain) => {
      expect(rootUseFromV21(wire)).toBe(domain);
      expect(rootUseToV21(domain)).toBe(wire);
      expect(installedCertificateQueryFromV21(wire)).toBe(domain);
      expect(installedCertificateQueryToV21(domain)).toBe(wire);
    });

    it("maps V2GCertificateChain as a query", () => {
      expect(installedCertificateQueryFromV21("V2GCertificateChain")).toBe(
        "V2GCertificateChain",
      );
      expect(installedCertificateQueryToV21("V2GCertificateChain")).toBe(
        "V2GCertificateChain",
      );
    });

    it.each([
      ["ChargingStationCertificate", "ChargingStationCertificate"],
      ["V2GCertificate", "V2GCertificate"],
      ["V2G20Certificate", "V2G20Certificate"],
    ] as const)("maps signing use %s <-> %s", (wire, domain) => {
      expect(signedUseFromV21(wire)).toBe(domain);
      expect(signedUseToV21(domain)).toBe(wire);
    });

    it("refuses the 1.6 root name", () => {
      expect(rootUseFromV21("CentralSystemRootCertificate")).toBeUndefined();
    });
  });

  it("covers every domain use in the newest version", () => {
    for (const use of ROOT_CERTIFICATE_USES) {
      expect(rootUseToV21(use), use).toBeDefined();
    }
    for (const use of SIGNED_CERTIFICATE_USES) {
      expect(signedUseToV21(use), use).toBeDefined();
    }
  });
});
