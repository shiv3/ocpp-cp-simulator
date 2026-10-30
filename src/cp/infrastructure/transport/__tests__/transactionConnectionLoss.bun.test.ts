import { describe, expect, it } from "bun:test";
import type {
  StopTransactionRequestV16,
  TransactionEventRequestV201,
} from "../../../../ocpp";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
} from "./stationHarness";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { OCPPStatus } from "../../../domain/types/OcppTypes";

/**
 * #488 — a WebSocket close does not end a running transaction, on 1.6
 * (§3.7: the station queues its transaction-related messages while offline)
 * or on 2.x (E11: the transaction continues). No configuration key ends a
 * transaction on connection loss, and the simulator offers none.
 *
 * 2.x has no offline queue yet: a TransactionEvent produced while offline is
 * dropped, not replayed with `offline: true` (E11.FR.01/FR.02). These tests
 * pin what exists — the transaction survives and its later events carry the
 * same transaction id — not the replay.
 */

const RECONNECT_TIMEOUT_MS = 10_000;

function closedOnce(cp: ChargePoint): Promise<unknown> {
  return new Promise((resolve) => cp.events.once("disconnected", resolve));
}

/** Answer the BootNotification of the next connection. */
async function acceptNextBoot(csms: MockCsms): Promise<void> {
  const bootsBefore = csms.received.filter(callOf("BootNotification")).length;
  const boot = await csms.waitForFrame(
    (frame) =>
      callOf("BootNotification")(frame) &&
      csms.received.filter(callOf("BootNotification")).indexOf(frame) >=
        bootsBefore,
    RECONNECT_TIMEOUT_MS,
  );
  csms.replyCallResult(boot[1] as string, {
    status: "Accepted",
    currentTime: "2026-10-29T00:05:00.000Z",
    interval: 300,
  });
}

const indexAfter = (csms: MockCsms, after: number) => (frame: OcppFrame) =>
  csms.received.indexOf(frame) > after;

describe("Transaction across a WebSocket close (#488)", () => {
  it("1.6: the transaction keeps running and a StopTransaction produced offline is replayed after reconnect", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-TX-CLOSE", "OCPP-1.6J");
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    const stopAnswering = answerEverythingElse(csms, ["StartTransaction"]);
    try {
      cp.startTransaction("TAG-CLOSE", 1);
      const start = await csms.waitForCall("StartTransaction");
      csms.replyCallResult(start.messageId, {
        transactionId: 9488,
        idTagInfo: { status: "Accepted" },
      });
      await csms.waitForFrame(
        (frame) =>
          callOf("StatusNotification")(frame) &&
          (frame[3] as { status?: string }).status === "Charging",
      );

      const closed = closedOnce(cp);
      csms.closeCurrentConnection(1011);
      await closed;

      const connector = cp.getConnector(1);
      expect(connector?.hasRunningTransaction).toBe(true);
      expect(connector?.transaction?.id).toBe(9488);

      // Produced while offline: queued, not lost.
      const beforeStop = csms.received.length - 1;
      cp.stopTransaction(1);

      await acceptNextBoot(csms);
      const replayed = await csms.waitForFrame(
        (frame) =>
          callOf("StopTransaction")(frame) &&
          indexAfter(csms, beforeStop)(frame),
        RECONNECT_TIMEOUT_MS,
      );
      expect((replayed[3] as StopTransactionRequestV16).transactionId).toBe(
        9488,
      );
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  }, 20_000);

  it("2.0.1: the transaction keeps running and its Ended event after reconnect carries the same transaction id", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-TX-CLOSE", "OCPP-2.0.1");
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    const stopAnswering = answerEverythingElse(csms, []);
    try {
      await cp.startTransaction("TAG-CLOSE", 1);
      const started = (
        await csms.waitForFrame(
          (frame) =>
            callOf("TransactionEvent")(frame) &&
            (frame[3] as TransactionEventRequestV201).eventType === "Started",
        )
      )[3] as TransactionEventRequestV201;
      cp.updateConnectorStatus(1, OCPPStatus.Charging);

      const closed = closedOnce(cp);
      csms.closeCurrentConnection(1011);
      await closed;

      expect(cp.getConnector(1)?.hasRunningTransaction).toBe(true);

      const beforeReconnect = csms.received.length - 1;
      await acceptNextBoot(csms);
      await csms.waitForFrame(
        (frame) =>
          callOf("StatusNotification")(frame) &&
          indexAfter(csms, beforeReconnect)(frame),
        RECONNECT_TIMEOUT_MS,
      );
      expect(cp.getConnector(1)?.hasRunningTransaction).toBe(true);

      cp.stopTransaction(1);
      const ended = (
        await csms.waitForFrame(
          (frame) =>
            callOf("TransactionEvent")(frame) &&
            (frame[3] as TransactionEventRequestV201).eventType === "Ended",
          RECONNECT_TIMEOUT_MS,
        )
      )[3] as TransactionEventRequestV201;
      expect(ended.transactionInfo.transactionId).toBe(
        started.transactionInfo.transactionId,
      );
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  }, 20_000);
});
