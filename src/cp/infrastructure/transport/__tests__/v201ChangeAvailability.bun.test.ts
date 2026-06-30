import { describe, it, expect } from "bun:test";
import type { ChangeAvailabilityRequestV201 } from "../../../../ocpp";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

function callResultFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
}

function statusNotificationFrame(
  evseId: number,
  connectorStatus: "Available" | "Unavailable",
): (frame: OcppFrame) => boolean {
  return (frame) =>
    frame[0] === 2 &&
    frame[2] === "StatusNotification" &&
    (frame[3] as { evseId?: number }).evseId === evseId &&
    (frame[3] as { connectorStatus?: string }).connectorStatus ===
      connectorStatus;
}

function statusNotificationFrameAfter(
  csms: MockCsms,
  afterIndex: number,
  evseId: number,
  connectorStatus: "Available" | "Unavailable",
): (frame: OcppFrame) => boolean {
  const matches = statusNotificationFrame(evseId, connectorStatus);
  return (frame) => matches(frame) && csms.received.indexOf(frame) > afterIndex;
}

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });

  for (const evseId of [0, 1, 2]) {
    await csms.waitForFrame(statusNotificationFrame(evseId, "Available"));
  }
}

describe("OCPP 2.0.1 ChangeAvailability", () => {
  it("applies CP-wide and single-connector availability after the CALLRESULT", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-CHANGE-AVAILABILITY",
      DefaultBootNotification,
      2,
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

      const cpWideUnavailable = {
        operationalStatus: "Inoperative",
      } satisfies ChangeAvailabilityRequestV201;
      csms.send([
        2,
        "change-availability-all",
        "ChangeAvailability",
        cpWideUnavailable,
      ]);

      const cpWideResult = await csms.waitForFrame(
        callResultFrame("change-availability-all"),
      );
      expect(cpWideResult).toEqual([
        3,
        "change-availability-all",
        { status: "Accepted" },
      ]);

      const unavailable0 = await csms.waitForFrame(
        statusNotificationFrame(0, "Unavailable"),
      );
      const unavailable1 = await csms.waitForFrame(
        statusNotificationFrame(1, "Unavailable"),
      );
      const unavailable2 = await csms.waitForFrame(
        statusNotificationFrame(2, "Unavailable"),
      );

      expect(unavailable0[3]).toMatchObject({
        evseId: 0,
        connectorId: 0,
        connectorStatus: "Unavailable",
      });
      for (const frame of [unavailable1, unavailable2]) {
        expect(frame[3]).toMatchObject({
          connectorId: 1,
          connectorStatus: "Unavailable",
        });
      }

      const cpWideResultIndex = csms.received.indexOf(cpWideResult);
      for (const frame of [unavailable0, unavailable1, unavailable2]) {
        expect(csms.received.indexOf(frame)).toBeGreaterThan(cpWideResultIndex);
      }

      const connectorAvailable = {
        operationalStatus: "Operative",
        evse: { id: 1 },
      } satisfies ChangeAvailabilityRequestV201;
      csms.send([
        2,
        "change-availability-1",
        "ChangeAvailability",
        connectorAvailable,
      ]);

      const connectorResult = await csms.waitForFrame(
        callResultFrame("change-availability-1"),
      );
      expect(connectorResult).toEqual([
        3,
        "change-availability-1",
        { status: "Accepted" },
      ]);

      const available1 = await csms.waitForFrame(
        statusNotificationFrameAfter(
          csms,
          csms.received.indexOf(connectorResult),
          1,
          "Available",
        ),
      );
      expect(available1[3]).toMatchObject({
        evseId: 1,
        connectorId: 1,
        connectorStatus: "Available",
      });
      expect(csms.received.indexOf(available1)).toBeGreaterThan(
        csms.received.indexOf(connectorResult),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
