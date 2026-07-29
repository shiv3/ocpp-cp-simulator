import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import * as x509 from "@peculiar/x509";

import type {
  CertificateSignedRequestV16,
  GetConfigurationRequestV16,
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

const RSA_PKCS1_ALG = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
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

async function acceptBootAndDrainStartup(
  csms: ReturnType<typeof startMockCsms>,
): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-30T00:00:00.000Z",
    interval: 300,
  });

  const status0 = await csms.waitForFrame(
    (f) =>
      f[0] === 2 &&
      f[2] === "StatusNotification" &&
      (f[3] as { connectorId?: number }).connectorId === 0,
  );
  csms.replyCallResult(status0[1] as string, {});

  const status1 = await csms.waitForFrame(
    (f) =>
      f[0] === 2 &&
      f[2] === "StatusNotification" &&
      (f[3] as { connectorId?: number }).connectorId === 1,
  );
  csms.replyCallResult(status1[1] as string, {});
}

async function certificateWithAlgorithm(
  algorithm: typeof EC_ALG | typeof RSA_PKCS1_ALG | typeof RSA_PSS_ALG,
  serial: string,
): Promise<string> {
  const keys = await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ]);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial,
    name: `CN=${serial}`,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    signingAlgorithm: algorithm,
    keys,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
  });
  return cert.toString("pem");
}

describe.skipIf(!canBindBunServe())(
  "OCPP 1.6 certificate quirks (issue #247)",
  () => {
    // ── CertificateSigned signature algorithm acceptance ──────────────────

    it("CertificateSigned: allowed algorithm → Accepted and stored", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-QUIRKS-SIG-ALLOWED",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();
        await acceptBootAndDrainStartup(csms);

        // Set quirk: only RSASSA-PKCS1-v1_5 allowed
        cp.setCertificateQuirks({
          requiredCertificateSignatureAlgorithms: ["RSASSA-PKCS1-v1_5"],
        });

        const certificate = await certificateWithAlgorithm(RSA_PKCS1_ALG, "01");
        const messageId = crypto.randomUUID();
        csms.send([
          2,
          messageId,
          "CertificateSigned",
          { certificateChain: certificate } as CertificateSignedRequestV16,
        ]);

        const response = await csms.waitForFrame(
          (frame) => frame[0] === 3 && frame[1] === messageId,
        );
        expect((response[2] as { status: string }).status).toBe("Accepted");
        expect(cp.certificateStore.toJSON().signedChains.length).toBe(1);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("CertificateSigned: disallowed algorithm → Rejected, not stored", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-QUIRKS-SIG-DISALLOWED",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();
        await acceptBootAndDrainStartup(csms);

        // Set quirk: only RSASSA-PKCS1-v1_5 allowed, reject ECDSA
        cp.setCertificateQuirks({
          requiredCertificateSignatureAlgorithms: ["RSASSA-PKCS1-v1_5"],
        });

        const certificate = await certificateWithAlgorithm(EC_ALG, "02");
        const messageId = crypto.randomUUID();
        csms.send([
          2,
          messageId,
          "CertificateSigned",
          { certificateChain: certificate } as CertificateSignedRequestV16,
        ]);

        const response = await csms.waitForFrame(
          (frame) => frame[0] === 3 && frame[1] === messageId,
        );
        expect((response[2] as { status: string }).status).toBe("Rejected");
        expect(cp.certificateStore.toJSON().signedChains.length).toBe(0);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("CertificateSigned: quirk unset → Accepted regardless of algorithm", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-QUIRKS-SIG-UNSET",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();
        await acceptBootAndDrainStartup(csms);

        // Quirk is NOT set - any algorithm should be accepted
        const certificate = await certificateWithAlgorithm(EC_ALG, "03");
        const messageId = crypto.randomUUID();
        csms.send([
          2,
          messageId,
          "CertificateSigned",
          { certificateChain: certificate } as CertificateSignedRequestV16,
        ]);

        const response = await csms.waitForFrame(
          (frame) => frame[0] === 3 && frame[1] === messageId,
        );
        expect((response[2] as { status: string }).status).toBe("Accepted");
        expect(cp.certificateStore.toJSON().signedChains.length).toBe(1);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    // ── GetConfiguration key hiding ──────────────────────────────────────

    it("GetConfiguration: hiddenConfigurationKeys → full dump lacks hidden keys", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-QUIRKS-GET-CONFIG-HIDDEN",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();
        await acceptBootAndDrainStartup(csms);

        // Set quirk: hide CpoName from GetConfiguration
        cp.setCertificateQuirks({
          hiddenConfigurationKeys: ["CpoName"],
        });

        // Send GetConfiguration with no keys (full dump)
        csms.send([
          2,
          "config-1",
          "GetConfiguration",
          {} as GetConfigurationRequestV16,
        ]);

        const response = await csms.waitForFrame(
          (f) => f[0] === 3 && f[1] === "config-1",
        );
        const responseData = response[2] as {
          configurationKey?: Array<{ key: string }>;
        };
        const keys = responseData.configurationKey ?? [];

        // CpoName should NOT be in the list
        expect(keys.some((k) => k.key === "CpoName")).toBe(false);
        // But other keys should be present
        expect(keys.length).toBeGreaterThan(0);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("GetConfiguration: explicit request for hidden key → in unknownKey", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-QUIRKS-GET-CONFIG-UNKNOWN",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();
        await acceptBootAndDrainStartup(csms);

        // Set quirk: hide CpoName
        cp.setCertificateQuirks({
          hiddenConfigurationKeys: ["CpoName"],
        });

        // Send GetConfiguration explicitly requesting CpoName
        csms.send([
          2,
          "config-2",
          "GetConfiguration",
          { key: ["CpoName"] } as GetConfigurationRequestV16,
        ]);

        const response = await csms.waitForFrame(
          (f) => f[0] === 3 && f[1] === "config-2",
        );
        const responseData = response[2] as {
          configurationKey?: Array<{ key: string }>;
          unknownKey?: string[];
        };
        const configKeys = responseData.configurationKey ?? [];
        const unknownKeys = responseData.unknownKey ?? [];

        // CpoName should NOT be in configurationKey
        expect(configKeys.some((k) => k.key === "CpoName")).toBe(false);
        // But should be in unknownKey
        expect(unknownKeys).toContain("CpoName");
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("GetConfiguration: after clearCertificateQuirks → hidden key is served again", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-QUIRKS-GET-CONFIG-CLEARED",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();
        await acceptBootAndDrainStartup(csms);

        // Set quirk
        cp.setCertificateQuirks({
          hiddenConfigurationKeys: ["CpoName"],
        });

        // Clear quirks
        cp.clearCertificateQuirks();

        // Send GetConfiguration requesting CpoName
        csms.send([
          2,
          "config-3",
          "GetConfiguration",
          { key: ["CpoName"] } as GetConfigurationRequestV16,
        ]);

        const response = await csms.waitForFrame(
          (f) => f[0] === 3 && f[1] === "config-3",
        );
        const responseData = response[2] as {
          configurationKey?: Array<{ key: string }>;
          unknownKey?: string[];
        };
        const configKeys = responseData.configurationKey ?? [];

        // CpoName should be served normally
        const cpoNameKey = configKeys.find((k) => k.key === "CpoName");
        expect(cpoNameKey).toBeDefined();
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  },
);
