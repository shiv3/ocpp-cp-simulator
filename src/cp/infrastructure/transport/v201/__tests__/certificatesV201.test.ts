import { describe, expect, it, vi } from "vitest";

import {
  isValidCertificateSignedResponseV201,
  isValidCertificateSignedResponseV21,
  isValidGetInstalledCertificateIdsResponseV201,
  isValidGetInstalledCertificateIdsResponseV21,
  isValidInstallCertificateResponseV201,
  isValidInstallCertificateResponseV21,
  isValidSecurityEventNotificationRequestV201,
  isValidSecurityEventNotificationRequestV21,
} from "../../../../../ocpp";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import type { Database } from "../../../../domain/persistence/Database";
import { computeCertificateHashData } from "../../../../domain/security/certificateHash";
import { CertificateStore } from "../../../../domain/security/CertificateStore";
import { generateCsr } from "../../../../domain/security/csr";
import {
  leafForCsr,
  selfSignedRoot,
  subCa,
} from "../../../../domain/security/__tests__/certificateFixtures";
import type { Logger } from "../../../../shared/Logger";
import {
  buildCertificateHandlersV2x,
  V201_CERTIFICATE_MAPPING,
  V21_CERTIFICATE_MAPPING,
} from "../certificatesV201";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "../inboundRegistryV201";

function context(store: CertificateStore, maxEntries = 10) {
  const sendCall = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const ctx: V201InboundContext = {
    chargePoint: {
      certificateStore: store,
      configuration: { certificateStoreMaxLength: () => maxEntries },
    } as unknown as ChargePoint,
    logger: logger as unknown as Logger,
    sendCall,
  };
  return { ctx, sendCall, logger };
}

const v201 = buildCertificateHandlersV2x(V201_CERTIFICATE_MAPPING);
const v21 = buildCertificateHandlersV2x(V21_CERTIFICATE_MAPPING);

