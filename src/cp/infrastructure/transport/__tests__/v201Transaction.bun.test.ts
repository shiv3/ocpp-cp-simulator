import { describe, it, expect } from "bun:test";
import type {
  MeterValuesRequestV201,
  TransactionEventRequestV201,
} from "../../../../ocpp";
import {
  startMockCsms,
  normalizeTranscript,
  type MockCsms,
  type OcppFrame,
} from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import type { Transaction } from "../../../domain/connector/Transaction";

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

function meterValuesPayload(frame: OcppFrame): MeterValuesRequestV201 {
  return frame[3] as MeterValuesRequestV201;
}

function receivedMessageIds(csms: MockCsms): Set<unknown> {
  return new Set(csms.received.map((frame) => frame[1]));
}

function newTransactionEventFrame(
  eventType: TransactionEventRequestV201["eventType"],
  seenMessageIds: Set<unknown>,
): (frame: OcppFrame) => boolean {
  return (frame) =>
    transactionEventFrame(eventType)(frame) && !seenMessageIds.has(frame[1]);
}

describe("OCPP 2.0.1 transaction events", () => {
  it("sends TransactionEvent and MeterValues with stable transaction id and numeric values", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-TX",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-2.0.1",
    );
    cp.events.on("error", () => undefined);

    try {
      cp.connect();

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
          (frame[3] as { evseId?: number; connectorId?: number }).evseId ===
            1 &&
          (frame[3] as { evseId?: number; connectorId?: number })
            .connectorId === 1,
      );

      cp.startTransaction("TAG-201", 1);
      const startedFrame = await csms.waitForFrame(
        transactionEventFrame("Started"),
      );
      const started = transactionEventPayload(startedFrame);
      const transaction = cp.getConnector(1)?.transaction;
      if (!transaction?.cpTransactionId) {
        throw new Error("Expected v201 transaction to have cpTransactionId");
      }
      expect(started.transactionInfo.transactionId).toBe(
        transaction.cpTransactionId,
      );

      cp.sendMeterValue(1);
      const meterValuesFrame = await csms.waitForFrame(
        (frame) => frame[0] === 2 && frame[2] === "MeterValues",
      );

      cp.stopTransaction(1);
      const endedFrame = await csms.waitForFrame(
        transactionEventFrame("Ended"),
      );

      const relevantFrames = csms.received.filter(
        (frame) =>
          frame[0] === 2 &&
          (frame[2] === "TransactionEvent" || frame[2] === "MeterValues"),
      );
      expect(
        relevantFrames.map((frame) =>
          frame[2] === "TransactionEvent"
            ? `TransactionEvent:${(frame[3] as { eventType: string }).eventType}`
            : "MeterValues",
        ),
      ).toEqual([
        "TransactionEvent:Started",
        "MeterValues",
        "TransactionEvent:Ended",
      ]);

      const meterValues = meterValuesPayload(meterValuesFrame);
      const ended = transactionEventPayload(endedFrame);
      expect(started.transactionInfo.transactionId).toBe(
        ended.transactionInfo.transactionId,
      );

      const seqNos = [started.seqNo, ended.seqNo];
      expect(seqNos.every((seqNo) => Number.isInteger(seqNo))).toBe(true);
      expect(seqNos[1]).toBeGreaterThan(seqNos[0]);

      const sampledValues = [
        ...(started.meterValue?.[0].sampledValue ?? []),
        ...meterValues.meterValue[0].sampledValue,
        ...(ended.meterValue?.[0].sampledValue ?? []),
      ];
      expect(sampledValues.length).toBeGreaterThan(0);
      for (const sampledValue of sampledValues) {
        expect(typeof sampledValue.value).toBe("number");
      }

      expect(normalizeTranscript(relevantFrames)).toMatchSnapshot();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("resets TransactionEvent seqNo for each new transaction", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-TX-SEQ",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-2.0.1",
    );
    cp.events.on("error", () => undefined);

    try {
      cp.connect();

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
          (frame[3] as { evseId?: number; connectorId?: number }).evseId ===
            1 &&
          (frame[3] as { evseId?: number; connectorId?: number })
            .connectorId === 1,
      );

      const beforeTx1Start = receivedMessageIds(csms);
      cp.startTransaction("TAG-201-A", 1);
      const tx1StartedFrame = await csms.waitForFrame(
        newTransactionEventFrame("Started", beforeTx1Start),
      );
      const tx1Started = transactionEventPayload(tx1StartedFrame);

      const beforeTx1End = receivedMessageIds(csms);
      cp.stopTransaction(1);
      const tx1EndedFrame = await csms.waitForFrame(
        newTransactionEventFrame("Ended", beforeTx1End),
      );
      const tx1Ended = transactionEventPayload(tx1EndedFrame);

      const beforeTx2Start = receivedMessageIds(csms);
      cp.startTransaction("TAG-201-B", 1);
      const tx2StartedFrame = await csms.waitForFrame(
        newTransactionEventFrame("Started", beforeTx2Start),
      );
      const tx2Started = transactionEventPayload(tx2StartedFrame);

      expect(tx1Started.seqNo).toBe(0);
      expect(tx1Ended.seqNo).toBe(1);
      expect(tx2Started.seqNo).toBe(0);
      expect(tx1Ended.transactionInfo.transactionId).toBe(
        tx1Started.transactionInfo.transactionId,
      );
      expect(tx2Started.transactionInfo.transactionId).not.toBe(
        tx1Started.transactionInfo.transactionId,
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("keeps persisted transaction id when stopping after handler restart", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-TX-RESTORE",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-2.0.1",
    );
    cp.events.on("error", () => undefined);

    const knownCpTransactionId = "cp-tx-known";
    const restoredTransaction: Transaction = {
      id: 0,
      connectorId: 1,
      tagId: "TAG-201",
      meterStart: 1000,
      meterStop: null,
      startTime: new Date("2026-06-24T00:01:00.000Z"),
      stopTime: null,
      meterSent: false,
      cpTransactionId: knownCpTransactionId,
      cpNextSeqNo: 1,
    };
    const restoredConnector = cp.getConnector(1);
    expect(restoredConnector).toBeDefined();
    restoredConnector?.restoreRuntimeSnapshot({
      status: OCPPStatus.Charging,
      availability: "Operative",
      scheduledAvailability: null,
      transaction: restoredTransaction,
      meterValueWh: 4321,
      socPercent: null,
      lastAutoStartedScenarioKey: null,
    });
    expect(restoredConnector?.transaction?.cpTransactionId).toBe(
      knownCpTransactionId,
    );
    expect(restoredConnector?.transaction?.cpNextSeqNo).toBe(1);

    try {
      cp.connect();

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
          (frame[3] as { evseId?: number; connectorStatus?: string }).evseId ===
            1 &&
          (frame[3] as { evseId?: number; connectorStatus?: string })
            .connectorStatus === "Occupied",
      );

      expect(restoredConnector?.transaction?.cpTransactionId).toBe(
        knownCpTransactionId,
      );
      cp.stopTransaction(1);
      const endedFrame = await csms.waitForFrame(
        transactionEventFrame("Ended"),
      );
      const ended = transactionEventPayload(endedFrame);
      expect(ended.transactionInfo.transactionId).toBe(knownCpTransactionId);
      expect(ended.seqNo).toBe(1);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
