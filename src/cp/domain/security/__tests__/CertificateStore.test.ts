import "reflect-metadata";
import { describe, expect, it } from "vitest";

import type { Database } from "../../persistence/Database";
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

  it("lists only the chain uses it is given, V2GCertificate by default (#537)", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "V2G Root");
    const v2gCsr = await generateCsr("CP-V2G", "Example CPO");
    const v2g20Csr = await generateCsr("CP-V2G20", "Example CPO");
    const v2gLeaf = await leafForCsr("03", v2gCsr.pem, root);
    const v2g20Leaf = await leafForCsr("04", v2g20Csr.pem, root);
    await store.storeSignedChain([v2gLeaf], "V2GCertificate");
    await store.storeSignedChain([v2g20Leaf], "V2G20Certificate");

    // 2.0.1 has no V2G20Certificate: only the V2G chain is a V2G chain.
    expect(
      store
        .installedCertificateIds(["V2GCertificateChain"])
        .map((entry) => entry.hashData.serialNumber),
    ).toEqual(["3"]);
    // 2.1 M03.FR.05: both kinds of V2G chain, in install order.
    expect(
      store
        .installedCertificateIds(
          ["V2GCertificateChain"],
          ["V2GCertificate", "V2G20Certificate"],
        )
        .map((entry) => [entry.use, entry.hashData.serialNumber]),
    ).toEqual([
      ["V2GCertificateChain", "3"],
      ["V2GCertificateChain", "4"],
    ]);
    // Without a query, every installed certificate: the same two chains.
    expect(
      store.installedCertificateIds(undefined, [
        "V2GCertificate",
        "V2G20Certificate",
      ]),
    ).toHaveLength(2);
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

  it("replaces the previous 1.6 chain of the same use, keeping other uses", async () => {
    const store = new CertificateStore();
    const first = await selfSignedRoot("01", "First");
    const second = await selfSignedRoot("02", "Second");
    const v2g = await selfSignedRoot("03", "V2G");
    await store.storeSignedChain([first.pem]);
    await store.storeSignedChain([v2g.pem], "V2GCertificate");

    await store.storeSignedChain([second.pem]);

    expect(store.toJSON().signedChains).toEqual([
      [v2g.pem.trim()],
      [second.pem.trim()],
    ]);
  });
});

/** A database whose INSERTs fail while `failInserts` is set. */
function flakyInsertDatabase(): Database & { failInserts: boolean } {
  return {
    failInserts: true,
    exec() {},
    run(sql: string) {
      if (this.failInserts && sql.startsWith("INSERT")) {
        throw new Error("disk I/O error");
      }
    },
    all: <T>() => [] as T[],
    get: () => null,
    close() {},
  };
}

describe("CertificateStore operation ordering (#456 review)", () => {
  it("lets an exclusive read issued after an install observe it", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Root");

    const installing = store.installRootCertificate(
      "CsmsRootCertificate",
      root.pem,
      { maxEntries: 10 },
    );
    const listed = store.runExclusive(
      () => store.listRootCertificates().length,
    );

    expect(await listed).toBe(1);
    expect((await installing).status).toBe("Installed");
  });

  it("lets an exclusive delete issued after an install remove it", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Root");
    const hash = await computeCertificateHashData(root.pem);

    void store.installRootCertificate("CsmsRootCertificate", root.pem, {
      maxEntries: 10,
    });
    const deleted = await store.runExclusive(() =>
      store.deleteRootCertificate(hash),
    );

    expect(deleted?.use).toBe("CsmsRootCertificate");
    expect(store.listRootCertificates()).toEqual([]);
  });

  it("runs an exclusive operation inline when nothing is pending", () => {
    const store = new CertificateStore();
    expect(store.runExclusive(() => 42)).toBe(42);
  });

  it("keeps serving operations after a queued one throws", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Root");
    void store.installRootCertificate("CsmsRootCertificate", root.pem, {
      maxEntries: 10,
    });

    const failing = store.runExclusive(() => {
      throw new Error("boom");
    });
    const after = store.runExclusive(() => store.listRootCertificates().length);

    await expect(failing).rejects.toThrow("boom");
    expect(await after).toBe(1);
  });
});

