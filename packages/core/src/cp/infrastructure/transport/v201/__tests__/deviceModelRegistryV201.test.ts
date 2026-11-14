import { describe, expect, it } from "vitest";
import { makeChargePoint } from "../../../../domain/charge-point/__tests__/chargePointFixtures";
import { buildBaseReportData } from "../baseReportV201";
import { handleGetVariablesV201 } from "../getVariablesV201";
import { handleSetVariablesV201 } from "../setVariablesV201";
import { handleSetVariableMonitoringV201 } from "../variableMonitoringV201";

/** #604: registry-backed Device Model on a 2.x charge point. */

const cpFor = (ocppVersion: string) => makeChargePoint({ ocppVersion });

describe.each(["OCPP-2.0.1", "OCPP-2.1"])("Device Model registry (%s)", (v) => {
  it("publishes TxStartPoint / TxStopPoint as read-write member lists (#697)", () => {
    const cp = cpFor(v);
    const read = () =>
      handleGetVariablesV201(
        {
          getVariableData: [
            {
              component: { name: "TxCtrlr" },
              variable: { name: "TxStartPoint" },
            },
            {
              component: { name: "TxCtrlr" },
              variable: { name: "TxStopPoint" },
            },
          ],
        },
        cp.configuration,
      ).getVariableResult.map((r) => r.attributeValue);
    const set = (variable: string, attributeValue: string) =>
      handleSetVariablesV201(
        {
          setVariableData: [
            {
              component: { name: "TxCtrlr" },
              variable: { name: variable },
              attributeValue,
            },
          ],
        },
        cp.configuration,
      ).setVariableResult[0].attributeStatus;
    expect(read()).toEqual(["Authorized", "Authorized,EVConnected"]);
    expect(set("TxStartPoint", "EVConnected")).toBe("Accepted");
    expect(set("TxStopPoint", "EVConnected")).toBe("Accepted");
    expect(read()).toEqual(["EVConnected", "EVConnected"]);
    // A set the simulator does not implement, a member it does not know,
    // and the empty set are Rejected and change nothing.
    expect(set("TxStartPoint", "PowerPathClosed")).toBe("Rejected");
    expect(set("TxStopPoint", "Authorized")).toBe("Rejected");
    expect(set("TxStopPoint", "")).toBe("Rejected");
    expect(read()).toEqual(["EVConnected", "EVConnected"]);
    expect(set("TxStartPoint", "EVConnected,Authorized")).toBe("Accepted");
  });

  it("reports them ReadWrite with the registry's data type and values", () => {
    const data = buildBaseReportData(cpFor(v).configuration);
    const start = data.find((d) => d.variable.name === "TxStartPoint");
    expect(start?.component).toEqual({ name: "TxCtrlr" });
    expect(start?.variableAttribute[0]).toMatchObject({
      value: "Authorized",
      mutability: "ReadWrite",
    });
    expect(start?.variableCharacteristics).toMatchObject({
      dataType: "MemberList",
      valuesList: "Authorized,EVConnected",
    });
  });

  it("keeps variable monitoring on the registered variables", () => {
    const cp = cpFor(v);
    const res = handleSetVariableMonitoringV201(
      {
        setMonitoringData: [
          {
            type: "Delta",
            severity: 5,
            value: 10,
            component: { name: "OCPPCommCtrlr" },
            variable: { name: "HeartbeatInterval" },
          },
        ],
      },
      cp.monitoring,
      cp.configuration,
      {},
    );
    expect(res.setMonitoringResult[0].status).toBe("Accepted");
  });

  it("knows the new components but answers UnknownVariable for their variables", () => {
    const cp = cpFor(v);
    const get = handleGetVariablesV201(
      {
        getVariableData: [
          {
            component: { name: "ClockCtrlr" },
            variable: { name: "TimeSource" },
          },
          { component: { name: "NoSuchCtrlr" }, variable: { name: "X" } },
        ],
      },
      cp.configuration,
    );
    expect(get.getVariableResult.map((r) => r.attributeStatus)).toEqual([
      "UnknownVariable",
      "UnknownComponent",
    ]);
  });
});
