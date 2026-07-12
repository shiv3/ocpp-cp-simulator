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
  it("sends StartTransaction, MeterValues, and StopTransaction with CSMS transaction id, with Preparing preceding StartTransaction on the wire (#176)", async () => {
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
    // This test pins the #176 Preparing-before-StartTransaction wire
    // order, not the #181 local-authorize gate — disable it so
    // startTransaction() below doesn't wait on an Authorize.conf this
    // mock CSMS never answers. The #181 Authorize-first wire is covered
    // by the TC_023 scenario specs (issue #181 Task 4).
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");

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

      // The outbound CALL queue is strictly serial/FIFO (§4.1.1), and
      // startTransaction() now drives Preparing before enqueueing
      // StartTransaction.req (#176) — so the wire sees Preparing's
      // StatusNotification.req first, and StartTransaction.req is only
      // sent once that's acked.
      await replyStatusNotification(csms, 1, "Preparing");

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

      // #176: explicit wire-order pin. Preparing's StatusNotification.req
      // must be enqueued (and therefore sent, given the serial CALL queue)
      // strictly before StartTransaction.req — not just "eventually acked
      // before" as an artifact of a scenario node, but intrinsic to
      // ChargePoint.startTransaction() itself for a plain, non-scenario
      // start.
      const preparingIndex = csms.received.findIndex(
        (frame) =>
          frame[0] === 2 &&
          frame[2] === "StatusNotification" &&
          (frame[3] as { connectorId?: number; status?: string })
            .connectorId === 1 &&
          (frame[3] as { connectorId?: number; status?: string }).status ===
            "Preparing",
      );
      const startTransactionIndex = csms.received.findIndex(
        (frame) => frame[0] === 2 && frame[2] === "StartTransaction",
      );
      expect(preparingIndex).toBeGreaterThanOrEqual(0);
      expect(startTransactionIndex).toBeGreaterThanOrEqual(0);
      expect(preparingIndex).toBeLessThan(startTransactionIndex);

      expect(normalizeTranscript(relevantFrames)).toMatchSnapshot();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