describe("2.x certificate handlers (#456)", () => {
  it("rejects an install once CertificateStoreMaxLength roots are installed (M05.FR.06)", async () => {
    const store = new CertificateStore();
    const { ctx } = context(store, 1);
    const a = await selfSignedRoot("01", "A");
    const b = await selfSignedRoot("02", "B");

    expect(
      (
        await v201.InstallCertificate(
          { certificateType: "CSMSRootCertificate", certificate: a.pem },
          ctx,
        )
      ).response,
    ).toEqual({ status: "Accepted" });
    expect(
      (
        await v201.InstallCertificate(
          { certificateType: "CSMSRootCertificate", certificate: b.pem },
          ctx,
        )
      ).response,
    ).toEqual({ status: "Rejected" });
    expect(store.listRootCertificates()).toHaveLength(1);
  });

  it("leaves out, on 2.0.1, a root whose use only 2.1 names", async () => {
    // One state database read by a 2.1 station, then by a 2.0.1 one.
    const store = new CertificateStore();
    const oem = await selfSignedRoot("01", "OEM");
    await v21.InstallCertificate(
      { certificateType: "OEMRootCertificate", certificate: oem.pem },
      context(store).ctx,
    );

    const onV201 = (await v201.GetInstalledCertificateIds(
      {},
      context(store).ctx,
    )) as V201HandlerResult;
    expect(onV201.response).toEqual({ status: "NotFound" });

    const onV21 = (await v21.GetInstalledCertificateIds(
      {},
      context(store).ctx,
    )) as V201HandlerResult;
    expect(onV21.response).toMatchObject({
      status: "Accepted",
      certificateHashDataChain: [{ certificateType: "OEMRootCertificate" }],
    });
  });

  it("reports at most 4 sub-CAs under a V2G chain (schema 0..4)", async () => {
    const store = new CertificateStore();
    const root = await selfSignedRoot("01", "Root");
    let issuer = root;
    const cas = [];
    for (let i = 0; i < 5; i++) {
      issuer = await subCa(`1${i}`, `Sub-CA ${i}`, issuer);
      cas.unshift(issuer.pem);
    }
    const csr = await store.generateNewCsr(
      "CP",
      "CPO",
      undefined,
      "V2GCertificate",
    );
    const leaf = await leafForCsr("20", csr, issuer);
    const { ctx: signCtx } = context(store);
    expect(
      (
        await v201.CertificateSigned(
          {
            certificateChain: [leaf, ...cas].join("\n"),
            certificateType: "V2GCertificate",
          },
          signCtx,
        )
      ).response,
    ).toEqual({ status: "Accepted" });

    const { ctx, logger } = context(store);
    const listed = (await v201.GetInstalledCertificateIds(
      { certificateType: ["V2GCertificateChain"] },
      ctx,
    )) as V201HandlerResult;
    const response = listed.response as {
      certificateHashDataChain: { childCertificateHashData: unknown[] }[];
    };
    expect(
      response.certificateHashDataChain[0].childCertificateHashData,
    ).toHaveLength(4);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reporting the first 4"),
      expect.anything(),
    );
  });

  it("rejects a leaf that does not carry the pending CSR's key and raises the event once written (A02.FR.07)", async () => {
    const store = new CertificateStore();
    await store.generateNewCsr("CP", "CPO");
    const root = await selfSignedRoot("01", "Root");
    const { pem: otherCsr } = await generateCsr("CP", "CPO");
    const { ctx, sendCall } = context(store);

    const handled = await v201.CertificateSigned(
      { certificateChain: await leafForCsr("02", otherCsr, root) },
      ctx,
    );

    expect(handled.response).toEqual({ status: "Rejected" });
    expect(store.pendingCsr("ChargingStationCertificate")).toBeDefined();
    expect(sendCall).not.toHaveBeenCalled();
    handled.afterResult?.();
    expect(sendCall).toHaveBeenCalledWith(
      "SecurityEventNotification",
      expect.objectContaining({
        type: "InvalidChargingStationCertificate",
        techInfo: "the leaf does not match the pending CSR's public key",
      }),
    );
  });

  it("rejects a chain that is not PEM certificates", async () => {
    const store = new CertificateStore();
    await store.generateNewCsr("CP", "CPO");
    const { ctx } = context(store);

    const handled = await v201.CertificateSigned(
      { certificateChain: "not a certificate" },
      ctx,
    );

    expect(handled.response).toEqual({ status: "Rejected" });
    expect(handled.afterResult).toBeTypeOf("function");
  });
});

const VERSIONS = [
  {
    name: "2.0.1",
    handlers: v201,
    validGetIds: isValidGetInstalledCertificateIdsResponseV201,
    validInstall: isValidInstallCertificateResponseV201,
    validSigned: isValidCertificateSignedResponseV201,
    validEvent: isValidSecurityEventNotificationRequestV201,
  },
  {
    name: "2.1",
    handlers: v21,
    validGetIds: isValidGetInstalledCertificateIdsResponseV21,
    validInstall: isValidInstallCertificateResponseV21,
    validSigned: isValidCertificateSignedResponseV21,
    validEvent: isValidSecurityEventNotificationRequestV21,
  },
] as const;

