import { describe, expect, it } from "bun:test";
import {
  isValidClearVariableMonitoringResponseV201,
  isValidGetMonitoringReportResponseV201,
  isValidNotifyMonitoringReportRequestV201,
  isValidSetMonitoringLevelResponseV201,
  isValidSetVariableMonitoringResponseV201,
} from "../../../../ocpp/v201";
import {
  isValidClearVariableMonitoringResponseV21,
  isValidGetMonitoringReportResponseV21,
  isValidNotifyMonitoringReportRequestV21,
  isValidSetMonitoringLevelResponseV21,
  isValidSetVariableMonitoringResponseV21,
} from "../../../../ocpp/v21";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

type Validator = (data: unknown) => boolean;

const VERSIONS = [
  {
    version: "OCPP-2.0.1",
    setResponse: isValidSetVariableMonitoringResponseV201,
    clearResponse: isValidClearVariableMonitoringResponseV201,
    levelResponse: isValidSetMonitoringLevelResponseV201,
    reportResponse: isValidGetMonitoringReportResponseV201,
    notifyReport: isValidNotifyMonitoringReportRequestV201,
    eventNotificationType: undefined,
  },
  {
    version: "OCPP-2.1",
    setResponse: isValidSetVariableMonitoringResponseV21,
    clearResponse: isValidClearVariableMonitoringResponseV21,
    levelResponse: isValidSetMonitoringLevelResponseV21,
    reportResponse: isValidGetMonitoringReportResponseV21,
    notifyReport: isValidNotifyMonitoringReportRequestV21,
    eventNotificationType: "CustomMonitor",
  },
] as const;

function callResult(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
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
      (frame[3] as { evseId?: number }).evseId === 1,
  );
}

async function call(
  csms: MockCsms,
  messageId: string,
  action: string,
  payload: unknown,
  validResponse: Validator,
): Promise<Record<string, unknown>> {
  csms.send([2, messageId, action, payload]);
  const frame = await csms.waitForFrame(callResult(messageId));
  const response = frame[2] as Record<string, unknown>;
  expect(validResponse(response)).toBe(true);
  return response;
}

describe("OCPP 2.x variable monitoring", () => {
  for (const v of VERSIONS) {
    it(`${v.version}: sets, reports and clears monitors with schema-valid frames`, async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        `CP-MONITORING-${v.version}`,
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        v.version,
        {},
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();
        await bootAccepted(csms);

        expect(
          await call(
            csms,
            "gmr-empty",
            "GetMonitoringReport",
            { requestId: 1 },
            v.reportResponse,
          ),
        ).toEqual({ status: "EmptyResultSet" });

        const set = await call(
          csms,
          "svm-1",
          "SetVariableMonitoring",
          {
            setMonitoringData: [
              {
                value: 600,
                type: "UpperThreshold",
                severity: 4,
                component: { name: "OCPPCommCtrlr" },
                variable: { name: "HeartbeatInterval" },
              },
              {
                value: 30,
                type: "LowerThreshold",
                severity: 4,
                component: { name: "OCPPCommCtrlr" },
                variable: { name: "HeartbeatInterval" },
              },
              {
                value: 10,
                type: "Delta",
                severity: 7,
                component: { name: "OCPPCommCtrlr" },
                variable: { name: "HeartbeatInterval" },
              },
              {
                value: 700,
                type: "UpperThreshold",
                severity: 4,
                component: { name: "OCPPCommCtrlr" },
                variable: { name: "HeartbeatInterval" },
              },
              {
                value: 1,
                type: "Delta",
                severity: 4,
                component: { name: "NoSuchCtrlr" },
                variable: { name: "HeartbeatInterval" },
              },
              {
                value: 1,
                type: "Delta",
                severity: 4,
                component: { name: "OCPPCommCtrlr" },
                variable: { name: "NoSuchVariable" },
              },
            ],
          },
          v.setResponse,
        );
        expect(
          (set.setMonitoringResult as { id?: number; status: string }[]).map(
            (r) => [r.status, r.id],
          ),
        ).toEqual([
          ["Accepted", 1],
          ["Accepted", 2],
          ["Accepted", 3],
          ["Duplicate", undefined],
          ["UnknownComponent", undefined],
          ["UnknownVariable", undefined],
        ]);

        expect(
          await call(
            csms,
            "sml-1",
            "SetMonitoringLevel",
            { severity: 5 },
            v.levelResponse,
          ),
        ).toEqual({ status: "Accepted" });
        expect(cp.monitoring.monitoringLevel).toBe(5);

        expect(
          await call(
            csms,
            "gmr-1",
            "GetMonitoringReport",
            { requestId: 42, monitoringCriteria: ["ThresholdMonitoring"] },
            v.reportResponse,
          ),
        ).toEqual({ status: "Accepted" });
        const notify = await csms.waitForCall("NotifyMonitoringReport");
        expect(v.notifyReport(notify.payload)).toBe(true);
        expect(notify.payload).toMatchObject({
          requestId: 42,
          seqNo: 0,
          tbc: false,
          monitor: [
            {
              component: { name: "OCPPCommCtrlr" },
              variable: { name: "HeartbeatInterval" },
              variableMonitoring: [
                {
                  id: 1,
                  type: "UpperThreshold",
                  value: 600,
                  severity: 4,
                  transaction: false,
                  ...(v.eventNotificationType && {
                    eventNotificationType: v.eventNotificationType,
                  }),
                },
                {
                  id: 2,
                  type: "LowerThreshold",
                  value: 30,
                  severity: 4,
                  transaction: false,
                },
              ],
            },
          ],
        });
        const callResultIndex = csms.received.findIndex(callResult("gmr-1"));
        expect(
          csms.received.findIndex(
            (f) => f[0] === 2 && f[2] === "NotifyMonitoringReport",
          ),
        ).toBeGreaterThan(callResultIndex);
        csms.replyCallResult(notify.messageId, {});

        expect(
          await call(
            csms,
            "cvm-1",
            "ClearVariableMonitoring",
            { id: [2, 99] },
            v.clearResponse,
          ),
        ).toEqual({
          clearMonitoringResult: [
            { id: 2, status: "Accepted" },
            { id: 99, status: "NotFound" },
          ],
        });
        expect(cp.monitoring.list().map((m) => m.id)).toEqual([1, 3]);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  }
});
