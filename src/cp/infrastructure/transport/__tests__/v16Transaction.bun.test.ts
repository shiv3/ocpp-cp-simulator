import { describe, it, expect } from "bun:test";
import type {
  MeterValuesRequestV16,
  StartTransactionRequestV16,
  StopTransactionRequestV16,
} from "../../../../ocpp";
import { startMockCsms, normalizeTranscript, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

function transactionFrames(frames: OcppFrame[]): OcppFrame[] {
  return frames.filter(
    (frame) =>
      frame[0] === 2 &&
      (frame[2] === "StartTransaction" ||
        frame[2] === "MeterValues" ||
        frame[2] === "StopTransaction"),
  );
}

function payload<T>(frame: OcppFrame): T {
  return frame[3] as T;
}

async function replyStatusNotification(
  csms: ReturnType<typeof startMockCsms>,
  connectorId: number,
  status: string,
): Promise<void> {
  const frame = await csms.waitForFrame(
    (candidate) =>
      candidate[0] === 2 &&
      candidate[2] === "StatusNotification" &&
      (candidate[3] as { connectorId?: number; status?: string })
        .connectorId === connectorId &&
      (candidate[3] as { connectorId?: number; status?: string }).status ===
        status,
  );
  csms.replyCallResult(frame[1] as string, {});
}

describe("OCPP 1.6 transaction lifecycle (golden)", () => {
  it("sends StartTransaction, MeterValues, and StopTransaction with CSMS transaction id", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP016-TX",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-1.6J",
      {},
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

      await replyStatusNotification(csms, 0, "Available");
      await replyStatusNotification(csms, 1, "Available");

      cp.startTransaction("TAG-16", 1);
      const startCall = await csms.waitForCall("StartTransaction");
      const startPayload = startCall.payload as StartTransactionRequestV16;
      expect(startPayload).toMatchObject({
        connectorId: 1,
        idTag: "TAG-16",
        meterStart: 0,
      });
      expect(typeof startPayload.timestamp).toBe("string");
      csms.replyCallResult(startCall.messageId, {
        transactionId: 1001,
        idTagInfo: { status: "Accepted" },
      });

      await replyStatusNotification(csms, 1, "Preparing");
      await replyStatusNotification(csms, 1, "Charging");

      cp.sendMeterValue(1);
      const meterValuesCall = await csms.waitForCall("MeterValues");
      const meterValuesPayload =
        meterValuesCall.payload as MeterValuesRequestV16;
      expect(meterValuesPayload.transactionId).toBe(1001);
      csms.replyCallResult(meterValuesCall.messageId, {});

      cp.stopTransaction(1);
      const stopCall = await csms.waitForCall("StopTransaction");
      const stopPayload = stopCall.payload as StopTransactionRequestV16;
      expect(stopPayload.transactionId).toBe(1001);
      csms.replyCallResult(stopCall.messageId, {
        idTagInfo: { status: "Accepted" },
      });

      const relevantFrames = transactionFrames(csms.received);
      expect(relevantFrames.map((frame) => frame[2])).toEqual([
        "StartTransaction",
        "MeterValues",
        "StopTransaction",
      ]);
      expect(
        payload<MeterValuesRequestV16>(relevantFrames[1]).transactionId,
      ).toBe(1001);
      expect(
        payload<StopTransactionRequestV16>(relevantFrames[2]).transactionId,
      ).toBe(1001);

      expect(normalizeTranscript(relevantFrames)).toMatchSnapshot();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
