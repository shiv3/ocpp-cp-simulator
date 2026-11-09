import { describe, it, expect } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { createChargePoint } from "../../charge-point/createChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import {
  selfSignedRoot,
  signingLeaf,
} from "../../../domain/security/__tests__/certificateFixtures";

/**
 * #345: on OCPP 2.0.1 the station can follow an accepted UpdateFirmware /
 * GetLog through. The three outbound status messages were warn-only stubs
 * (two of them saying, wrongly, that 2.0.1 has no such message) and the two
 * requests were answered `Rejected`, so no lifecycle could start. Now:
 * UpdateFirmware / GetLog are accepted and their `requestId` remembered;
 * FirmwareStatusNotification / LogStatusNotification go out with the
 * caller's requestId or the remembered one; the 1.6-only Signed variant is
 * the ordinary FirmwareStatusNotification on 2.0.1; PublishFirmware stays
 * refused, with a reason, because the station is not a Local Controller.
 */
async function bootedChargePoint(
  csms: MockCsms,
  id: string,
  version: "OCPP-2.0.1" | "OCPP-2.1" = "OCPP-2.0.1",
): Promise<ChargePoint> {
  const cp = createChargePoint(
    id,
    DefaultBootNotification,
    1,
    csms.url,
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  cp.events.on("error", () => undefined);
  cp.connect();
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-09-17T00:00:00.000Z",
    interval: 300,
  });
  await csms.waitForFrame(
    (frame) => frame[0] === 2 && frame[2] === "StatusNotification",
  );
  return cp;
}

const call = (action: string) => (frame: OcppFrame) =>
  frame[0] === 2 && frame[2] === action;
const resultFor = (messageId: string) => (frame: OcppFrame) =>
  frame[0] === 3 && frame[1] === messageId;