describe.each(VERSIONS)(
  "$name certificate handlers after review (#456)",
  ({ handlers, validGetIds, validInstall, validSigned, validEvent }) => {
    it("lists a certificate whose install was dispatched just before the query", async () => {
      const store = new CertificateStore();
      const root = await selfSignedRoot("01", "Root");

      const installed = handlers.InstallCertificate(
        { certificateType: "CSMSRootCertificate", certificate: root.pem },
        context(store).ctx,
      );
      const listed = handlers.GetInstalledCertificateIds(
        {},
        context(store).ctx,
      );

      expect((await installed).response).toEqual({ status: "Accepted" });
      const { response } = await listed;
      expect(response).toMatchObject({
        status: "Accepted",
        certificateHashDataChain: [{ certificateType: "CSMSRootCertificate" }],
      });
      expect(validGetIds(response)).toBe(true);
    });

    it("deletes a certificate whose install was dispatched just before the delete", async () => {
      const store = new CertificateStore();
      const root = await selfSignedRoot("01", "Root");
      const hash = await computeCertificateHashData(root.pem);

      const installed = handlers.InstallCertificate(
        { certificateType: "CSMSRootCertificate", certificate: root.pem },
        context(store).ctx,
      );
      const deleted = handlers.DeleteCertificate(
        { certificateHashData: hash },
        context(store).ctx,
      );

      expect((await installed).response).toEqual({ status: "Accepted" });
      expect((await deleted).response).toEqual({ status: "Accepted" });
      expect(store.listRootCertificates()).toEqual([]);
    });

    it("replaces a reinstalled certificate (M05.FR.17), even in a full store", async () => {
      const store = new CertificateStore();
      const root = await selfSignedRoot("01", "Root");
      const install = () =>
        handlers.InstallCertificate(
          { certificateType: "CSMSRootCertificate", certificate: root.pem },
          context(store, 1).ctx,
        );

      expect((await install()).response).toEqual({ status: "Accepted" });
      const again = (await install()).response;

      expect(again).toEqual({ status: "Accepted" });
      expect(validInstall(again)).toBe(true);
      expect(store.listRootCertificates()).toHaveLength(1);
    });

    it("answers Failed when the certificate cannot be persisted (M05.FR.03)", async () => {
      const database: Database = {
        exec() {},
        run(sql: string) {
          if (sql.startsWith("INSERT")) throw new Error("disk I/O error");
        },
        all: <T>() => [] as T[],
        get: () => null,
        close() {},
      };
      const store = new CertificateStore("CP", database);
      const root = await selfSignedRoot("01", "Root");

      const { response } = await handlers.InstallCertificate(
        { certificateType: "CSMSRootCertificate", certificate: root.pem },
        context(store).ctx,
      );

      expect(response).toEqual({ status: "Failed" });
      expect(validInstall(response)).toBe(true);
      expect(store.listRootCertificates()).toEqual([]);
    });

    it("answers schema-valid GetInstalledCertificateIds with truncated sub-CAs", async () => {
      const store = new CertificateStore();
      let issuer = await selfSignedRoot("01", "Root");
      const cas = [];
      for (let i = 0; i < 5; i++) {
        issuer = await subCa(`1${i}`, `Sub-CA ${i}`, issuer);
        cas.unshift(issuer.pem);
      }
      const csr = await store.generateNewCsr(
        "CP",
        "CPO",
        undefined,
        "V2GCertificate",
      );
      const leaf = await leafForCsr("20", csr, issuer);
      const signed = await handlers.CertificateSigned(
        {
          certificateChain: [leaf, ...cas].join("\n"),
          certificateType: "V2GCertificate",
        },
        context(store).ctx,
      );
      expect(validSigned(signed.response)).toBe(true);

      const { response } = await handlers.GetInstalledCertificateIds(
        { certificateType: ["V2GCertificateChain"] },
        context(store).ctx,
      );

      expect(
        (response as { certificateHashDataChain: unknown[] })
          .certificateHashDataChain,
      ).toHaveLength(1);
      expect(validGetIds(response)).toBe(true);
    });

    it("sends a schema-valid SecurityEventNotification for a rejected chain", async () => {
      const store = new CertificateStore();
      const { ctx, sendCall } = context(store);

      const handled = await handlers.CertificateSigned(
        { certificateChain: "not a certificate" },
        ctx,
      );
      handled.afterResult?.();

      expect(validSigned(handled.response)).toBe(true);
      expect(sendCall).toHaveBeenCalledTimes(1);
      const [action, payload] = sendCall.mock.calls[0];
      expect(action).toBe("SecurityEventNotification");
      expect(validEvent(payload)).toBe(true);
    });
  },
);
