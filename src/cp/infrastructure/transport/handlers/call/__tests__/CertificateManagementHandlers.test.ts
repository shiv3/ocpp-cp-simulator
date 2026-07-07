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

function buildContext(maxLength = 10) {
  const certificateStore = new CertificateStore();
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

    const res = handler.handle(
      { certificateType: "CentralSystemRootCertificate", certificate: pem },
      ctx,
    );

    expect(res).toEqual({ status: "Accepted" });
    expect(certificateStore.listRootCerts()).toEqual([
      { type: "CentralSystemRootCertificate", pem: pem.trim() },
    ]);
  });

  it("rejects malformed PEM", () => {
    const { ctx, certificateStore } = buildContext();
    const handler = new InstallCertificateHandler();

    const res = handler.handle(
      {
        certificateType: "ManufacturerRootCertificate",
        certificate: "not a certificate",
      },
      ctx,
    );

    expect(res).toEqual({ status: "Rejected" });
    expect(certificateStore.listRootCerts()).toEqual([]);
  });

  it("rejects when the store is at CertificateStoreMaxLength", async () => {
    const { ctx, certificateStore } = buildContext(1);
    const first = await selfSignedRootCert("01", "Root A");
    certificateStore.installRootCert("CentralSystemRootCertificate", first);

    const handler = new InstallCertificateHandler();
    const second = await selfSignedRootCert("02", "Root B");
    const res = handler.handle(
      { certificateType: "CentralSystemRootCertificate", certificate: second },
      ctx,
    );

    expect(res).toEqual({ status: "Rejected" });
    expect(certificateStore.listRootCerts()).toHaveLength(1);
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
    certificateStore.installRootCert(
      "CentralSystemRootCertificate",
      centralPem,
    );
    certificateStore.installRootCert("ManufacturerRootCertificate", mfgPem);

    const handler = new GetInstalledCertificateIdsHandler();
    const res = await handler.handle(
      { certificateType: "CentralSystemRootCertificate" },
      ctx,
    );

    expect(res.status).toBe("Accepted");
    expect(res.certificateHashData).toHaveLength(1);
    expect(res.certificateHashData?.[0]).toMatchObject({
      hashAlgorithm: "SHA256",
      serialNumber: "01",
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
    certificateStore.installRootCert("CentralSystemRootCertificate", pem);

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
    expect(certificateStore.listRootCerts()).toEqual([]);
  });

  it("does not delete non-matching certs when multiple are installed", async () => {
    const { ctx, certificateStore } = buildContext();
    const keepPem = await selfSignedRootCert("01", "Keep Me");
    const deletePem = await selfSignedRootCert("02", "Delete Me");
    certificateStore.installRootCert("CentralSystemRootCertificate", keepPem);
    certificateStore.installRootCert("ManufacturerRootCertificate", deletePem);

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
    const remaining = certificateStore.listRootCerts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pem).toBe(keepPem.trim());
  });
});
