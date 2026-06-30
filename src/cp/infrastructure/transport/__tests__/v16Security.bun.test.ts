import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import * as x509 from "@peculiar/x509";

import type {
  SecurityEventNotificationRequestV16,
  SignCertificateRequestV16,
} from "../../../../ocpp";
import {
  isValidSecurityEventNotificationRequestV16,
  isValidSignCertificateRequestV16,
} from "../../../../ocpp";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms } from "./mockCsms";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

const EC_ALG = {
  name: "ECDSA",
  namedCurve: "P-256",
  hash: "SHA-256",
} as const;

function canBindBunServe(): boolean {
  try {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok");
      },
    });
    void server.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function replyStatusNotification(
  csms: ReturnType<typeof startMockCsms>,
  connectorId: number,
  status: string,
): Promise<void> {
  const frame = await csms.waitForFrame(
    (candidate) =>
      candidate[0] === 2 &&
      candidate[2] === "StatusNotification" &&
      (candidate[3] as { connectorId?: number; status?: string })
        .connectorId === connectorId &&
      (candidate[3] as { connectorId?: number; status?: string }).status ===
        status,
  );
  csms.replyCallResult(frame[1] as string, {});
}

async function acceptBootAndDrainStartup(
  csms: ReturnType<typeof startMockCsms>,
): Promise<SecurityEventNotificationRequestV16> {
  const boot = await csms.waitForCall("BootNotification");
  expect(
    csms.received.some((frame) => frame[2] === "SecurityEventNotification"),
  ).toBe(false);
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-30T00:00:00.000Z",
    interval: 300,
  });

  const startup = await csms.waitForCall("SecurityEventNotification");
  const startupPayload = startup.payload as SecurityEventNotificationRequestV16;
  expect(isValidSecurityEventNotificationRequestV16(startupPayload)).toBe(true);
  expect(startupPayload.type).toBe("StartupOfTheDevice");
  csms.replyCallResult(startup.messageId, {});

  await replyStatusNotification(csms, 0, "Available");
  await replyStatusNotification(csms, 1, "Available");

  return startupPayload;
}

async function selfSignedCertificatePem(): Promise<string> {
  const keys = await crypto.subtle.generateKey(EC_ALG, true, [
    "sign",
    "verify",
  ]);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=CP016-SEC,O=Example CPO",
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    signingAlgorithm: EC_ALG,
    keys,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
  });
  return cert.toString("pem");
}

describe.skipIf(!canBindBunServe())(
  "OCPP 1.6 security whitepaper slice",
  () => {
    it("sends StartupOfTheDevice SecurityEventNotification only after BootNotification Accepted", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-SEC-BOOT",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        {},
        1,
        "startup-auth-key",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();

        const startupPayload = await acceptBootAndDrainStartup(csms);

        expect(typeof startupPayload.timestamp).toBe("string");
        expect(Date.parse(startupPayload.timestamp)).not.toBeNaN();
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("sendSignCertificate sends a well-formed SignCertificate with a parseable CSR", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-SEC-CSR",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        {},
        1,
        "startup-auth-key",
        "Example CPO",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();
        await acceptBootAndDrainStartup(csms);

        await cp.sendSignCertificate();

        const signCertificate = await csms.waitForCall("SignCertificate");
        const signPayload =
          signCertificate.payload as SignCertificateRequestV16;
        expect(isValidSignCertificateRequestV16(signPayload)).toBe(true);

        const csr = new x509.Pkcs10CertificateRequest(signPayload.csr);
        expect(csr.subject).toContain("CN=CP016-SEC-CSR");
        expect(csr.subject).toContain("O=Example CPO");
        expect(await csr.verify()).toBe(true);

        csms.replyCallResult(signCertificate.messageId, { status: "Accepted" });
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("stores CertificateSigned certificate chains and responds Accepted", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-SEC-CERT",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        {},
        1,
        "startup-auth-key",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();
        await acceptBootAndDrainStartup(csms);

        const certificate = await selfSignedCertificatePem();
        const messageId = crypto.randomUUID();
        csms.send([
          2,
          messageId,
          "CertificateSigned",
          { certificateChain: certificate },
        ]);

        const response = await csms.waitForFrame(
          (frame) => frame[0] === 3 && frame[1] === messageId,
        );
        // CALLRESULT frame is [3, messageId, payload] — payload is index 2
        // (the `payload()` helper reads index 3, which is for CALL frames).
        expect(response[2] as { status: string }).toEqual({
          status: "Accepted",
        });
        expect(cp.certificateStore.toJSON().signedChains).toEqual([
          [certificate.trim()],
        ]);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  },
);
