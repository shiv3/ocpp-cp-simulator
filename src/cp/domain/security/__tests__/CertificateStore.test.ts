import "reflect-metadata";
import { describe, expect, it } from "vitest";

import { CertificateStore } from "../CertificateStore";
import { computeCertificateHashData } from "../certificateHash";
import { generateCsr } from "../csr";
import { leafForCsr, selfSignedRoot, subCa } from "./certificateFixtures";

const UNKNOWN_HASH = {
  hashAlgorithm: "SHA256",
  issuerNameHash: "a".repeat(64),
  issuerKeyHash: "b".repeat(64),
  serialNumber: "ff",
} as const;

describe("CertificateStore trust anchors (M05 / M03 / M04)", () => {
  it("installs a root, keeps its hash data, and lists it by use", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "CSMS Root");

    const outcome = await store.installRootCertificate(
      "CsmsRootCertificate",
      `${root.pem}\n\n`,
      { maxEntries: 10 },
    );

    expect(outcome.status).toBe("Installed");
    const listed = store.listRootCertificates();
    expect(listed).toHaveLength(1);
    expect(listed[0].use).toBe("CsmsRootCertificate");
    expect(listed[0].pem).toBe(root.pem.trim());
    expect(listed[0].hashData).toEqual(
      await computeCertificateHashData(root.pem),
    );
    expect(store.listRootCertificates(["ManufacturerRootCertificate"])).toEqual(
      [],
    );
  });

  it("rejects a malformed certificate without storing it", async () => {
    const store = new CertificateStore();

    const outcome = await store.installRootCertificate(
      "ManufacturerRootCertificate",
      "not a certificate",
      { maxEntries: 10 },
    );

    expect(outcome).toEqual({ status: "Malformed" });
    expect(store.listRootCertificates()).toEqual([]);
  });

  it("refuses an install past maxEntries, counting roots only", async () => {
    const store = new CertificateStore();
    const first = await selfSignedRoot("01", "Root A");
    const second = await selfSignedRoot("02", "Root B");
    const chainCert = await selfSignedRoot("03", "Not a root entry");
    await store.storeSignedChain([chainCert.pem]);

    expect(
      (
        await store.installRootCertificate("CsmsRootCertificate", first.pem, {
          maxEntries: 1,
        })
      ).status,
    ).toBe("Installed");
    expect(
      await store.installRootCertificate("CsmsRootCertificate", second.pem, {
        maxEntries: 1,
      }),
    ).toEqual({ status: "StoreFull", limit: 1 });
    expect(store.listRootCertificates()).toHaveLength(1);
  });

  it("never exceeds maxEntries when two installs race", async () => {
    const store = new CertificateStore();
    const a = await selfSignedRoot("01", "Root A");
    const b = await selfSignedRoot("02", "Root B");

    const outcomes = await Promise.all([
      store.installRootCertificate("CsmsRootCertificate", a.pem, {
        maxEntries: 1,
      }),
      store.installRootCertificate("CsmsRootCertificate", b.pem, {
        maxEntries: 1,
      }),
    ]);

    expect(outcomes.map((o) => o.status).sort()).toEqual([
      "Installed",
      "StoreFull",
    ]);
    expect(store.listRootCertificates()).toHaveLength(1);
  });

  it("keeps duplicate installs and deletes the first match only", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Twice");
    await store.installRootCertificate("CsmsRootCertificate", root.pem, {
      maxEntries: 10,
    });
    await store.installRootCertificate(
      "ManufacturerRootCertificate",
      root.pem,
      {
        maxEntries: 10,
      },
    );
    const hash = store.listRootCertificates()[0].hashData;

    const deleted = store.deleteRootCertificate(hash);

    expect(deleted?.use).toBe("CsmsRootCertificate");
    expect(store.listRootCertificates().map((c) => c.use)).toEqual([
      "ManufacturerRootCertificate",
    ]);
  });

  it("matches hash data case-insensitively and reports an unknown hash", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("0a", "Root");
    await store.installRootCertificate("V2GRootCertificate", root.pem, {
      maxEntries: 10,
    });
    const hash = store.listRootCertificates()[0].hashData;

    expect(store.deleteRootCertificate(UNKNOWN_HASH)).toBeUndefined();
    expect(store.deleteCertificate(UNKNOWN_HASH)).toEqual({
      status: "NotFound",
    });
    expect(
      store.deleteRootCertificate({
        ...hash,
        issuerNameHash: hash.issuerNameHash.toUpperCase(),
        serialNumber: hash.serialNumber.toUpperCase(),
      })?.use,
    ).toBe("V2GRootCertificate");
    expect(store.listRootCertificates()).toEqual([]);
  });

  it("answers installedCertificateIds per use, with no children for roots", async () => {
    const store = new CertificateStore();
    const csms = await selfSignedRoot("01", "CSMS");
    const mo = await selfSignedRoot("02", "MO");
    await store.installRootCertificate("CsmsRootCertificate", csms.pem, {
      maxEntries: 10,
    });
    await store.installRootCertificate("MORootCertificate", mo.pem, {
      maxEntries: 10,
    });

    expect(store.installedCertificateIds(["MORootCertificate"])).toEqual([
      {
        use: "MORootCertificate",
        hashData: await computeCertificateHashData(mo.pem),
        childHashData: [],
      },
    ]);
    expect(store.installedCertificateIds(["OEMRootCertificate"])).toEqual([]);
    expect(store.installedCertificateIds().map((entry) => entry.use)).toEqual([
      "CsmsRootCertificate",
      "MORootCertificate",
    ]);
  });
});

