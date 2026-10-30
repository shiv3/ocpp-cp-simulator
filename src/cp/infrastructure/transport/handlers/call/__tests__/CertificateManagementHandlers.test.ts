import "reflect-metadata";
import { describe, it, expect } from "vitest";
import * as x509 from "@peculiar/x509";
import {
  DeleteCertificateHandler,
  GetInstalledCertificateIdsHandler,
  InstallCertificateHandler,
} from "../CertificateManagementHandlers";
import { Logger } from "../../../../../shared/Logger";
import { CertificateStore } from "../../../../../domain/security/CertificateStore";
import { computeCertificateHashData } from "../../../../../domain/security/certificateHash";
import type { Database } from "../../../../../domain/persistence/Database";
import { rootUseFromV16, rootUseToV16 } from "../../../certificateUseMapping";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import type { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

const EC_ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

async function selfSignedRootCert(serialNumber: string, cn: string) {
  const keys = await crypto.subtle.generateKey(EC_ALG, true, [
    "sign",
    "verify",
  ]);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber,
    name: `CN=${cn},O=Example`,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    signingAlgorithm: EC_ALG,
    keys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return cert.toString("pem");
}

type V16RootType =
  "CentralSystemRootCertificate" | "ManufacturerRootCertificate";

/** Seeds the store the way a 1.6 InstallCertificate would. */
async function installV16(
  store: CertificateStore,
  type: V16RootType,
  pem: string,
): Promise<void> {
  const outcome = await store.installRootCertificate(
    rootUseFromV16(type)!,
    pem,
    { maxEntries: 10 },
  );
  expect(outcome.status).toBe("Installed");
}

/** The installed roots in 1.6 terms, the shape these tests assert on. */
function v16View(store: CertificateStore) {
  return store
    .listRootCertificates()
    .map((cert) => ({ type: rootUseToV16(cert.use), pem: cert.pem }));
}

function buildContext(
  maxLength = 10,
  certificateStore = new CertificateStore(),
) {
  const chargePoint = {
    id: "CP-CERT-TEST",
    certificateStore,
    configuration: {
      certificateStoreMaxLength: () => maxLength,
    },
  };
  const ctx: HandlerContext = {
    chargePoint: chargePoint as unknown as ChargePoint,
    logger: new Logger(),
  };
  return { ctx, certificateStore };
}

describe("InstallCertificateHandler", () => {
  it("accepts a well-formed certificate and stores it", async () => {
    const { ctx, certificateStore } = buildContext();
    const pem = await selfSignedRootCert("01", "Root A");
    const handler = new InstallCertificateHandler();

    const res = await handler.handle(
      { certificateType: "CentralSystemRootCertificate", certificate: pem },
      ctx,
    );

    expect(res).toEqual({ status: "Accepted" });
    expect(v16View(certificateStore)).toEqual([
      { type: "CentralSystemRootCertificate", pem: pem.trim() },
    ]);
  });

  it("rejects malformed PEM", async () => {
    const { ctx, certificateStore } = buildContext();
    const handler = new InstallCertificateHandler();

    const res = await handler.handle(
      {
        certificateType: "ManufacturerRootCertificate",
        certificate: "not a certificate",
      },
      ctx,
    );

    expect(res).toEqual({ status: "Rejected" });
    expect(v16View(certificateStore)).toEqual([]);
  });

  it("rejects when the store is at CertificateStoreMaxLength", async () => {
    const { ctx, certificateStore } = buildContext(1);
    const first = await selfSignedRootCert("01", "Root A");
    await installV16(certificateStore, "CentralSystemRootCertificate", first);

    const handler = new InstallCertificateHandler();
    const second = await selfSignedRootCert("02", "Root B");
    const res = await handler.handle(
      { certificateType: "CentralSystemRootCertificate", certificate: second },
      ctx,
    );

    expect(res).toEqual({ status: "Rejected" });
    expect(v16View(certificateStore)).toHaveLength(1);
  });
});

describe("GetInstalledCertificateIdsHandler", () => {
  it("returns NotFound when no root certs of the requested type are stored", async () => {
    const { ctx } = buildContext();
    const handler = new GetInstalledCertificateIdsHandler();

    const res = await handler.handle(
      { certificateType: "CentralSystemRootCertificate" },
      ctx,
    );

    expect(res).toEqual({ status: "NotFound" });
  });

  it("returns certificateHashData for stored certs of the requested type only", async () => {
    const { ctx, certificateStore } = buildContext();
    const centralPem = await selfSignedRootCert("01", "Central Root");
    const mfgPem = await selfSignedRootCert("02", "Mfg Root");
    await installV16(
      certificateStore,
      "CentralSystemRootCertificate",
      centralPem,
    );
    await installV16(certificateStore, "ManufacturerRootCertificate", mfgPem);

    const handler = new GetInstalledCertificateIdsHandler();
    const res = await handler.handle(
      { certificateType: "CentralSystemRootCertificate" },
      ctx,
    );

    expect(res.status).toBe("Accepted");
    expect(res.certificateHashData).toHaveLength(1);
    expect(res.certificateHashData?.[0]).toMatchObject({
      hashAlgorithm: "SHA256",
      // #537: no leading zero.
      serialNumber: "1",
    });
    expect(res.certificateHashData?.[0].issuerNameHash).toHaveLength(64);
    expect(res.certificateHashData?.[0].issuerKeyHash).toHaveLength(64);
  });
});

describe("DeleteCertificateHandler", () => {
  it("returns NotFound when no stored cert matches the hash data", async () => {
    const { ctx } = buildContext();
    const handler = new DeleteCertificateHandler();

    const res = await handler.handle(
      {
        certificateHashData: {
          hashAlgorithm: "SHA256",
          issuerNameHash: "a".repeat(64),
          issuerKeyHash: "b".repeat(64),
          serialNumber: "ff",
        },
      },
      ctx,
    );

    expect(res).toEqual({ status: "NotFound" });
  });

  it("deletes the matching stored root cert and returns Accepted", async () => {
    const { ctx, certificateStore } = buildContext();
    const pem = await selfSignedRootCert("01", "Root To Delete");
    await installV16(certificateStore, "CentralSystemRootCertificate", pem);

    const getHandler = new GetInstalledCertificateIdsHandler();
    const listed = await getHandler.handle(
      { certificateType: "CentralSystemRootCertificate" },
      ctx,
    );
    const hashData = listed.certificateHashData?.[0];
    expect(hashData).toBeDefined();

    const deleteHandler = new DeleteCertificateHandler();
    const res = await deleteHandler.handle(
      { certificateHashData: hashData! },
      ctx,
    );

    expect(res).toEqual({ status: "Accepted" });
    expect(v16View(certificateStore)).toEqual([]);
  });

  it("does not delete non-matching certs when multiple are installed", async () => {
    const { ctx, certificateStore } = buildContext();
    const keepPem = await selfSignedRootCert("01", "Keep Me");
    const deletePem = await selfSignedRootCert("02", "Delete Me");
    await installV16(certificateStore, "CentralSystemRootCertificate", keepPem);
    await installV16(
      certificateStore,
      "ManufacturerRootCertificate",
      deletePem,
    );

    const getHandler = new GetInstalledCertificateIdsHandler();
    const listed = await getHandler.handle(
      { certificateType: "ManufacturerRootCertificate" },
      ctx,
    );
    expect(listed.certificateHashData).toBeDefined();
    const hashData = listed.certificateHashData![0];

    const deleteHandler = new DeleteCertificateHandler();
    const res = await deleteHandler.handle(
      { certificateHashData: hashData },
      ctx,
    );

    expect(res).toEqual({ status: "Accepted" });
    const remaining = v16View(certificateStore);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pem).toBe(keepPem.trim());
  });
});

