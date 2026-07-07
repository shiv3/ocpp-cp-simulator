import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import * as x509 from "@peculiar/x509";

import type {
  DeleteCertificateResponseV16,
  GetInstalledCertificateIdsResponseV16,
  InstallCertificateResponseV16,
} from "../../../../ocpp";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms } from "./mockCsms";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

const EC_ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

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

async function selfSignedRootCertPem(): Promise<string> {
  const keys = await crypto.subtle.generateKey(EC_ALG, true, [
    "sign",
    "verify",
  ]);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Extras Root CA,O=Example",
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    signingAlgorithm: EC_ALG,
    keys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return cert.toString("pem");
}

/** Boots the CP and drains the post-boot StatusNotification fan-out
 *  (connector 0 + connector 1) so it doesn't interfere with later
 *  `waitForCall` assertions. No SecurityProfile is set, so no
 *  SecurityEventNotification(StartupOfTheDevice) is expected. */
async function bootAndDrain(
  csms: ReturnType<typeof startMockCsms>,
): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-30T00:00:00.000Z",
    interval: 300,
  });
  for (const connectorId of [0, 1]) {
    const frame = await csms.waitForFrame(
      (candidate) =>
        candidate[0] === 2 &&
        candidate[2] === "StatusNotification" &&
        (candidate[3] as { connectorId?: number }).connectorId === connectorId,
    );
    csms.replyCallResult(frame[1] as string, {});
  }
}

describe.skipIf(!canBindBunServe())(
  "OCPP 1.6 Security Whitepaper — remaining message set (#94b) wiring",
  () => {
    it("ExtendedTriggerMessage(Heartbeat) is accepted and fires a Heartbeat", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-XTM",
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
      );
      cp.events.on("error", () => undefined);
      try {
        cp.connect();
        await bootAndDrain(csms);

        const messageId = crypto.randomUUID();
        csms.send([
          2,
          messageId,
          "ExtendedTriggerMessage",
          {
            requestedMessage: "Heartbeat",
          },
        ]);

        const response = await csms.waitForFrame(
          (frame) => frame[0] === 3 && frame[1] === messageId,
        );
        expect(response[2]).toEqual({ status: "Accepted" });

        await csms.waitForCall("Heartbeat");
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("install → get → delete round-trips a root certificate over the wire", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-CERTMGMT",
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
      );
      cp.events.on("error", () => undefined);
      try {
        cp.connect();
        await bootAndDrain(csms);

        const pem = await selfSignedRootCertPem();

        const installId = crypto.randomUUID();
        csms.send([
          2,
          installId,
          "InstallCertificate",
          {
            certificateType: "ManufacturerRootCertificate",
            certificate: pem,
          },
        ]);
        const installResponse = await csms.waitForFrame(
          (frame) => frame[0] === 3 && frame[1] === installId,
        );
        expect(installResponse[2] as InstallCertificateResponseV16).toEqual({
          status: "Accepted",
        });

        const getId = crypto.randomUUID();
        csms.send([
          2,
          getId,
          "GetInstalledCertificateIds",
          {
            certificateType: "ManufacturerRootCertificate",
          },
        ]);
        const getResponse = await csms.waitForFrame(
          (frame) => frame[0] === 3 && frame[1] === getId,
        );
        const getPayload =
          getResponse[2] as GetInstalledCertificateIdsResponseV16;
        expect(getPayload.status).toBe("Accepted");
        expect(getPayload.certificateHashData).toHaveLength(1);

        const deleteId = crypto.randomUUID();
        csms.send([
          2,
          deleteId,
          "DeleteCertificate",
          {
            certificateHashData: getPayload.certificateHashData![0],
          },
        ]);
        const deleteResponse = await csms.waitForFrame(
          (frame) => frame[0] === 3 && frame[1] === deleteId,
        );
        expect(deleteResponse[2] as DeleteCertificateResponseV16).toEqual({
          status: "Accepted",
        });

        expect(cp.certificateStore.listRootCerts()).toEqual([]);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("GetLog is accepted and reports Uploading then Uploaded with requestId", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-GETLOG",
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
      );
      cp.events.on("error", () => undefined);
      try {
        cp.connect();
        await bootAndDrain(csms);

        const messageId = crypto.randomUUID();
        csms.send([
          2,
          messageId,
          "GetLog",
          {
            logType: "DiagnosticsLog",
            requestId: 77,
            log: { remoteLocation: "http://example.invalid/upload" },
          },
        ]);

        const response = await csms.waitForFrame(
          (frame) => frame[0] === 3 && frame[1] === messageId,
        );
        expect(response[2]).toEqual({
          status: "Accepted",
          filename: "CP016-GETLOG-DiagnosticsLog-77.log",
        });

        const uploading = await csms.waitForCall("LogStatusNotification", 4000);
        expect(uploading.payload).toEqual({
          status: "Uploading",
          requestId: 77,
        });
        csms.replyCallResult(uploading.messageId, {});

        const uploaded = await csms.waitForFrame(
          (frame) =>
            frame[0] === 2 &&
            frame[2] === "LogStatusNotification" &&
            (frame[3] as { status?: string }).status === "Uploaded",
          4000,
        );
        expect(uploaded[3]).toEqual({ status: "Uploaded", requestId: 77 });
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("SignedUpdateFirmware is accepted and starts the Downloading train with requestId", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-SIGNEDFW",
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
      );
      cp.events.on("error", () => undefined);
      try {
        cp.connect();
        await bootAndDrain(csms);

        const messageId = crypto.randomUUID();
        csms.send([
          2,
          messageId,
          "SignedUpdateFirmware",
          {
            requestId: 55,
            firmware: {
              location: "http://example.invalid/firmware.bin",
              retrieveDateTime: new Date().toISOString(),
              signingCertificate:
                "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
              signature: "deadbeef",
            },
          },
        ]);

        const response = await csms.waitForFrame(
          (frame) => frame[0] === 3 && frame[1] === messageId,
        );
        expect(response[2]).toEqual({ status: "Accepted" });

        const downloading = await csms.waitForCall(
          "SignedFirmwareStatusNotification",
          4000,
        );
        expect(downloading.payload).toEqual({
          status: "Downloading",
          requestId: 55,
        });
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  },
);