describe("CertificateStore V2G certificate chain (M03.FR.05)", () => {
  it("reports the V2G leaf with its sub-CAs as children, hashed against their issuers", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "V2G Root");
    const sub = await subCa("02", "V2G Sub-CA", root);
    const csr = await generateCsr("CP-V2G", "Example CPO");
    const leaf = await leafForCsr("03", csr.pem, sub);
    await store.installRootCertificate("V2GRootCertificate", root.pem, {
      maxEntries: 10,
    });
    await store.storeSignedChain([leaf, sub.pem], "V2GCertificate");

    const ids = store.installedCertificateIds(["V2GCertificateChain"]);

    expect(ids).toEqual([
      {
        use: "V2GCertificateChain",
        hashData: await computeCertificateHashData(leaf, sub.pem),
        childHashData: [await computeCertificateHashData(sub.pem, root.pem)],
      },
    ]);
    // The issuer key is the sub-CA's, not the leaf's own key.
    expect(ids[0].hashData.issuerKeyHash).not.toBe(
      (await computeCertificateHashData(leaf)).issuerKeyHash,
    );
    expect(ids[0].childHashData[0].issuerKeyHash).toBe(
      (await computeCertificateHashData(root.pem)).issuerKeyHash,
    );
  });

  it("does not list ChargingStationCertificate chains under V2GCertificateChain", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Root");
    await store.storeSignedChain([root.pem]);

    expect(store.installedCertificateIds(["V2GCertificateChain"])).toEqual([]);
  });
});

describe("CertificateStore deleteCertificate (2.x scope)", () => {
  it("refuses to delete the Charging Station certificate (M04.FR.06)", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Root");
    const csr = await generateCsr("CP-1", "Example CPO");
    const leaf = await leafForCsr("02", csr.pem, root);
    const chain = await store.storeSignedChain([leaf]);

    expect(store.deleteCertificate(chain.hashData[0])).toEqual({
      status: "ChargingStationCertificate",
    });
    expect(store.listSignedChains()).toHaveLength(1);
    // The trust-store-only path (1.6) does not see signed chains at all.
    expect(store.deleteRootCertificate(chain.hashData[0])).toBeUndefined();
  });

  it("deletes a root and a whole V2G chain when one of its members matches", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "V2G Root");
    const sub = await subCa("02", "Sub", root);
    const csr = await generateCsr("CP-1", "Example CPO");
    const leaf = await leafForCsr("03", csr.pem, sub);
    await store.installRootCertificate("V2GRootCertificate", root.pem, {
      maxEntries: 10,
    });
    const chain = await store.storeSignedChain(
      [leaf, sub.pem],
      "V2GCertificate",
    );

    expect(store.deleteCertificate(chain.hashData[1])).toEqual({
      status: "Deleted",
      use: "V2GCertificate",
    });
    expect(store.listSignedChains()).toEqual([]);
    const rootHash = store.listRootCertificates()[0].hashData;
    expect(store.deleteCertificate(rootHash)).toEqual({
      status: "Deleted",
      use: "V2GRootCertificate",
    });
    expect(store.listRootCertificates()).toEqual([]);
  });
});

