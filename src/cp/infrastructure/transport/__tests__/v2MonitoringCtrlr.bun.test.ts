import { describe, expect, it } from "bun:test";
import {
  isValidGetVariablesResponseV201,
  isValidNotifyEventRequestV201,
  isValidNotifyReportRequestV201,
  isValidSetVariablesResponseV201,
} from "../../../../ocpp/v201";
import {
  isValidGetVariablesResponseV21,
  isValidNotifyEventRequestV21,
  isValidNotifyReportRequestV21,
  isValidSetVariablesResponseV21,
} from "../../../../ocpp/v21";
import { answerTo, startMockCsms, type MockCsms } from "./mockCsms";
import { bootedChargePoint, callOf } from "./stationHarness";

/**
 * #538: the MonitoringCtrlr variables of the device model —
 * ItemsPerMessage / BytesPerMessage with their SetVariableMonitoring and
 * ClearVariableMonitoring instances, and ActiveMonitoringLevel read from the
 * monitoring level — and the minLimit / maxLimit GetBaseReport publishes for
 * bounded integer variables (the bounds behind ValueOutOfRange, N04.FR.06).
 */

type Validator = (data: unknown) => boolean;

const VERSIONS = [
  {
    version: "OCPP-2.0.1",
    getVariables: isValidGetVariablesResponseV201,
    setVariables: isValidSetVariablesResponseV201,
    notifyReport: isValidNotifyReportRequestV201,
    notifyEvent: isValidNotifyEventRequestV201,
  },
  {
    version: "OCPP-2.1",
    getVariables: isValidGetVariablesResponseV21,
    setVariables: isValidSetVariablesResponseV21,
    notifyReport: isValidNotifyReportRequestV21,
    notifyEvent: isValidNotifyEventRequestV21,
  },
] as const;

const MONITORING_CTRLR = { name: "MonitoringCtrlr" };

async function call(
  csms: MockCsms,
  messageId: string,
  action: string,
  payload: unknown,
  valid?: Validator,
): Promise<Record<string, unknown>> {
  csms.send([2, messageId, action, payload]);
  const frame = await csms.waitForFrame(answerTo(messageId));
  const response = frame[2] as Record<string, unknown>;
  if (valid) expect(valid(response)).toBe(true);
  return response;
}

interface GetVariableResult {
  attributeStatus: string;
  attributeValue?: string;
}

interface ReportDatum {
  component: { name: string };
  variable: { name: string; instance?: string };
  variableAttribute: { mutability?: string; value?: string }[];
  variableCharacteristics?: {
    dataType: string;
    minLimit?: number;
    maxLimit?: number;
    valuesList?: string;
    supportsMonitoring: boolean;
  };
}

