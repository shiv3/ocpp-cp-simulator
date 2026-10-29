import { describe, expect, it } from "bun:test";
import type { TransactionEventRequestV201 } from "../../../../ocpp";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { bootedChargePoint } from "./stationHarness";

/**
 * #447: the CSMS's verdict on the idToken of a 2.x transaction comes back in
 * TransactionEvent.conf `idTokenInfo`. A status other than Accepted is the
 * 2.x twin of 1.6's non-Accepted StartTransaction.conf (#181): with
 * `TxCtrlr/StopTxOnInvalidId` (default true) the station ends the transaction
 * as Deauthorized / DeAuthorized; with it false the transaction keeps
 * running. Either way `startTransactionNotAccepted` reports it.
 */

const eventOf =
  (eventType: TransactionEventRequestV201["eventType"]) =>
  (frame: OcppFrame): boolean =>
    frame[0] === 2 &&
    frame[2] === "TransactionEvent" &&
    (frame[3] as TransactionEventRequestV201).eventType === eventType;

async function startedTransaction(
  csms: MockCsms,
  id: string,
  stopOnInvalid: boolean,
) {
  const cp = await bootedChargePoint(csms, id, "OCPP-2.0.1");
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  cp.configuration.applyChange(
    "StopTransactionOnInvalidId",
    stopOnInvalid ? "true" : "false",
  );
  const rejections: Array<ChargePointEvents["startTransactionNotAccepted"]> =
    [];
  cp.events.on("startTransactionNotAccepted", (e) => rejections.push(e));
  void cp.startTransaction("TAG-201", 1);
  const started = await csms.waitForFrame(eventOf("Started"));
  return { cp, started, rejections };
}

describe("OCPP 2.0.1 TransactionEvent.conf idTokenInfo (#447)", () => {
  it("ends the transaction as Deauthorized when the id is not accepted", async () => {
    const csms = startMockCsms();
    const { cp, started, rejections } = await startedTransaction(
      csms,
      "CP201-INVALID",
      true,
    );
    try {
      csms.replyCallResult(started[1] as string, {
        idTokenInfo: { status: "Invalid" },
      });

      const ended = await csms.waitForFrame(eventOf("Ended"));
      const payload = ended[3] as TransactionEventRequestV201;
      expect(payload.triggerReason).toBe("Deauthorized");
      expect(payload.transactionInfo.stoppedReason).toBe("DeAuthorized");
      expect(payload.transactionInfo.transactionId).toBe(
        (started[3] as TransactionEventRequestV201).transactionInfo
          .transactionId,
      );
      expect(rejections).toEqual([
        { connectorId: 1, status: "Invalid", stopped: true },
      ]);
      expect(cp.getConnector(1)?.transaction).toBeNull();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("keeps the transaction running when StopTxOnInvalidId is false", async () => {
    const csms = startMockCsms();
    const { cp, started, rejections } = await startedTransaction(
      csms,
      "CP201-KEEP",
      false,
    );
    try {
      csms.replyCallResult(started[1] as string, {
        idTokenInfo: { status: "Blocked" },
      });

      const deadline = Date.now() + 2_000;
      while (rejections.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(rejections).toEqual([
        { connectorId: 1, status: "Blocked", stopped: false },
      ]);
      expect(csms.received.some(eventOf("Ended"))).toBe(false);
      expect(cp.getConnector(1)?.transaction?.stopTime).toBeNull();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("does nothing on an Accepted idTokenInfo", async () => {
    const csms = startMockCsms();
    const { cp, started, rejections } = await startedTransaction(
      csms,
      "CP201-OK",
      true,
    );
    try {
      csms.replyCallResult(started[1] as string, {
        idTokenInfo: { status: "Accepted" },
      });
      // A sentinel round trip: once the Heartbeat answer is processed, the
      // TransactionEvent answer sent before it has been too.
      cp.sendHeartbeat();
      const heartbeat = await csms.waitForCall("Heartbeat");
      csms.replyCallResult(heartbeat.messageId, {
        currentTime: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(rejections).toEqual([]);
      expect(csms.received.some(eventOf("Ended"))).toBe(false);
      expect(cp.getConnector(1)?.transaction?.stopTime).toBeNull();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
