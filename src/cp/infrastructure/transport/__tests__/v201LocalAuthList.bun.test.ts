import { describe, expect, it } from "bun:test";
import type { SendLocalListRequestV201 } from "../../../../ocpp";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";

function callResultFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
}

function statusNotificationFrame(
  evseId: number,
  connectorId: number,
): (frame: OcppFrame) => boolean {
  return (frame) =>
    frame[0] === 2 &&
    frame[2] === "StatusNotification" &&
    (frame[3] as { evseId?: number }).evseId === evseId &&
    (frame[3] as { connectorId?: number }).connectorId === connectorId &&
    (frame[3] as { connectorStatus?: string }).connectorStatus === "Available";
}

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });

  await csms.waitForFrame(statusNotificationFrame(1, 1));
}

function sendGetLocalListVersion(
  csms: MockCsms,
  messageId: string,
): Promise<OcppFrame> {
  csms.send([2, messageId, "GetLocalListVersion", {}]);
  return csms.waitForFrame(callResultFrame(messageId));
}

function sendLocalList(
  csms: MockCsms,
  messageId: string,
  payload: SendLocalListRequestV201,
): Promise<OcppFrame> {
  csms.send([2, messageId, "SendLocalList", payload]);
  return csms.waitForFrame(callResultFrame(messageId));
}

describe("OCPP 2.0.1 local authorization list", () => {
  it("reports and updates the local list version through CSMS calls", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-LOCAL-AUTH-LIST",
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

    try {
      cp.connect();
      await bootAccepted(csms);

      await expect(
        sendGetLocalListVersion(csms, "local-list-version-1"),
      ).resolves.toEqual([
        3,
        "local-list-version-1",
        {
          versionNumber: 0,
        },
      ]);

      await expect(
        sendLocalList(csms, "send-local-list-full-1", {
          versionNumber: 5,
          updateType: "Full",
          localAuthorizationList: [
            {
              idToken: {
                idToken: "TAG1",
                type: "ISO14443",
              },
              idTokenInfo: {
                status: "Accepted",
              },
            },
          ],
        }),
      ).resolves.toEqual([
        3,
        "send-local-list-full-1",
        {
          status: "Accepted",
        },
      ]);

      await expect(
        sendGetLocalListVersion(csms, "local-list-version-2"),
      ).resolves.toEqual([
        3,
        "local-list-version-2",
        {
          versionNumber: 5,
        },
      ]);

      await expect(
        sendLocalList(csms, "send-local-list-diff-stale", {
          versionNumber: 3,
          updateType: "Differential",
          localAuthorizationList: [
            {
              idToken: {
                idToken: "TAG2",
                type: "ISO14443",
              },
              idTokenInfo: {
                status: "Accepted",
              },
            },
          ],
        }),
      ).resolves.toEqual([
        3,
        "send-local-list-diff-stale",
        {
          status: "VersionMismatch",
        },
      ]);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
