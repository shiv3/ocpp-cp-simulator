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
} from "@ocpp-cp-simulator/ocpp/index";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import type { CertificateRepository } from "../../../../domain/persistence/CertificateRepository";
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

function context(
  store: CertificateStore,
  maxEntries = 10,
  maxChainSize = 10000,
) {
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
      configuration: {
        certificateStoreMaxLength: () => maxEntries,
        maxCertificateChainSize: () => maxChainSize,
      },
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
      const repository: CertificateRepository = {
        loadAll: () => [],
        insert() {
          throw new Error("disk I/O error");
        },
        delete() {},
        clear() {},
      };
      const store = new CertificateStore(repository);
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

      const chain = (
        response as {
          certificateHashDataChain: { childCertificateHashData: unknown[] }[];
        }
      ).certificateHashDataChain;
      expect(chain).toHaveLength(1);
      expect(validGetIds(response)).toBe(true);
      // The validator does enforce the 0..4 bound the handler caps to.
      const [entry] = chain;
      const untruncated = {
        ...(response as object),
        certificateHashDataChain: [
          {
            ...entry,
            childCertificateHashData: [
              ...entry.childCertificateHashData,
              entry.childCertificateHashData[0],
            ],
          },
        ],
      };
      expect(validGetIds(untruncated)).toBe(false);
    });

    it("answers a query and a delete synchronously once no install is pending", async () => {
      const store = new CertificateStore();
      const root = await selfSignedRoot("01", "Root");
      const hash = await computeCertificateHashData(root.pem);
      await handlers.InstallCertificate(
        { certificateType: "CSMSRootCertificate", certificate: root.pem },
        context(store).ctx,
      );

      const listed = handlers.GetInstalledCertificateIds(
        {},
        context(store).ctx,
      );
      expect(listed).not.toBeInstanceOf(Promise);
      expect((listed as V201HandlerResult).response).toMatchObject({
        status: "Accepted",
      });

      const deleted = handlers.DeleteCertificate(
        { certificateHashData: hash },
        context(store).ctx,
      );
      expect(deleted).not.toBeInstanceOf(Promise);
      expect((deleted as V201HandlerResult).response).toEqual({
        status: "Accepted",
      });
    });

    // #537 A02.FR.16 (SHALL on 2.0.1, MAY on 2.1): a chain longer than
    // MaxCertificateChainSize is Rejected before it is even parsed.
    it("rejects a certificateChain longer than MaxCertificateChainSize (A02.FR.16)", async () => {
      const store = new CertificateStore();
      const root = await selfSignedRoot("01", "Root");
      const csr = await store.generateNewCsr("CP", "CPO");
      const leaf = await leafForCsr("02", csr, root);

      const tooLong = await handlers.CertificateSigned(
        { certificateChain: leaf },
        context(store, 10, leaf.length - 1).ctx,
      );
      expect(tooLong.response).toEqual({ status: "Rejected" });
      expect(validSigned(tooLong.response)).toBe(true);
      expect(store.listSignedChains()).toEqual([]);

      const atLimit = await handlers.CertificateSigned(
        { certificateChain: leaf },
        context(store, 10, leaf.length).ctx,
      );
      expect(atLimit.response).toEqual({ status: "Accepted" });
    });

    // #537: an installed chain is the only thing that ends a CSR's resend
    // back-off, so a rejected one must not report an install.
    describe("the certificateInstalled notification", () => {
      function signingContext(store: CertificateStore, maxChainSize = 10000) {
        const certificateInstalled = vi.fn();
        const certificateStored = vi.fn();
        const certificateRejected = vi.fn();
        const ctx: V201InboundContext = {
          ...context(store, 10, maxChainSize).ctx,
          certificateSigning: {
            requestSignature: vi.fn(),
            isKnownSignRequestId: () => true,
            requestCombinedSignature: vi.fn(),
            certificateStored,
            certificateInstalled,
            certificateRejected,
          },
        };
        return {
          ctx,
          certificateInstalled,
          certificateStored,
          certificateRejected,
        };
      }

      // #587 A02.FR.06/07/20
      it("rejects an expired leaf with the security event and ends the resends, but not for a superseded CSR", async () => {
        const store = new CertificateStore();
        const root = await selfSignedRoot("01", "Root");
        const csr = await store.generateNewCsr("CP", "CPO");
        const { ctx, certificateRejected, certificateStored } =
          signingContext(store);

        const expired = await handlers.CertificateSigned(
          {
            certificateChain: await leafForCsr("02", csr, root, {
              notBeforeOffsetMs: -86_400_000,
              notAfterOffsetMs: -1_000,
            }),
            certificateType: "ChargingStationCertificate",
          },
          ctx,
        );
        expect(expired.response).toEqual({ status: "Rejected" });
        expect(validSigned(expired.response)).toBe(true);
        expect(certificateRejected).toHaveBeenCalledExactlyOnceWith(
          "ChargingStationCertificate",
        );
        expect(certificateStored).not.toHaveBeenCalled();
        await expired.afterResult?.();
        expect(ctx.sendCall).toHaveBeenCalledWith(
          "SecurityEventNotification",
          expect.objectContaining({
            type: "InvalidChargingStationCertificate",
          }),
        );
        expect(store.listSignedChains()).toEqual([]);

        certificateRejected.mockClear();
        const other = await generateCsr("CP-OTHER", "CPO");
        const superseded = await handlers.CertificateSigned(
          {
            certificateChain: await leafForCsr("03", other.pem, root, {
              notBeforeOffsetMs: -86_400_000,
              notAfterOffsetMs: -1_000,
            }),
            certificateType: "ChargingStationCertificate",
          },
          ctx,
        );
        expect(superseded.response).toEqual({ status: "Rejected" });
        expect(certificateRejected).not.toHaveBeenCalled();
      });

      // #587: 2.0.1 ed4 and 2.1 ed2 A02.FR.06/07 both ask for the current
      // date to be within the validity period.
      it("rejects a leaf that is not valid yet, with the security event", async () => {
        const store = new CertificateStore();
        const root = await selfSignedRoot("01", "Root");
        const csr = await store.generateNewCsr("CP", "CPO");
        const { ctx, certificateRejected, certificateInstalled } =
          signingContext(store);

        const result = await handlers.CertificateSigned(
          {
            certificateChain: await leafForCsr("02", csr, root, {
              notBeforeOffsetMs: 3_600_000,
            }),
            certificateType: "ChargingStationCertificate",
          },
          ctx,
        );
        expect(result.response).toEqual({ status: "Rejected" });
        expect(certificateRejected).toHaveBeenCalledTimes(1);
        expect(certificateInstalled).not.toHaveBeenCalled();
        expect(store.listSignedChains()).toEqual([]);
        await result.afterResult?.();
        expect(ctx.sendCall).toHaveBeenCalledWith(
          "SecurityEventNotification",
          expect.objectContaining({
            type: "InvalidChargingStationCertificate",
          }),
        );
      });

      // #587 A02.FR.06/07/20 (TC_A_14_CS): a leaf outside the operator
      // hierarchy, or with wrong Certificate Properties, is Rejected with the
      // event and ends the resends like an expired one.
      it.each([
        ["outside the CSMS root hierarchy", undefined, "does not lead to"],
        [
          "with a URL as commonName",
          "CN=wss://csms.example.com,O=Example",
          "A00.FR.511",
        ],
      ])(
        "rejects a leaf %s, with the security event and no further resends",
        async (_label, subject, expectedReason) => {
          const store = new CertificateStore();
          const root = await selfSignedRoot("01", "Root");
          await store.installRootCertificate("CsmsRootCertificate", root.pem, {
            maxEntries: 10,
          });
          const csr = await store.generateNewCsr("CP", "CPO");
          const issuer = subject
            ? root
            : await selfSignedRoot("09", "Invalid Signing CA");
          const { ctx, certificateRejected, certificateInstalled } =
            signingContext(store);

          const result = await handlers.CertificateSigned(
            {
              certificateChain: await leafForCsr("02", csr, issuer, {
                subject,
              }),
              certificateType: "ChargingStationCertificate",
            },
            ctx,
          );
          expect(result.response).toEqual({ status: "Rejected" });
          expect(certificateRejected).toHaveBeenCalledTimes(1);
          expect(certificateInstalled).not.toHaveBeenCalled();
          expect(store.listSignedChains()).toEqual([]);
          await result.afterResult?.();
          expect(ctx.sendCall).toHaveBeenCalledWith(
            "SecurityEventNotification",
            expect.objectContaining({
              type: "InvalidChargingStationCertificate",
              techInfo: expect.stringContaining(expectedReason),
            }),
          );
        },
      );

      // #564: the chain is handed on when it is stored, not when the answer
      // is written, which a dropped answer never reaches.
      it("reports a stored chain before its answer is written, and none that was rejected", async () => {
        const store = new CertificateStore();
        const root = await selfSignedRoot("01", "Root");
        const csr = await store.generateNewCsr("CP", "CPO");
        const { ctx, certificateStored } = signingContext(store);

        const accepted = await handlers.CertificateSigned(
          {
            certificateChain: await leafForCsr("02", csr, root),
            certificateType: "ChargingStationCertificate",
          },
          ctx,
        );

        expect(accepted.response).toEqual({ status: "Accepted" });
        expect(certificateStored).toHaveBeenCalledExactlyOnceWith(
          "ChargingStationCertificate",
        );

        certificateStored.mockClear();
        const rejected = await handlers.CertificateSigned(
          { certificateChain: "not a certificate" },
          ctx,
        );
        expect(rejected.response).toEqual({ status: "Rejected" });
        expect(certificateStored).not.toHaveBeenCalled();
      });

      // #553 + #564: a combined certificate (certificateType omitted) is the
      // Charging Station certificate, so it is handed on like one.
      it("reports a combined certificate as the Charging Station certificate", async () => {
        const store = new CertificateStore();
        const root = await selfSignedRoot("01", "Root");
        const csr = await store.generateNewCsr("CP", "CPO");
        const { ctx, certificateStored } = signingContext(store);

        const accepted = await handlers.CertificateSigned(
          { certificateChain: await leafForCsr("02", csr, root) },
          ctx,
        );

        expect(accepted.response).toEqual({ status: "Accepted" });
        expect(certificateStored).toHaveBeenCalledExactlyOnceWith(
          "ChargingStationCertificate",
        );
      });

      it("comes after an Accepted chain's answer, not before", async () => {
        const store = new CertificateStore();
        const root = await selfSignedRoot("01", "Root");
        const csr = await store.generateNewCsr("CP", "CPO");
        const { ctx, certificateInstalled } = signingContext(store);

        const handled = await handlers.CertificateSigned(
          {
            certificateChain: await leafForCsr("02", csr, root),
            certificateType: "ChargingStationCertificate",
          },
          ctx,
        );

        expect(handled.response).toEqual({ status: "Accepted" });
        expect(certificateInstalled).not.toHaveBeenCalled();
        handled.afterResult?.();
        expect(certificateInstalled).toHaveBeenCalledWith(
          "ChargingStationCertificate",
        );
      });

      it.each<
        [
          string,
          (store: CertificateStore) => Promise<Record<string, unknown>>,
          number,
        ]
      >([
        [
          "a chain over MaxCertificateChainSize",
          async () => ({ certificateChain: "x".repeat(11) }),
          10,
        ],
        [
          "a malformed chain",
          async (store) => {
            await store.generateNewCsr("CP", "CPO");
            return { certificateChain: "not a certificate" };
          },
          10000,
        ],
        [
          "a leaf for another key",
          async (store) => {
            await store.generateNewCsr("CP", "CPO");
            const other = await new CertificateStore().generateNewCsr(
              "CP",
              "CPO",
            );
            const root = await selfSignedRoot("01", "Root");
            return { certificateChain: await leafForCsr("02", other, root) };
          },
          10000,
        ],
        [
          "no pending CSR",
          async () => {
            const other = await new CertificateStore().generateNewCsr(
              "CP",
              "CPO",
            );
            const root = await selfSignedRoot("01", "Root");
            return { certificateChain: await leafForCsr("02", other, root) };
          },
          10000,
        ],
        [
          "an unsupported certificateType",
          async () => ({
            certificateChain: "any",
            certificateType: "NotACertificateType",
          }),
          10000,
        ],
      ])("does not come for %s", async (_name, payload, maxChainSize) => {
        const store = new CertificateStore();
        const { ctx, certificateInstalled } = signingContext(
          store,
          maxChainSize,
        );

        const handled = await handlers.CertificateSigned(
          await payload(store),
          ctx,
        );

        expect(handled.response).toEqual({ status: "Rejected" });
        handled.afterResult?.();
        expect(certificateInstalled).not.toHaveBeenCalled();
      });
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
