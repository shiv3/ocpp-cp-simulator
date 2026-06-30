import { describe, expect, it } from "bun:test";
import type {
  GetReportRequestV201,
  NotifyReportRequestV201,
} from "../../../../ocpp";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";

function callResultFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
}

function notifyReportFrameAfter(
  csms: MockCsms,
  afterIndex: number,
  requestId: number,
): (frame: OcppFrame) => boolean {
  return (frame) =>
    csms.received.indexOf(frame) > afterIndex &&
    frame[0] === 2 &&
    frame[2] === "NotifyReport" &&
    (frame[3] as { requestId?: number }).requestId === requestId;
}

async function expectNoFrame(
  csms: MockCsms,
  pred: (frame: OcppFrame) => boolean,
): Promise<void> {
  try {
    const frame = await csms.waitForFrame(pred, 150);
    throw new Error(`Unexpected frame: ${JSON.stringify(frame)}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Timed out waiting for frame"
    ) {
      return;
    }
    throw error;
  }
}

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });

  for (const evseId of [0, 1]) {
    await csms.waitForFrame(
      (frame) =>
        frame[0] === 2 &&
        frame[2] === "StatusNotification" &&
        (frame[3] as { evseId?: number }).evseId === evseId,
    );
  }
}

async function sendGetReport(
  csms: MockCsms,
  messageId: string,
  payload: GetReportRequestV201,
): Promise<OcppFrame> {
  csms.send([2, messageId, "GetReport", payload]);
  return csms.waitForFrame(callResultFrame(messageId));
}

function notifyReportPayload(frame: OcppFrame): NotifyReportRequestV201 {
  return frame[3] as NotifyReportRequestV201;
}

describe("OCPP 2.0.1 GetReport", () => {
  it("answers over the device-model and filters by componentVariable", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-GET-REPORT",
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

      const unfilteredResult = await sendGetReport(csms, "gr-11", {
        requestId: 11,
      });
      expect(unfilteredResult).toEqual([3, "gr-11", { status: "Accepted" }]);

      const unfilteredNotify = await csms.waitForFrame(
        notifyReportFrameAfter(
          csms,
          csms.received.indexOf(unfilteredResult),
          11,
        ),
      );
      const unfilteredReport = notifyReportPayload(unfilteredNotify);
      const unfilteredReportData = unfilteredReport.reportData ?? [];
      expect(unfilteredReportData.length).toBeGreaterThan(0);
      expect(unfilteredReport.requestId).toBe(11);

      const firstReportDatum = unfilteredReportData[0];
      if (firstReportDatum === undefined) {
        throw new Error("Expected GetReport NotifyReport reportData");
      }
      const componentName = firstReportDatum.component.name;

      const emptyResult = await sendGetReport(csms, "gr-12", {
        requestId: 12,
        componentVariable: [
          {
            component: { name: "__NoSuchComponent__" },
          },
        ],
      });
      expect(emptyResult).toEqual([3, "gr-12", { status: "EmptyResultSet" }]);
      await expectNoFrame(
        csms,
        notifyReportFrameAfter(csms, csms.received.indexOf(emptyResult), 12),
      );

      const filteredResult = await sendGetReport(csms, "gr-13", {
        requestId: 13,
        componentVariable: [
          {
            component: { name: componentName },
          },
        ],
      });
      expect(filteredResult).toEqual([3, "gr-13", { status: "Accepted" }]);

      const filteredNotify = await csms.waitForFrame(
        notifyReportFrameAfter(csms, csms.received.indexOf(filteredResult), 13),
      );
      const filteredReport = notifyReportPayload(filteredNotify);
      const filteredReportData = filteredReport.reportData ?? [];
      expect(filteredReport.requestId).toBe(13);
      expect(filteredReportData.length).toBeGreaterThan(0);
      expect(
        filteredReportData.every((rd) => rd.component.name === componentName),
      ).toBe(true);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
