import { describe, expect, it } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

function callResultFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
}

function receivedMessageIds(csms: MockCsms): Set<unknown> {
  return new Set(csms.received.map((frame) => frame[1]));
}

async function waitForNewCall(
  csms: MockCsms,
  action: string,
  seenMessageIds: Set<unknown>,
): Promise<OcppFrame> {
  const frame = await csms.waitForFrame(
    (candidate) =>
      candidate[0] === 2 &&
      candidate[2] === action &&
      !seenMessageIds.has(candidate[1]),
  );
  seenMessageIds.add(frame[1]);
  return frame;
}

async function expectNoNewCallAfter(
  csms: MockCsms,
  startIndex: number,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(
    csms.received.slice(startIndex).filter((frame) => frame[0] === 2),
  ).toEqual([]);
}

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });

  await csms.waitForFrame(
    (frame) =>
      frame[0] === 2 &&
      frame[2] === "StatusNotification" &&
      (frame[3] as { evseId?: number; connectorId?: number }).evseId === 1 &&
      (frame[3] as { evseId?: number; connectorId?: number }).connectorId ===
        1 &&
      (frame[3] as { connectorStatus?: string }).connectorStatus ===
        "Available",
  );
}

describe("OCPP 2.0.1 TriggerMessage", () => {
  it("answers first, then emits supported requested messages", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-TRIGGER",
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

      const statusSeen = receivedMessageIds(csms);
      csms.send([
        2,
        "tm-status",
        "TriggerMessage",
        { requestedMessage: "StatusNotification" },
      ]);

      const statusResult = await csms.waitForFrame(
        callResultFrame("tm-status"),
      );
      expect(statusResult).toEqual([3, "tm-status", { status: "Accepted" }]);

      const statusCall = await waitForNewCall(
        csms,
        "StatusNotification",
        statusSeen,
      );
      expect(csms.received.indexOf(statusCall)).toBeGreaterThan(
        csms.received.indexOf(statusResult),
      );
      await waitForNewCall(csms, "StatusNotification", statusSeen);

      const heartbeatSeen = receivedMessageIds(csms);
      csms.send([
        2,
        "tm-heartbeat",
        "TriggerMessage",
        { requestedMessage: "Heartbeat" },
      ]);

      const heartbeatResult = await csms.waitForFrame(
        callResultFrame("tm-heartbeat"),
      );
      expect(heartbeatResult).toEqual([
        3,
        "tm-heartbeat",
        { status: "Accepted" },
      ]);

      const heartbeatCall = await waitForNewCall(
        csms,
        "Heartbeat",
        heartbeatSeen,
      );
      expect(csms.received.indexOf(heartbeatCall)).toBeGreaterThan(
        csms.received.indexOf(heartbeatResult),
      );

      const unsupportedStartIndex = csms.received.length;
      csms.send([
        2,
        "tm-firmware-status",
        "TriggerMessage",
        { requestedMessage: "FirmwareStatusNotification" },
      ]);

      expect(
        await csms.waitForFrame(callResultFrame("tm-firmware-status")),
      ).toEqual([3, "tm-firmware-status", { status: "NotImplemented" }]);
      await expectNoNewCallAfter(csms, unsupportedStartIndex);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
