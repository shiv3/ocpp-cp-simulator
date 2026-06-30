import { describe, it, expect } from "bun:test";
import type { NotifyReportRequestV201 } from "../../../../ocpp";
import type { ReportDataType } from "../../../../ocpp/types/v201/notify-report";
import { startMockCsms, normalizeTranscript } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

function reportDatum(
  reportData: ReportDataType[],
  componentName: string,
  variableName: string,
): ReportDataType {
  const found = reportData.find(
    (item) =>
      item.component.name === componentName &&
      item.variable.name === variableName,
  );
  if (!found) {
    throw new Error(
      `Expected report data for ${componentName}/${variableName}`,
    );
  }
  return found;
}

describe("OCPP 2.0.1 GetBaseReport", () => {
  it("answers Accepted and sends one NotifyReport with mapped configuration variables", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-BASE-REPORT",
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
          (frame[3] as { evseId?: number }).evseId === 0,
      );
      await csms.waitForFrame(
        (frame) =>
          frame[0] === 2 &&
          frame[2] === "StatusNotification" &&
          (frame[3] as { evseId?: number }).evseId === 1,
      );

      csms.send([
        2,
        "gbr-1",
        "GetBaseReport",
        { requestId: 42, reportBase: "ConfigurationInventory" },
      ]);

      const callResultFrame = await csms.waitForFrame(
        (frame) => frame[0] === 3 && frame[1] === "gbr-1",
      );
      expect(callResultFrame).toEqual([3, "gbr-1", { status: "Accepted" }]);

      const notifyReportFrame = await csms.waitForFrame(
        (frame) => frame[0] === 2 && frame[2] === "NotifyReport",
      );
      const notifyReport = notifyReportFrame[3] as NotifyReportRequestV201;
      expect(notifyReport.requestId).toBe(42);
      expect(notifyReport.seqNo).toBe(0);
      expect(notifyReport.tbc).toBe(false);

      const reportData = notifyReport.reportData ?? [];
      const heartbeat = reportDatum(
        reportData,
        "OCPPCommCtrlr",
        "HeartbeatInterval",
      );
      expect(heartbeat.variableAttribute[0]).toMatchObject({
        value: "300",
        mutability: "ReadWrite",
      });

      const authorizeRemoteStart = reportDatum(
        reportData,
        "AuthCtrlr",
        "AuthorizeRemoteStart",
      );
      expect(authorizeRemoteStart.variableAttribute[0]).toMatchObject({
        mutability: "ReadOnly",
      });

      expect(csms.received.indexOf(notifyReportFrame)).toBeGreaterThan(
        csms.received.indexOf(callResultFrame),
      );
      expect(normalizeTranscript([notifyReportFrame])).toMatchSnapshot();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