describe("CertificateStore pending CSR and signed chains (A02 / A03)", () => {
  it("applies a chain whose leaf carries the pending CSR's key, then clears the CSR", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "CSO Root");
    const csrPem = await store.generateNewCsr("CP-1", "Example CPO");
    expect(store.pendingCsr("ChargingStationCertificate")).toBe(csrPem);
    const leaf = await leafForCsr("02", csrPem, root);

    const outcome = await store.applySignedChain("ChargingStationCertificate", [
      leaf,
      root.pem,
    ]);

    expect(outcome.status).toBe("Accepted");
    expect(store.pendingCsr("ChargingStationCertificate")).toBeUndefined();
    expect(store.listSignedChains().map((c) => c.pems)).toEqual([
      [leaf.trim(), root.pem.trim()],
    ]);
  });

  it("rejects a chain when no CSR is pending for that use", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "CSO Root");
    const csrPem = await store.generateNewCsr("CP-1", "Example CPO");
    const leaf = await leafForCsr("02", csrPem, root);

    expect(await store.applySignedChain("V2GCertificate", [leaf])).toEqual({
      status: "NoPendingCsr",
    });
    expect(new CertificateStore().pendingCsr("V2GCertificate")).toBeUndefined();
    expect(
      await new CertificateStore().applySignedChain(
        "ChargingStationCertificate",
        [leaf],
      ),
    ).toEqual({ status: "NoPendingCsr" });
    expect(store.listSignedChains()).toEqual([]);
  });

  it("rejects a chain for another key and keeps the CSR pending", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "CSO Root");
    const csrPem = await store.generateNewCsr("CP-1", "Example CPO");
    const otherCsr = await generateCsr("CP-OTHER", "Example CPO");
    const foreignLeaf = await leafForCsr("02", otherCsr.pem, root);

    expect(
      await store.applySignedChain("ChargingStationCertificate", [foreignLeaf]),
    ).toEqual({ status: "PublicKeyMismatch" });
    expect(store.pendingCsr("ChargingStationCertificate")).toBe(csrPem);
    expect(store.listSignedChains()).toEqual([]);
  });

  it("rejects an unparseable chain", async () => {
    const store = new CertificateStore();
    await store.generateNewCsr("CP-1", "Example CPO");

    expect(
      await store.applySignedChain("ChargingStationCertificate", ["garbage"]),
    ).toEqual({ status: "Malformed" });
    expect(
      await store.applySignedChain("ChargingStationCertificate", []),
    ).toEqual({ status: "Malformed" });
  });

  it("replaces the previous chain of the same use on a successful apply", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "CSO Root");
    const firstCsr = await store.generateNewCsr("CP-1", "Example CPO");
    await store.applySignedChain("ChargingStationCertificate", [
      await leafForCsr("02", firstCsr, root),
    ]);
    const v2gCsr = await store.generateNewCsr(
      "CP-1",
      "Example CPO",
      undefined,
      "V2GCertificate",
    );
    await store.applySignedChain("V2GCertificate", [
      await leafForCsr("03", v2gCsr, root),
    ]);
    const secondCsr = await store.generateNewCsr("CP-1", "Example CPO");
    const secondLeaf = await leafForCsr("04", secondCsr, root);

    await store.applySignedChain("ChargingStationCertificate", [secondLeaf]);

    expect(
      store.listSignedChains("ChargingStationCertificate").map((c) => c.pems),
    ).toEqual([[secondLeaf.trim()]]);
    expect(store.listSignedChains("V2GCertificate")).toHaveLength(1);
  });

  it("records an externally supplied CSR and refuses an unparseable one", async () => {
    const store = new CertificateStore();
    const external = await generateCsr("CP-EXT", "Example CPO");

    expect(store.recordPendingCsr("V2GCertificate", external.pem)).toBe(true);
    expect(store.pendingCsr("V2GCertificate")).toBe(external.pem);
    expect(store.recordPendingCsr("V2GCertificate", "nope")).toBe(false);
    expect(store.pendingCsr("V2GCertificate")).toBe(external.pem);
  });

  it("stores a 1.6 chain unconditionally and leaves the pending CSR alone", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Unrelated");
    const csrPem = await store.generateNewCsr("CP-1", "Example CPO");

    const chain = await store.storeSignedChain([root.pem]);

    expect(chain.use).toBe("ChargingStationCertificate");
    expect(store.pendingCsr("ChargingStationCertificate")).toBe(csrPem);
    expect(store.toJSON().signedChains).toEqual([[root.pem.trim()]]);
  });

  it("clearAll empties every collection", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Root");
    await store.generateNewCsr("CP-1", "Example CPO");
    await store.installRootCertificate("CsmsRootCertificate", root.pem, {
      maxEntries: 10,
    });
    await store.storeSignedChain([root.pem]);

    store.clearAll();

    expect(store.listRootCertificates()).toEqual([]);
    expect(store.listSignedChains()).toEqual([]);
    expect(store.pendingCsr("ChargingStationCertificate")).toBeUndefined();
  });
});
