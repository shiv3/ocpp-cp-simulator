import { describe, it, expect } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

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
): Promise<ChargePoint> {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    csms.url,
    null,
    null,
    null,
    {},
    [],
    "OCPP-2.0.1",
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
});
