import { describe, expect, it } from "bun:test";
import {
  isValidGetVariablesResponseV201,
  isValidSetVariableMonitoringResponseV201,
} from "../../../../ocpp/v201";
import {
  isValidGetMonitoringReportResponseV21,
  isValidGetVariablesResponseV21,
  isValidNotifyMonitoringReportRequestV21,
  isValidSetVariableMonitoringResponseV21,
  isValidSetVariablesResponseV21,
} from "../../../../ocpp/v21";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

/**
 * #538 over the wire: the runtime device-model values (EVSE.Power) resolve
 * per EVSE in GetVariables / SetVariableMonitoring, and on 2.1 EVSE.Power
 * has a Target that SetVariables sets and a TargetDelta monitor watches.
 */

type Validator = (data: unknown) => boolean;

const POWER = {
  component: { name: "EVSE", evse: { id: 1 } },
  variable: { name: "Power" },
};

async function withStation(
  version: string,
  body: (csms: MockCsms) => Promise<void>,
): Promise<void> {
  const csms = startMockCsms();
  const cp = new ChargePoint(
    `CP-RUNTIME-${version}`,
    DefaultBootNotification,
    1,
    csms.url,
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  cp.events.on("error", () => undefined);
  try {
    cp.connect();
    const boot = await csms.waitForCall("BootNotification");
    csms.replyCallResult(boot.messageId, {
      status: "Accepted",
      currentTime: "2026-10-30T00:00:00.000Z",
      interval: 300,
    });
    await csms.waitForFrame(
      (frame) =>
        frame[0] === 2 &&
        frame[2] === "StatusNotification" &&
        (frame[3] as { evseId?: number }).evseId === 1,
    );
    await body(csms);
  } finally {
    cp.disconnect();
    await csms.stop();
  }
}

async function reply(
  csms: MockCsms,
  messageId: string,
  action: string,
  payload: unknown,
): Promise<OcppFrame> {
  csms.send([2, messageId, action, payload]);
  return csms.waitForFrame(
    (frame) => (frame[0] === 3 || frame[0] === 4) && frame[1] === messageId,
  );
}

async function call(
  csms: MockCsms,
  messageId: string,
  action: string,
  payload: unknown,
  valid: Validator,
): Promise<Record<string, unknown>> {
  const frame = await reply(csms, messageId, action, payload);
  expect(frame[0]).toBe(3);
  expect(valid(frame[2])).toBe(true);
  return frame[2] as Record<string, unknown>;
}

describe("OCPP 2.x runtime device-model values (#538)", () => {
  for (const [version, valid] of [
    ["OCPP-2.0.1", isValidGetVariablesResponseV201],
    ["OCPP-2.1", isValidGetVariablesResponseV21],
  ] as const) {
    it(`${version}: GetVariables reads EVSE.Power of an EVSE the station has`, async () => {
      await withStation(version, async (csms) => {
        const response = await call(
          csms,
          "gv-power",
          "GetVariables",
          {
            getVariableData: [
              POWER,
              { component: { name: "EVSE" }, variable: { name: "Power" } },
              { ...POWER, attributeType: "Target" },
            ],
          },
          valid,
        );
        expect(
          (
            response.getVariableResult as {
              attributeStatus: string;
              attributeValue?: string;
            }[]
          ).map((r) => [r.attributeStatus, r.attributeValue]),
        ).toEqual([
          ["Accepted", "0"],
          ["UnknownComponent", undefined],
          // 2.0.1 has no Target attribute; 2.1 has one, not set yet.
          version === "OCPP-2.1"
            ? ["Accepted", ""]
            : ["NotSupportedAttributeType", undefined],
        ]);
      });
    });
  }

  it("OCPP-2.1: sets a Target, monitors it with TargetDelta and reports the monitor", async () => {
    await withStation("OCPP-2.1", async (csms) => {
      expect(
        await call(
          csms,
          "sv-target",
          "SetVariables",
          {
            setVariableData: [
              { ...POWER, attributeType: "Target", attributeValue: "7000" },
            ],
          },
          isValidSetVariablesResponseV21,
        ),
      ).toEqual({
        setVariableResult: [
          { attributeStatus: "Accepted", attributeType: "Target", ...POWER },
        ],
      });

      const set = await call(
        csms,
        "svm-target",
        "SetVariableMonitoring",
        {
          setMonitoringData: [
            { value: 500, type: "TargetDelta", severity: 3, ...POWER },
          ],
        },
        isValidSetVariableMonitoringResponseV21,
      );
      expect(set.setMonitoringResult).toEqual([
        {
          id: 1,
          status: "Accepted",
          type: "TargetDelta",
          severity: 3,
          ...POWER,
        },
      ]);

      const target = await call(
        csms,
        "gv-target",
        "GetVariables",
        { getVariableData: [{ ...POWER, attributeType: "Target" }] },
        isValidGetVariablesResponseV21,
      );
      expect(
        (target.getVariableResult as { attributeValue?: string }[])[0]
          .attributeValue,
      ).toBe("7000");

      expect(
        await call(
          csms,
          "gmr",
          "GetMonitoringReport",
          {
            requestId: 7,
            componentVariable: [{ component: { name: "EVSE" } }],
          },
          isValidGetMonitoringReportResponseV21,
        ),
      ).toEqual({ status: "Accepted" });
      const report = await csms.waitForFrame(
        (f) => f[0] === 2 && f[2] === "NotifyMonitoringReport",
      );
      expect(isValidNotifyMonitoringReportRequestV21(report[3])).toBe(true);
      expect((report[3] as { monitor: unknown[] }).monitor).toEqual([
        {
          ...POWER,
          variableMonitoring: [
            {
              id: 1,
              transaction: false,
              value: 500,
              type: "TargetDelta",
              severity: 3,
              eventNotificationType: "CustomMonitor",
            },
          ],
        },
      ]);
    });
  });

  it("OCPP-2.0.1: a TargetDelta SetVariableMonitoring is refused by the schema", async () => {
    await withStation("OCPP-2.0.1", async (csms) => {
      const frame = await reply(csms, "svm-td", "SetVariableMonitoring", {
        setMonitoringData: [
          { value: 500, type: "TargetDelta", severity: 3, ...POWER },
        ],
      });
      expect(frame[0]).toBe(4);
      // The station's answer to any 2.x payload outside its schema.
      expect(frame[2]).toBe("FormationViolation");
      expect(isValidSetVariableMonitoringResponseV201(frame[3])).toBe(false);
    });
  });
});
