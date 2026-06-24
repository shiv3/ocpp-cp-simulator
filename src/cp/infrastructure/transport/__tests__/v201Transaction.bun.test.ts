import { describe, it, expect } from "bun:test";
import type {
  MeterValuesRequestV201,
  TransactionEventRequestV201,
} from "@cshil/ocpp-tools";
import { startMockCsms, normalizeTranscript, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

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

      const started = transactionEventPayload(startedFrame);
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
});