describe("OCPP 2.x MonitoringCtrlr variables (#538)", () => {
  for (const v of VERSIONS) {
    it(`${v.version}: publishes ItemsPerMessage / BytesPerMessage per instance and ActiveMonitoringLevel`, async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(
        csms,
        `CP-MCTRLR-${v.version}`,
        v.version,
      );
      try {
        const read = async (messageId: string) => {
          const response = await call(
            csms,
            messageId,
            "GetVariables",
            {
              getVariableData: [
                ...["SetVariableMonitoring", "ClearVariableMonitoring"].flatMap(
                  (instance) =>
                    ["ItemsPerMessage", "BytesPerMessage"].map((name) => ({
                      component: MONITORING_CTRLR,
                      variable: { name, instance },
                    })),
                ),
                {
                  component: MONITORING_CTRLR,
                  variable: { name: "ItemsPerMessage" },
                },
                {
                  component: MONITORING_CTRLR,
                  variable: { name: "ActiveMonitoringLevel" },
                },
              ],
            },
            v.getVariables,
          );
          return (response.getVariableResult as GetVariableResult[]).map(
            (r) => r.attributeValue ?? r.attributeStatus,
          );
        };

        expect(await read("gv-1")).toEqual([
          "100",
          "65536",
          "100",
          "65536",
          // An instanced variable is only known with its instance.
          "UnknownVariable",
          // The monitoring level starts at 9.
          "9",
        ]);

        await call(csms, "sml-4", "SetMonitoringLevel", { severity: 4 });
        expect((await read("gv-2"))[5]).toBe("4");

        // ReadOnly: SetVariables cannot change the level.
        const setLevel = await call(
          csms,
          "sv-level",
          "SetVariables",
          {
            setVariableData: [
              {
                attributeValue: "2",
                component: MONITORING_CTRLR,
                variable: { name: "ActiveMonitoringLevel" },
              },
            ],
          },
          v.setVariables,
        );
        expect(
          (setLevel.setVariableResult as GetVariableResult[])[0]
            .attributeStatus,
        ).toBe("Rejected");
        expect(cp.monitoring.monitoringLevel).toBe(4);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it(`${v.version}: a monitor on ActiveMonitoringLevel reports SetMonitoringLevel changes`, async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(
        csms,
        `CP-MLEVEL-${v.version}`,
        v.version,
      );
      try {
        const set = await call(csms, "svm-1", "SetVariableMonitoring", {
          setMonitoringData: [
            {
              value: 0,
              type: "Delta",
              severity: 0,
              component: MONITORING_CTRLR,
              variable: { name: "ActiveMonitoringLevel" },
            },
            {
              value: 10,
              type: "UpperThreshold",
              severity: 0,
              component: MONITORING_CTRLR,
              variable: { name: "ActiveMonitoringLevel" },
            },
          ],
        });
        expect(
          (set.setMonitoringResult as { status: string }[]).map(
            (r) => r.status,
          ),
        ).toEqual(["Accepted", "Rejected"]);

        await call(csms, "sml-5", "SetMonitoringLevel", { severity: 5 });
        const frame = await csms.waitForFrame(callOf("NotifyEvent"));
        expect(v.notifyEvent(frame[3])).toBe(true);
        expect(
          (frame[3] as { eventData: Record<string, unknown>[] }).eventData[0],
        ).toMatchObject({
          trigger: "Delta",
          actualValue: "5",
          component: MONITORING_CTRLR,
          variable: { name: "ActiveMonitoringLevel" },
        });
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it(`${v.version}: GetBaseReport publishes the MonitoringCtrlr variables and the bounds of integer variables (N04.FR.06)`, async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(
        csms,
        `CP-MBASE-${v.version}`,
        v.version,
      );
      try {
        await call(csms, "gbr-1", "GetBaseReport", {
          requestId: 1,
          reportBase: "FullInventory",
        });
        const frame = await csms.waitForFrame(callOf("NotifyReport"));
        expect(v.notifyReport(frame[3])).toBe(true);
        const data = (frame[3] as { reportData: ReportDatum[] }).reportData;
        const find = (component: string, variable: string, instance?: string) =>
          data.find(
            (d) =>
              d.component.name === component &&
              d.variable.name === variable &&
              d.variable.instance === instance,
          );

        expect(find("MonitoringCtrlr", "ActiveMonitoringLevel")).toMatchObject({
          variableAttribute: [{ value: "9", mutability: "ReadOnly" }],
          variableCharacteristics: {
            dataType: "integer",
            minLimit: 0,
            maxLimit: 9,
          },
        });
        expect(find("MonitoringCtrlr", "ActiveMonitoringBase")).toMatchObject({
          variableAttribute: [{ value: "All", mutability: "ReadOnly" }],
          variableCharacteristics: {
            dataType: "OptionList",
            valuesList: "All,FactoryDefault,HardWiredOnly",
          },
        });
        for (const instance of [
          "SetVariableMonitoring",
          "ClearVariableMonitoring",
        ]) {
          expect(
            find("MonitoringCtrlr", "ItemsPerMessage", instance)
              ?.variableAttribute[0],
          ).toMatchObject({ value: "100", mutability: "ReadOnly" });
          expect(
            find("MonitoringCtrlr", "BytesPerMessage", instance)
              ?.variableAttribute[0],
          ).toMatchObject({ value: "65536", mutability: "ReadOnly" });
        }
        expect(
          find("AlignedDataCtrlr", "Interval")?.variableCharacteristics,
        ).toEqual({
          dataType: "integer",
          minLimit: 0,
          maxLimit: 86400,
          supportsMonitoring: true,
        });
        // No bounds, no limits.
        expect(
          find("OCPPCommCtrlr", "HeartbeatInterval")?.variableCharacteristics,
        ).toEqual({ dataType: "integer", supportsMonitoring: true });
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  }
});