describe("CertificateStore reinstall (M05.FR.17, 2.x)", () => {
  it("replaces a reinstalled certificate instead of duplicating it", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Root");
    const options = { maxEntries: 10, replaceDuplicate: true };
    await store.installRootCertificate(
      "CsmsRootCertificate",
      root.pem,
      options,
    );

    const outcome = await store.installRootCertificate(
      "ManufacturerRootCertificate",
      root.pem,
      options,
    );

    expect(outcome.status).toBe("Installed");
    expect(store.listRootCertificates().map((c) => c.use)).toEqual([
      "ManufacturerRootCertificate",
    ]);
  });

  it("accepts a reinstall into a full store", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Root");
    const options = { maxEntries: 1, replaceDuplicate: true };
    await store.installRootCertificate(
      "CsmsRootCertificate",
      root.pem,
      options,
    );

    const outcome = await store.installRootCertificate(
      "CsmsRootCertificate",
      root.pem,
      options,
    );

    expect(outcome.status).toBe("Installed");
    expect(store.listRootCertificates()).toHaveLength(1);
  });

  it("still refuses a different certificate into a full store", async () => {
    const store = new CertificateStore();
    const a = await selfSignedRoot("01", "A");
    const b = await selfSignedRoot("02", "B");
    const options = { maxEntries: 1, replaceDuplicate: true };
    await store.installRootCertificate("CsmsRootCertificate", a.pem, options);

    expect(
      await store.installRootCertificate("CsmsRootCertificate", b.pem, options),
    ).toEqual({ status: "StoreFull", limit: 1 });
  });
});

describe("CertificateStore persistence failures (#456 review)", () => {
  it("answers PersistFailed and keeps nothing when the INSERT fails", async () => {
    const db = flakyInsertDatabase();
    const store = new CertificateStore("CP-1", db);
    const root = await selfSignedRoot("01", "Root");

    expect(
      await store.installRootCertificate("CsmsRootCertificate", root.pem, {
        maxEntries: 10,
      }),
    ).toEqual({ status: "PersistFailed" });
    expect(store.listRootCertificates()).toEqual([]);
  });

  it("keeps the old certificate when a replacing INSERT fails", async () => {
    const db = flakyInsertDatabase();
    db.failInserts = false;
    const store = new CertificateStore("CP-1", db);
    const root = await selfSignedRoot("01", "Root");
    const options = { maxEntries: 10, replaceDuplicate: true };
    await store.installRootCertificate(
      "CsmsRootCertificate",
      root.pem,
      options,
    );
    db.failInserts = true;

    expect(
      await store.installRootCertificate(
        "ManufacturerRootCertificate",
        root.pem,
        options,
      ),
    ).toEqual({ status: "PersistFailed" });
    expect(store.listRootCertificates().map((c) => c.use)).toEqual([
      "CsmsRootCertificate",
    ]);
  });
});

describe("CertificateStore change notifications (#537)", () => {
  it("tells its listeners after every change to what it holds", async () => {
    const store = new CertificateStore();
    const counts: number[] = [];
    store.onChange(() => counts.push(store.listRootCertificates().length));
    const root = await selfSignedRoot("01", "Root");

    await store.installRootCertificate("CsmsRootCertificate", root.pem, {
      maxEntries: 10,
    });
    const csr = await store.generateNewCsr("CP", "CPO");
    await store.applySignedChain("ChargingStationCertificate", [
      await leafForCsr("02", csr, root),
    ]);
    store.deleteRootCertificate(store.listRootCertificates()[0].hashData);
    store.clearAll();

    expect(counts).toEqual([1, 1, 0, 0]);
  });

  it("stays silent on a refused install and stops after unsubscribing", async () => {
    const store = new CertificateStore();
    let calls = 0;
    const unsubscribe = store.onChange(() => calls++);

    await store.installRootCertificate("CsmsRootCertificate", "not a pem", {
      maxEntries: 10,
    });
    expect(calls).toBe(0);

    unsubscribe();
    const root = await selfSignedRoot("01", "Root");
    await store.installRootCertificate("CsmsRootCertificate", root.pem, {
      maxEntries: 10,
    });
    expect(calls).toBe(0);
  });
});

