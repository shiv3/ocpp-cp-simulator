// Runs under `bun test`: the persistence cases use the `bun:sqlite` built-in.
import "reflect-metadata";
import { describe, expect, it } from "bun:test";

import { ChargePoint } from "../charge-point/ChargePoint";
import { BunSqliteDatabase } from "../persistence/BunSqliteDatabase";
import { DefaultBootNotification } from "../types/OcppTypes";
import { CertificateStore } from "./CertificateStore";
import { leafForCsr, selfSignedRoot } from "./__tests__/certificateFixtures";

/**
 * #456: installed certificates survive a daemon restart when state
 * persistence is on. A "restart" here is a second store opened on the same
 * database, which is what `ChargePoint` does on daemon restore.
 */
describe("CertificateStore persistence", () => {
  it("restores roots and signed chains, with their hash data, after a restart", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    const root = await selfSignedRoot("01", "CSMS Root");
    const before = new CertificateStore("CP-1", db);
    await before.installRootCertificate("CsmsRootCertificate", root.pem, {
      maxEntries: 10,
    });
    const csr = await before.generateNewCsr("CP-1", "Example CPO");
    const leaf = await leafForCsr("02", csr, root);
    await before.applySignedChain("ChargingStationCertificate", [leaf]);

    const after = new CertificateStore("CP-1", db);

    expect(after.listRootCertificates()).toEqual(before.listRootCertificates());
    expect(after.listSignedChains()).toEqual(before.listSignedChains());
    expect(after.installedCertificateIds()).toEqual(
      before.installedCertificateIds(),
    );
    db.close();
  });

  it("keeps each charge point's certificates apart", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    const root = await selfSignedRoot("01", "Root");
    await new CertificateStore("CP-A", db).installRootCertificate(
      "ManufacturerRootCertificate",
      root.pem,
      { maxEntries: 10 },
    );

    expect(new CertificateStore("CP-B", db).listRootCertificates()).toEqual([]);
    expect(
      new CertificateStore("CP-A", db).listRootCertificates(),
    ).toHaveLength(1);
    db.close();
  });

  it("persists deletes, chain replacement and clearAll", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    const a = await selfSignedRoot("01", "Root A");
    const b = await selfSignedRoot("02", "Root B");
    const store = new CertificateStore("CP-1", db);
    await store.installRootCertificate("CsmsRootCertificate", a.pem, {
      maxEntries: 10,
    });
    await store.installRootCertificate("CsmsRootCertificate", b.pem, {
      maxEntries: 10,
    });
    store.deleteRootCertificate(store.listRootCertificates()[0].hashData);
    const firstCsr = await store.generateNewCsr("CP-1", "Example CPO");
    await store.applySignedChain("ChargingStationCertificate", [
      await leafForCsr("03", firstCsr, a),
    ]);
    const secondCsr = await store.generateNewCsr("CP-1", "Example CPO");
    const secondLeaf = await leafForCsr("04", secondCsr, a);
    await store.applySignedChain("ChargingStationCertificate", [secondLeaf]);

    const reopened = new CertificateStore("CP-1", db);
    expect(reopened.listRootCertificates().map((c) => c.pem)).toEqual([
      b.pem.trim(),
    ]);
    expect(reopened.listSignedChains().map((c) => c.pems)).toEqual([
      [secondLeaf.trim()],
    ]);

    reopened.clearAll();
    expect(new CertificateStore("CP-1", db).listRootCertificates()).toEqual([]);
    expect(new CertificateStore("CP-1", db).listSignedChains()).toEqual([]);
    db.close();
  });

  it("keeps one row per use for repeated 1.6 CertificateSigned chains", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    const store = new CertificateStore("CP-1", db);
    const first = await selfSignedRoot("01", "First");
    const second = await selfSignedRoot("02", "Second");
    await store.storeSignedChain([first.pem]);
    await store.storeSignedChain([second.pem]);

    expect(
      db.all("SELECT seq FROM certificates WHERE cp_id = ?", ["CP-1"]),
    ).toHaveLength(1);
    expect(
      new CertificateStore("CP-1", db).listSignedChains().map((c) => c.pems),
    ).toEqual([[second.pem.trim()]]);
    db.close();
  });

  it("does not persist a pending CSR (its key pair is gone after a restart)", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    const store = new CertificateStore("CP-1", db);
    await store.generateNewCsr("CP-1", "Example CPO");

    expect(
      new CertificateStore("CP-1", db).pendingCsr("ChargingStationCertificate"),
    ).toBeUndefined();
    db.close();
  });

  it("skips a row it cannot read instead of failing the whole load", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    const root = await selfSignedRoot("01", "Root");
    await new CertificateStore("CP-1", db).installRootCertificate(
      "CsmsRootCertificate",
      root.pem,
      { maxEntries: 10 },
    );
    db.run(
      "INSERT INTO certificates (cp_id, seq, kind, certificate_use, body, installed_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["CP-1", 99, "root", "NotAUse", "{}", "2026-10-29T00:00:00Z"],
    );
    db.run(
      "INSERT INTO certificates (cp_id, seq, kind, certificate_use, body, installed_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "CP-1",
        100,
        "chain",
        "V2GCertificate",
        "not json",
        "2026-10-29T00:00:00Z",
      ],
    );

    const reopened = new CertificateStore("CP-1", db);

    expect(reopened.listRootCertificates()).toHaveLength(1);
    expect(reopened.listSignedChains()).toEqual([]);
    // The next insert does not collide with the skipped rows' seq.
    const other = await selfSignedRoot("02", "Other");
    expect(
      (
        await reopened.installRootCertificate(
          "CsmsRootCertificate",
          other.pem,
          {
            maxEntries: 10,
          },
        )
      ).status,
    ).toBe("Installed");
    expect(
      new CertificateStore("CP-1", db).listRootCertificates(),
    ).toHaveLength(2);
    db.close();
  });

  // #537: rows written before serialNumber lost its leading zeroes.
  describe.each(["0a", "a"])(
    "a persisted root whose serialNumber is stored as 0a, deleted with %s",
    (sent) => {
      it("is reported without the leading zero and deleted", async () => {
        const db = BunSqliteDatabase.open(":memory:");
        const root = await selfSignedRoot("0a", "Old Root");
        await new CertificateStore("CP-1", db).installRootCertificate(
          "CsmsRootCertificate",
          root.pem,
          { maxEntries: 10 },
        );
        const [row] = db.all<{ body: string }>(
          "SELECT body FROM certificates WHERE cp_id = ?",
          ["CP-1"],
        );
        const body = JSON.parse(row.body) as {
          hashData: { serialNumber: string };
        };
        body.hashData.serialNumber = "0a";
        db.run("UPDATE certificates SET body = ? WHERE cp_id = ?", [
          JSON.stringify(body),
          "CP-1",
        ]);

        const reopened = new CertificateStore("CP-1", db);
        const [entry] = reopened.installedCertificateIds();
        expect(entry.hashData.serialNumber).toBe("a");

        const deleted = reopened.deleteRootCertificate({
          ...entry.hashData,
          serialNumber: sent,
        });
        expect(deleted?.use).toBe("CsmsRootCertificate");
        expect(new CertificateStore("CP-1", db).listRootCertificates()).toEqual(
          [],
        );
        db.close();
      });
    },
  );

  it("never writes private key material to JSON, toString or the database", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    const store = new CertificateStore("CP-1", db);
    const root = await selfSignedRoot("01", "Root");
    await store.installRootCertificate("CsmsRootCertificate", root.pem, {
      maxEntries: 10,
    });
    const csr = await store.generateNewCsr("CP-1", "Example CPO");
    await store.applySignedChain("ChargingStationCertificate", [
      await leafForCsr("02", csr, root),
    ]);
    // #537: the accepted chain's key is held for TLS, in memory only.
    expect(await store.tlsClientIdentity()).toBeDefined();
    await store.generateNewCsr("CP-1", "Example CPO", { keyAlgorithm: "RSA" });

    const rows = JSON.stringify(
      db.all("SELECT * FROM certificates WHERE cp_id = ?", ["CP-1"]),
    );
    const serialized = [JSON.stringify(store), store.toString(), rows];

    expect(rows.length).toBeGreaterThan(2);
    for (const text of serialized) {
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toMatch(/"privateKey"\s*:/i);
      expect(text).not.toMatch(/"d"\s*:\s*"/);
    }
    // A restart reads the chain back without its key: no TLS identity.
    const reopened = new CertificateStore("CP-1", db);
    expect(
      reopened.listSignedChains("ChargingStationCertificate"),
    ).toHaveLength(1);
    expect(await reopened.tlsClientIdentity()).toBeUndefined();
    db.close();
  });
});

describe("ChargePoint certificate persistence", () => {
  function chargePoint(db: BunSqliteDatabase): ChargePoint {
    return new ChargePoint(
      "CP-CERT-RESTART",
      DefaultBootNotification,
      1,
      "ws://127.0.0.1:1/ocpp",
      null,
      null,
      db,
    );
  }

  it("hands the charge point's database to its certificate store", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    const root = await selfSignedRoot("01", "Root");
    await chargePoint(db).certificateStore.installRootCertificate(
      "ManufacturerRootCertificate",
      root.pem,
      { maxEntries: 10 },
    );

    const restarted = chargePoint(db);

    expect(
      restarted.certificateStore.listRootCertificates().map((c) => c.pem),
    ).toEqual([root.pem.trim()]);
    db.close();
  });
});
