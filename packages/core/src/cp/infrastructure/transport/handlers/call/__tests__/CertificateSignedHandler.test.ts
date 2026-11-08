import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  CertificateSignedHandler,
  splitPemChain,
} from "../CertificateSignedHandler";
import {
  leafForCsr,
  selfSignedRoot,
  subCa,
  withTrailingDerBytes,
} from "../../../../../domain/security/__tests__/certificateFixtures";
import { CertificateStore } from "../../../../../domain/security/CertificateStore";
import type { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";
import type { Logger } from "../../../../../shared/Logger";
import { isHandlerOutcome } from "../../../network-sim/ResponseEffectQueue";

describe("splitPemChain", () => {
  it("splits a concatenated chain into trimmed PEM blocks", async () => {
    const leaf = await selfSignedRoot("01", "Leaf");
    const root = await selfSignedRoot("02", "Root");

    expect(splitPemChain(`${leaf.pem}\n${root.pem}\n`)).toEqual([
      leaf.pem.trim(),
      root.pem.trim(),
    ]);
  });

  it("rejects a chain whose certificate carries trailing bytes after its DER structure", async () => {
    const leaf = await selfSignedRoot("01", "Leaf");
    const root = await selfSignedRoot("02", "Root");

    expect(
      splitPemChain(`${withTrailingDerBytes(leaf.pem)}\n${root.pem}`),
    ).toBeNull();
  });
});

/**
 * #732 A02.FR.06 / A02.FR.07: the signed Charge Point certificate is checked
 * (validity period, signature chain, installed CSMS roots, pending CSR key);
 * an invalid one is Rejected, discarded, and reported as an
 * InvalidChargePointCertificate security event once the answer is written.
 */
describe("CertificateSignedHandler (1.6)", () => {
  const DAY = 86_400_000;

  async function station() {
    const store = new CertificateStore();
    const csr = await store.generateNewCsr("CP-732", "Example CPO");
    const sendSecurityEventNotification = vi.fn(() => Promise.resolve());
    const chargePoint = {
      certificateStore: store,
      certificateQuirks: {},
      nowDate: () => new Date(),
      sendSecurityEventNotification,
    } as unknown as ChargePoint;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    const run = async (certificateChain: string) => {
      const result = await new CertificateSignedHandler().handle(
        { certificateChain },
        { chargePoint, logger },
      );
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        return result.payload;
      }
      return result;
    };
    return { store, csr, run, sendSecurityEventNotification };
  }

  async function expectRejected(
    run: (chain: string) => Promise<unknown>,
    chain: string,
    store: CertificateStore,
    event: ReturnType<typeof vi.fn>,
  ) {
    const before = store.listSignedChains();
    expect(await run(chain)).toEqual({ status: "Rejected" });
    expect(store.listSignedChains()).toEqual(before);
    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith(
      "InvalidChargePointCertificate",
      expect.any(String),
    );
  }

  it("accepts a valid chain and sends no event", async () => {
    const { store, csr, run, sendSecurityEventNotification } = await station();
    const root = await selfSignedRoot("01", "CPO Root");
    await store.installRootCertificate("CsmsRootCertificate", root.pem, {
      maxEntries: 10,
    });
    const sub = await subCa("02", "CPO Sub", root);
    const leaf = await leafForCsr("03", csr, sub);

    expect(await run(`${leaf}\n${sub.pem}`)).toEqual({ status: "Accepted" });
    expect(store.listSignedChains()).toHaveLength(1);
    expect(sendSecurityEventNotification).not.toHaveBeenCalled();
  });

  it("accepts a valid chain when no root is installed", async () => {
    const { store, csr, run, sendSecurityEventNotification } = await station();
    const issuer = await selfSignedRoot("01", "Issuer");
    const leaf = await leafForCsr("03", csr, issuer);

    expect(await run(leaf)).toEqual({ status: "Accepted" });
    expect(store.listSignedChains()).toHaveLength(1);
    expect(sendSecurityEventNotification).not.toHaveBeenCalled();
  });

  it("rejects an expired leaf, keeping the stored chain", async () => {
    const { store, csr, run, sendSecurityEventNotification } = await station();
    const root = await selfSignedRoot("01", "CPO Root");
    const good = await leafForCsr("03", csr, root);
    expect(await run(good)).toEqual({ status: "Accepted" });
    const expired = await leafForCsr("04", csr, root, {
      notBefore: new Date(Date.now() - 3 * DAY),
      notAfter: new Date(Date.now() - DAY),
    });
    await expectRejected(run, expired, store, sendSecurityEventNotification);
    expect(store.listSignedChains()[0].pems[0]).toBe(good.trim());
  });

  it("rejects a leaf that is not valid yet", async () => {
    const { store, csr, run, sendSecurityEventNotification } = await station();
    const root = await selfSignedRoot("01", "CPO Root");
    const future = await leafForCsr("04", csr, root, {
      notBefore: new Date(Date.now() + DAY),
      notAfter: new Date(Date.now() + 3 * DAY),
    });
    await expectRejected(run, future, store, sendSecurityEventNotification);
  });

  it("rejects a leaf outside the installed CSMS root hierarchy", async () => {
    const { store, csr, run, sendSecurityEventNotification } = await station();
    const root = await selfSignedRoot("01", "CPO Root");
    const other = await selfSignedRoot("02", "Other CA");
    await store.installRootCertificate("CsmsRootCertificate", root.pem, {
      maxEntries: 10,
    });
    const leaf = await leafForCsr("03", csr, other);
    await expectRejected(run, leaf, store, sendSecurityEventNotification);
  });

  it("rejects a chain whose certificates are not signed by the next one", async () => {
    const { store, csr, run, sendSecurityEventNotification } = await station();
    const root = await selfSignedRoot("01", "CPO Root");
    const other = await selfSignedRoot("02", "CPO Root");
    const leaf = await leafForCsr("03", csr, root);
    await expectRejected(
      run,
      `${leaf}\n${other.pem}`,
      store,
      sendSecurityEventNotification,
    );
  });

  it("rejects a leaf that does not carry the pending CSR's key", async () => {
    const { store, run, sendSecurityEventNotification } = await station();
    const root = await selfSignedRoot("01", "CPO Root");
    const foreign = await new CertificateStore().generateNewCsr("CP-X", "X");
    const leaf = await leafForCsr("03", foreign, root);
    await expectRejected(run, leaf, store, sendSecurityEventNotification);
  });

  it("rejects a malformed chain and sends the event", async () => {
    const { store, run, sendSecurityEventNotification } = await station();
    await expectRejected(
      run,
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      store,
      sendSecurityEventNotification,
    );
  });
});
