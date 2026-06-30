import { describe, expect, it } from "bun:test";
import type { TransactionEventRequestV201 } from "../../../../ocpp";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

function callResultFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
}

function transactionEventFrame(
  eventType: TransactionEventRequestV201["eventType"],
): (frame: OcppFrame) => boolean {
  return (frame) =>
    frame[0] === 2 &&
    frame[2] === "TransactionEvent" &&
    (frame[3] as { eventType?: string }).eventType === eventType;
}

function transactionEventPayload(
  frame: OcppFrame,
): TransactionEventRequestV201 {
  return frame[3] as TransactionEventRequestV201;
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

describe("OCPP 2.0.1 transaction control", () => {
  it("accepts remote start/stop, stops as Remote, and reports no ongoing transaction after stop", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-TX-CONTROL",
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

      csms.send([
        2,
        "rs-201-1",
        "RequestStartTransaction",
        {
          remoteStartId: 7,
          idToken: { idToken: "TAG-RS", type: "ISO14443" },
          evseId: 1,
        },
      ]);

      const startResult = await csms.waitForFrame(callResultFrame("rs-201-1"));
      expect(startResult).toEqual([3, "rs-201-1", { status: "Accepted" }]);

      const startedFrame = await csms.waitForFrame(
        transactionEventFrame("Started"),
      );
      expect(csms.received.indexOf(startedFrame)).toBeGreaterThan(
        csms.received.indexOf(startResult),
      );
      const started = transactionEventPayload(startedFrame);
      const transactionId = started.transactionInfo.transactionId;
      expect(typeof transactionId).toBe("string");
      expect(transactionId.length).toBeGreaterThan(0);
      expect(started.triggerReason).toBe("RemoteStart");
      expect(started.transactionInfo.remoteStartId).toBe(7);

      csms.send([2, "rs-201-2", "RequestStopTransaction", { transactionId }]);

      const stopResult = await csms.waitForFrame(callResultFrame("rs-201-2"));
      expect(stopResult).toEqual([3, "rs-201-2", { status: "Accepted" }]);

      const endedFrame = await csms.waitForFrame(
        transactionEventFrame("Ended"),
      );
      expect(csms.received.indexOf(endedFrame)).toBeGreaterThan(
        csms.received.indexOf(stopResult),
      );
      const ended = transactionEventPayload(endedFrame);
      expect(ended.transactionInfo.transactionId).toBe(transactionId);
      expect(ended.transactionInfo.stoppedReason).toBe("Remote");
      expect(ended.triggerReason).toBe("RemoteStop");

      csms.send([
        2,
        "rs-201-3",
        "RequestStopTransaction",
        { transactionId: "unknown-transaction" },
      ]);

      const unknownStopResult = await csms.waitForFrame(
        callResultFrame("rs-201-3"),
      );
      expect(unknownStopResult).toEqual([
        3,
        "rs-201-3",
        { status: "Rejected" },
      ]);

      csms.send([2, "rs-201-4", "GetTransactionStatus", {}]);

      const statusResult = await csms.waitForFrame(callResultFrame("rs-201-4"));
      expect(statusResult).toEqual([
        3,
        "rs-201-4",
        { ongoingIndicator: false, messagesInQueue: false },
      ]);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