describe("CertificateStore OCSP (#537, M06)", () => {
  async function v2gChain(store: CertificateStore) {
    const root = await selfSignedRoot("01", "V2G Root");
    const sub = await subCa("02", "V2G Sub-CA", root, {
      ocspUrl: "http://ocsp.example.com/sub",
    });
    const csr = await store.generateNewCsr(
      "CP",
      "CPO",
      undefined,
      "V2GCertificate",
    );
    const leaf = await leafForCsr("0a1b", csr, sub, {
      ocspUrl: "http://ocsp.example.com/leaf",
    });
    await store.applySignedChain("V2GCertificate", [leaf, sub.pem]);
    return store.listSignedChains("V2GCertificate")[0];
  }

  it("builds ocspRequestData for every chain member with a responder URL (M06.FR.07)", async () => {
    const store = new CertificateStore();
    const chain = await v2gChain(store);

    expect(store.ocspRequestData("V2GCertificate")).toEqual([
      { ...chain.hashData[0], responderURL: "http://ocsp.example.com/leaf" },
      { ...chain.hashData[1], responderURL: "http://ocsp.example.com/sub" },
    ]);
    expect(chain.hashData[0].serialNumber).toBe("a1b");
  });

  it("leaves out a member without an OCSP responder URL", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Root");
    const csr = await store.generateNewCsr(
      "CP",
      "CPO",
      undefined,
      "V2GCertificate",
    );
    await store.applySignedChain("V2GCertificate", [
      await leafForCsr("02", csr, root),
    ]);

    expect(store.ocspRequestData("V2GCertificate")).toEqual([]);
    expect(store.ocspRequestData("ChargingStationCertificate")).toEqual([]);
  });

  it("caches an OCSP response per certificate, matched like hash data", async () => {
    const store = new CertificateStore();
    const chain = await v2gChain(store);
    const leafHash = chain.hashData[0];

    expect(store.cachedOcspResponse(leafHash)).toBeUndefined();
    store.cacheOcspResponse(leafHash, "MIIB");
    expect(
      store.cachedOcspResponse({
        ...leafHash,
        serialNumber: `0${leafHash.serialNumber.toUpperCase()}`,
      })?.ocspResult,
    ).toBe("MIIB");
    expect(store.cachedOcspResponse(chain.hashData[1])).toBeUndefined();

    store.clearAll();
    expect(store.cachedOcspResponse(leafHash)).toBeUndefined();
  });
});

describe("CertificateStore TLS client identity (#537, A02.FR.08)", () => {
  async function importKey(pem: string): Promise<CryptoKey> {
    const der = Buffer.from(
      pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""),
      "base64",
    );
    return crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  }

  async function signedChargingStationChain(store: CertificateStore) {
    const root = await selfSignedRoot("01", "CPO Root");
    const sub = await subCa("02", "CPO Sub-CA", root);
    const csr = await store.generateNewCsr("CP-TLS", "Example CPO");
    const leaf = await leafForCsr("03", csr, sub);
    await store.applySignedChain("ChargingStationCertificate", [leaf, sub.pem]);
    return { root, sub, leaf };
  }

  it("binds the CSR's private key to the accepted chain", async () => {
    const store = new CertificateStore();
    const { sub, leaf } = await signedChargingStationChain(store);

    const identity = await store.tlsClientIdentity();

    expect(identity?.cert).toBe(`${leaf.trim()}\n${sub.pem.trim()}\n`);
    expect(identity?.key).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    // The key is the one the leaf certifies: a signature made with it
    // verifies against the leaf's public key.
    const data = new TextEncoder().encode("A02.FR.08");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      await importKey(identity!.key),
      data,
    );
    const { X509Certificate } = await import("@peculiar/x509");
    const leafKey = await new X509Certificate(leaf).publicKey.export();
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        leafKey,
        signature,
        data,
      ),
    ).toBe(true);
    expect(identity?.notBefore).toBeInstanceOf(Date);
  });

  it("has none for a chain signed for a CSR it did not generate, nor for a V2G chain", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "CPO Root");
    const forwarded = await generateCsr("CP-TLS", "Example CPO");
    expect(
      store.recordPendingCsr("ChargingStationCertificate", forwarded.pem),
    ).toBe(true);
    await store.applySignedChain("ChargingStationCertificate", [
      await leafForCsr("03", forwarded.pem, root),
    ]);
    expect(await store.tlsClientIdentity()).toBeUndefined();

    const v2gCsr = await store.generateNewCsr(
      "CP-TLS",
      "Example CPO",
      undefined,
      "V2GCertificate",
    );
    await store.applySignedChain("V2GCertificate", [
      await leafForCsr("04", v2gCsr, root),
    ]);
    expect(await store.tlsClientIdentity()).toBeUndefined();
  });

  it("drops the identity once its chain is replaced or deleted", async () => {
    const store = new CertificateStore();
    const { root } = await signedChargingStationChain(store);
    expect(await store.tlsClientIdentity()).toBeDefined();

    // A 1.6 CertificateSigned replaces the chain without a matching key.
    const other = await generateCsr("CP-TLS", "Example CPO");
    await store.storeSignedChain([await leafForCsr("05", other.pem, root)]);
    expect(await store.tlsClientIdentity()).toBeUndefined();

    // state.reset / cp.delete
    const again = new CertificateStore();
    await signedChargingStationChain(again);
    again.clearAll();
    expect(await again.tlsClientIdentity()).toBeUndefined();
  });

  it("keeps the key out of JSON and toString", async () => {
    const store = new CertificateStore();
    await signedChargingStationChain(store);
    await store.tlsClientIdentity();

    for (const text of [JSON.stringify(store), String(store)]) {
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toMatch(/"privateKey"\s*:/i);
    }
  });
});