describe("OCPP 2.0.1 firmware / log lifecycles (#345)", () => {
  it("accepts UpdateFirmware and stamps its requestId on the reports that follow", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-FW");
    try {
      csms.send([
        2,
        "uf-1",
        "UpdateFirmware",
        {
          requestId: 41,
          firmware: {
            location: "https://files.example/fw.bin",
            retrieveDateTime: "2026-09-17T00:00:00.000Z",
          },
        },
      ]);
      const ack = await csms.waitForFrame(resultFor("uf-1"));
      expect(ack[2]).toEqual({ status: "Accepted" });

      cp.sendFirmwareStatusNotification("Downloading");
      const report = await csms.waitForFrame(
        call("FirmwareStatusNotification"),
      );
      expect(report[3]).toEqual({ status: "Downloading", requestId: 41 });
      csms.replyCallResult(report[1] as string, {});

      // An explicit requestId wins over the remembered one.
      cp.sendFirmwareStatusNotification("Installed", 7);
      const explicit = await csms.waitForFrame(
        (f) =>
          call("FirmwareStatusNotification")(f) &&
          (f[3] as { status?: string }).status === "Installed",
      );
      expect(explicit[3]).toEqual({ status: "Installed", requestId: 7 });
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("a 2.0.1-only status and the Signed 1.6 variant both go out as FirmwareStatusNotification", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-FW-SIGNED");
    try {
      cp.sendSignedFirmwareStatusNotification("SignatureVerified", 9);
      const report = await csms.waitForFrame(
        call("FirmwareStatusNotification"),
      );
      expect(report[3]).toEqual({ status: "SignatureVerified", requestId: 9 });
      expect(
        csms.received.some(
          (f) => f[0] === 2 && f[2] === "SignedFirmwareStatusNotification",
        ),
      ).toBe(false);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("accepts GetLog with a filename and stamps its requestId on LogStatusNotification", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-LOG");
    try {
      csms.send([
        2,
        "gl-1",
        "GetLog",
        {
          requestId: 12,
          logType: "SecurityLog",
          log: { remoteLocation: "https://files.example/upload" },
        },
      ]);
      const ack = await csms.waitForFrame(resultFor("gl-1"));
      expect(ack[2]).toMatchObject({ status: "Accepted" });
      expect((ack[2] as { filename?: string }).filename).toContain(
        "SecurityLog-12",
      );

      cp.sendLogStatusNotification("Uploading");
      const report = await csms.waitForFrame(call("LogStatusNotification"));
      expect(report[3]).toEqual({ status: "Uploading", requestId: 12 });
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("refuses PublishFirmware with a reason: the station is not a Local Controller", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-PUBLISH");
    try {
      csms.send([
        2,
        "pf-1",
        "PublishFirmware",
        {
          location: "https://files.example/fw.bin",
          checksum: "0".repeat(32),
          requestId: 3,
        },
      ]);
      const ack = await csms.waitForFrame(resultFor("pf-1"));
      expect(ack[2]).toMatchObject({
        status: "Rejected",
        statusInfo: { reasonCode: "NotLocalController" },
      });
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("2.1 inherits the same lifecycle: UpdateFirmware accepted, report stamped", async () => {
    // The 2.1 profile reuses the 2.0.1 inbound registry and outbound handler,
    // so the change is deliberately visible there too.
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP21-FW", "OCPP-2.1");
    try {
      csms.send([
        2,
        "uf-21",
        "UpdateFirmware",
        {
          requestId: 5,
          firmware: {
            location: "https://files.example/fw.bin",
            retrieveDateTime: "2026-09-17T00:00:00.000Z",
          },
        },
      ]);
      expect((await csms.waitForFrame(resultFor("uf-21")))[2]).toEqual({
        status: "Accepted",
      });
      cp.sendFirmwareStatusNotification("Downloaded");
      const report = await csms.waitForFrame(
        call("FirmwareStatusNotification"),
      );
      expect(report[3]).toEqual({ status: "Downloaded", requestId: 5 });
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});

/**
 * #716 L01.FR.21 / L01.FR.22 / L01.FR.02: the signingCertificate of an
 * UpdateFirmware is validated before the request is accepted.
 */
describe.each(["OCPP-2.0.1", "OCPP-2.1"] as const)(
  "%s UpdateFirmware signing certificate (#716)",
  (version) => {
    const DAY = 86_400_000;
    const updateFirmware = (id: string, signingCertificate?: string) =>
      [
        2,
        id,
        "UpdateFirmware",
        {
          requestId: 51,
          firmware: {
            location: "https://files.example/fw.bin",
            retrieveDateTime: "2026-09-17T00:00:00.000Z",
            ...(signingCertificate !== undefined ? { signingCertificate } : {}),
          },
        },
      ] as OcppFrame;

    async function refused(signingCertificate: string, id: string) {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(csms, id, version);
      try {
        csms.send(updateFirmware("uf-bad", signingCertificate));
        const ack = await csms.waitForFrame(resultFor("uf-bad"));
        expect(ack[2]).toEqual({ status: "InvalidCertificate" });
        const event = await csms.waitForCall("SecurityEventNotification");
        expect(event.payload).toMatchObject({
          type: "InvalidFirmwareSigningCertificate",
        });
        // No requestId remembered: a status report has none to stamp.
        expect(cp.lastFirmwareRequestId).toBeUndefined();
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    }

    it("answers InvalidCertificate for an unparsable certificate", async () => {
      await refused("garbage", `CP-${version}-FW-GARBAGE`);
    });

    it("answers InvalidCertificate for an expired certificate", async () => {
      const pem = await signingLeaf({
        notBefore: new Date(Date.now() - 3 * DAY),
        notAfter: new Date(Date.now() - DAY),
      });
      await refused(pem, `CP-${version}-FW-EXPIRED`);
    });

    it("accepts a valid certificate and remembers its requestId", async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(csms, `CP-${version}-FW-OK`, version);
      try {
        csms.send(updateFirmware("uf-ok", await signingLeaf()));
        const ack = await csms.waitForFrame(resultFor("uf-ok"));
        expect(ack[2]).toEqual({ status: "Accepted" });
        expect(cp.lastFirmwareRequestId).toBe(51);
        expect(
          csms.received.some(
            (f) => f[0] === 2 && f[2] === "SecurityEventNotification",
          ),
        ).toBe(false);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("leaves a request without a signingCertificate Accepted", async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(
        csms,
        `CP-${version}-FW-NONE`,
        version,
      );
      try {
        csms.send(updateFirmware("uf-none"));
        const ack = await csms.waitForFrame(resultFor("uf-none"));
        expect(ack[2]).toEqual({ status: "Accepted" });
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("answers InvalidCertificate when a ManufacturerRootCertificate is installed and did not sign it", async () => {
      const root = await selfSignedRoot("01", "Manufacturer Root");
      const csms = startMockCsms();
      const cp = await bootedChargePoint(
        csms,
        `CP-${version}-FW-ROOT`,
        version,
      );
      try {
        await cp.certificateStore.installRootCertificate(
          "ManufacturerRootCertificate",
          root.pem,
          { maxEntries: 10 },
        );
        csms.send(updateFirmware("uf-self", await signingLeaf()));
        const bad = await csms.waitForFrame(resultFor("uf-self"));
        expect(bad[2]).toEqual({ status: "InvalidCertificate" });
        csms.send(
          updateFirmware("uf-issued", await signingLeaf({ issuer: root })),
        );
        const ok = await csms.waitForFrame(resultFor("uf-issued"));
        expect(ok[2]).toEqual({ status: "Accepted" });
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  },
);