/**
 * #456 regression pins for the 1.6 wire: the handlers now go through the
 * version-neutral store, and none of these answers may change.
 */
describe("1.6 certificate handlers on the version-neutral store", () => {
  it("answers NotFound for the hash of a signed chain, and keeps the chain", async () => {
    const { ctx, certificateStore } = buildContext();
    const pem = await selfSignedRootCert("01", "Charge Point Cert");
    const chain = await certificateStore.storeSignedChain([pem]);

    const res = await new DeleteCertificateHandler().handle(
      { certificateHashData: { ...chain.hashData[0] } },
      ctx,
    );

    expect(res).toEqual({ status: "NotFound" });
    expect(certificateStore.listSignedChains()).toHaveLength(1);
  });

  it("lists a certificate installed twice twice, in install order", async () => {
    const { ctx } = buildContext();
    const pem = await selfSignedRootCert("01", "Twice");
    const install = new InstallCertificateHandler();
    for (let i = 0; i < 2; i += 1) {
      expect(
        await install.handle(
          { certificateType: "CentralSystemRootCertificate", certificate: pem },
          ctx,
        ),
      ).toEqual({ status: "Accepted" });
    }

    const res = await new GetInstalledCertificateIdsHandler().handle(
      { certificateType: "CentralSystemRootCertificate" },
      ctx,
    );

    expect(res.certificateHashData).toHaveLength(2);
    expect(res.certificateHashData?.[0]).toEqual(res.certificateHashData?.[1]);
  });

  it("never lets two concurrent installs pass CertificateStoreMaxLength", async () => {
    const { ctx, certificateStore } = buildContext(1);
    const a = await selfSignedRootCert("01", "Root A");
    const b = await selfSignedRootCert("02", "Root B");
    const install = new InstallCertificateHandler();

    const results = await Promise.all([
      install.handle(
        { certificateType: "CentralSystemRootCertificate", certificate: a },
        ctx,
      ),
      install.handle(
        { certificateType: "ManufacturerRootCertificate", certificate: b },
        ctx,
      ),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([
      "Accepted",
      "Rejected",
    ]);
    expect(certificateStore.listRootCertificates()).toHaveLength(1);
  });

  it("logs neither certificates nor key material", async () => {
    const { ctx, certificateStore } = buildContext();
    const messages: string[] = [];
    ctx.logger.loggingCallback = (entry) => messages.push(entry.message);
    await certificateStore.generateNewCsr("CP-CERT-TEST", "Example CPO");
    const pem = await selfSignedRootCert("01", "Logged Root");

    await new InstallCertificateHandler().handle(
      { certificateType: "ManufacturerRootCertificate", certificate: pem },
      ctx,
    );
    const listed = await new GetInstalledCertificateIdsHandler().handle(
      { certificateType: "ManufacturerRootCertificate" },
      ctx,
    );
    await new DeleteCertificateHandler().handle(
      { certificateHashData: listed.certificateHashData![0] },
      ctx,
    );

    expect(messages.length).toBeGreaterThanOrEqual(3);
    const logged = messages.join("\n");
    expect(logged).not.toContain("PRIVATE KEY");
    expect(logged).not.toContain("BEGIN CERTIFICATE");
    expect(logged).toContain("type=ManufacturerRootCertificate");
  });
});

describe("1.6 certificate handlers ordering and failures (#456 review)", () => {
  it("lists a certificate whose install was dispatched just before the query", async () => {
    const { ctx } = buildContext();
    const pem = await selfSignedRootCert("01", "Back to back");

    // Both handlers start before either answer is awaited, as the 1.6
    // dispatcher does for two CALLs arriving back to back.
    const installed = new InstallCertificateHandler().handle(
      { certificateType: "CentralSystemRootCertificate", certificate: pem },
      ctx,
    );
    const listed = new GetInstalledCertificateIdsHandler().handle(
      { certificateType: "CentralSystemRootCertificate" },
      ctx,
    );

    expect(await installed).toEqual({ status: "Accepted" });
    expect(await listed).toMatchObject({
      status: "Accepted",
      certificateHashData: [expect.anything()],
    });
  });

  it("deletes a certificate whose install was dispatched just before the delete", async () => {
    const { ctx, certificateStore } = buildContext();
    const pem = await selfSignedRootCert("01", "Back to back");
    const hash = await computeCertificateHashData(pem);

    const installed = new InstallCertificateHandler().handle(
      { certificateType: "ManufacturerRootCertificate", certificate: pem },
      ctx,
    );
    const deleted = new DeleteCertificateHandler().handle(
      { certificateHashData: hash },
      ctx,
    );

    expect(await installed).toEqual({ status: "Accepted" });
    expect(await deleted).toEqual({ status: "Accepted" });
    expect(certificateStore.listRootCertificates()).toEqual([]);
  });

  it("answers Failed when the certificate cannot be persisted (whitepaper M05.FR.04)", async () => {
    const database: Database = {
      exec() {},
      run(sql: string) {
        if (sql.startsWith("INSERT")) throw new Error("disk I/O error");
      },
      all: <T>() => [] as T[],
      get: () => null,
      close() {},
    };
    const { ctx, certificateStore } = buildContext(
      10,
      new CertificateStore("CP-CERT-TEST", database),
    );
    const pem = await selfSignedRootCert("01", "Unsaved");

    expect(
      await new InstallCertificateHandler().handle(
        { certificateType: "CentralSystemRootCertificate", certificate: pem },
        ctx,
      ),
    ).toEqual({ status: "Failed" });
    expect(certificateStore.listRootCertificates()).toEqual([]);
  });
});
