import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";

import { CertificateStore } from "../CertificateStore";
import { leafForCsr, selfSignedRoot, subCa } from "./certificateFixtures";

// #587, A02.FR.06: validity of every chain member, Certificate Properties
// (A00.FR.501-511) and operator hierarchy.

const USE = "ChargingStationCertificate";

async function stationWithCsmsRoot() {
  const store = new CertificateStore();
  const root = await selfSignedRoot("01", "CSO Root");
  await store.installRootCertificate("CsmsRootCertificate", root.pem, {
    maxEntries: 10,
  });
  const csr = await store.generateNewCsr("CP-1", "Example CPO");
  return { store, root, csr };
}

describe("CertificateStore.applySignedChain: A02.FR.06 beyond the leaf validity", () => {
  it("accepts a leaf signed by an installed root", async () => {
    const { store, root, csr } = await stationWithCsmsRoot();
    const leaf = await leafForCsr("02", csr, root);
    expect(await store.applySignedChain(USE, [leaf])).toMatchObject({
      status: "Accepted",
    });
  });

  it("accepts a leaf under a sub-CA under an installed root", async () => {
    const { store, root, csr } = await stationWithCsmsRoot();
    const sub = await subCa("03", "CSO Sub", root);
    const leaf = await leafForCsr("02", csr, sub);
    expect(await store.applySignedChain(USE, [leaf, sub.pem])).toMatchObject({
      status: "Accepted",
    });
  });

  it("rejects an expired sub-CA although the leaf is valid", async () => {
    const { store, root, csr } = await stationWithCsmsRoot();
    const sub = await subCa("03", "CSO Sub", root, {
      notBeforeOffsetMs: -86_400_000,
      notAfterOffsetMs: -1_000,
    });
    const leaf = await leafForCsr("02", csr, sub);
    expect(await store.applySignedChain(USE, [leaf, sub.pem])).toMatchObject({
      status: "Expired",
      reason: "the chain member 1 has expired",
    });
    expect(store.pendingCsr(USE)).toBe(csr);
    expect(store.listSignedChains()).toEqual([]);
  });

  it("rejects a sub-CA that is not valid yet", async () => {
    const { store, root, csr } = await stationWithCsmsRoot();
    const sub = await subCa("03", "CSO Sub", root, {
      notBeforeOffsetMs: 3_600_000,
      notAfterOffsetMs: 7_200_000,
    });
    const leaf = await leafForCsr("02", csr, sub);
    expect(await store.applySignedChain(USE, [leaf, sub.pem])).toMatchObject({
      status: "NotYetValid",
    });
  });

  it("rejects a leaf issued by a CA outside the installed hierarchy", async () => {
    const { store, csr } = await stationWithCsmsRoot();
    const stranger = await selfSignedRoot("09", "Invalid Signing CA");
    const leaf = await leafForCsr("02", csr, stranger);
    expect(await store.applySignedChain(USE, [leaf])).toMatchObject({
      status: "OutsideHierarchy",
    });
    expect(store.listSignedChains()).toEqual([]);
    expect(store.pendingCsr(USE)).toBe(csr);
  });

  it("rejects a chain whose members are not signed link by link", async () => {
    const { store, root, csr } = await stationWithCsmsRoot();
    const sub = await subCa("03", "CSO Sub", root);
    // Same subject as `sub`, different key: the issuer name matches, the
    // signature does not.
    const impostor = await subCa("04", "CSO Sub", root);
    const leaf = await leafForCsr("02", csr, sub);
    expect(
      await store.applySignedChain(USE, [leaf, impostor.pem]),
    ).toMatchObject({ status: "OutsideHierarchy" });
  });

  it("checks the hierarchy of a V2G certificate against V2G roots only", async () => {
    const store = new CertificateStore();
    const csmsRoot = await selfSignedRoot("01", "CSO Root");
    await store.installRootCertificate("CsmsRootCertificate", csmsRoot.pem, {
      maxEntries: 10,
    });
    const v2gRoot = await selfSignedRoot("05", "V2G Root");
    await store.installRootCertificate("V2GRootCertificate", v2gRoot.pem, {
      maxEntries: 10,
    });
    const csr = await store.generateNewCsr(
      "CP-1",
      "Example CPO",
      undefined,
      "V2GCertificate",
    );
    // Signed by the CSMS root: not the V2G hierarchy.
    const wrong = await leafForCsr("02", csr, csmsRoot);
    expect(
      await store.applySignedChain("V2GCertificate", [wrong]),
    ).toMatchObject({ status: "OutsideHierarchy" });
    const right = await leafForCsr("03", csr, v2gRoot);
    expect(
      await store.applySignedChain("V2GCertificate", [right]),
    ).toMatchObject({ status: "Accepted" });
  });

  it("checks only the chain's own links when no root of the hierarchy is installed", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "CSO Root");
    const csr = await store.generateNewCsr("CP-1", "Example CPO");
    const leaf = await leafForCsr("02", csr, root);
    expect(await store.applySignedChain(USE, [leaf])).toMatchObject({
      status: "Accepted",
    });
  });

  describe("Certificate Properties", () => {
    it.each([
      ["no organization", "CN=CP-1", "A00.FR.509"],
      [
        "a URL as commonName",
        "CN=wss://csms.example.com,O=Example",
        "A00.FR.511",
      ],
      ["an IPv4 address as commonName", "CN=192.0.2.7,O=Example", "A00.FR.511"],
      [
        "an IPv6 address as commonName",
        "CN=2001:db8::1,O=Example",
        "A00.FR.511",
      ],
      ["no commonName", "O=Example", "A00.FR.511"],
    ])("rejects a leaf with %s", async (_label, subject, clause) => {
      const { store, root, csr } = await stationWithCsmsRoot();
      const leaf = await leafForCsr("02", csr, root, { subject });
      const outcome = await store.applySignedChain(USE, [leaf]);
      expect(outcome).toMatchObject({ status: "InvalidProperties" });
      expect(JSON.stringify(outcome)).toContain(clause);
      expect(store.listSignedChains()).toEqual([]);
    });

    it("does not ask a V2G certificate for a station serial as commonName", async () => {
      const store = new CertificateStore();
      const root = await selfSignedRoot("01", "V2G Root");
      const csr = await store.generateNewCsr(
        "CP-1",
        "Example CPO",
        undefined,
        "V2GCertificate",
      );
      const leaf = await leafForCsr("02", csr, root, {
        subject: "CN=DE*ABC*E1234,O=Example",
      });
      expect(
        await store.applySignedChain("V2GCertificate", [leaf]),
      ).toMatchObject({ status: "Accepted" });
    });

    it("rejects an RSA key below 2048 bits (A00.FR.502)", async () => {
      const { store, root } = await stationWithCsmsRoot();
      const keys = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 1024,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const weakCsr = await x509.Pkcs10CertificateRequestGenerator.create({
        name: "CN=CP-1,O=Example",
        keys,
        signingAlgorithm: { name: "RSASSA-PKCS1-v1_5" },
      });
      expect(store.recordPendingCsr(USE, weakCsr.toString("pem"))).toBe(true);
      const leaf = await leafForCsr("02", weakCsr.toString("pem"), root);
      const outcome = await store.applySignedChain(USE, [leaf]);
      expect(outcome).toMatchObject({ status: "InvalidProperties" });
      expect(JSON.stringify(outcome)).toContain("A00.FR.502");
    });
  });
});
