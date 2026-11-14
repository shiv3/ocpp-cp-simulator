import { describe, expect, it } from "vitest";
import { makeChargePoint } from "../../../../domain/charge-point/__tests__/chargePointFixtures";
import { buildBaseReportData } from "../baseReportV201";
import { handleGetVariablesV201 } from "../getVariablesV201";
import { handleSetVariablesV201 } from "../setVariablesV201";
import { handleSetVariableMonitoringV201 } from "../variableMonitoringV201";

/** #604: registry-backed Device Model on a 2.x charge point. */

const cpFor = (ocppVersion: string) => makeChargePoint({ ocppVersion });

describe.each(["OCPP-2.0.1", "OCPP-2.1"])("Device Model registry (%s)", (v) => {
  it("publishes TxStartPoint / TxStopPoint as read-only values", () => {
    const cp = cpFor(v);
    const get = handleGetVariablesV201(
      {
        getVariableData: [
          {
            component: { name: "TxCtrlr" },
            variable: { name: "TxStartPoint" },
          },
          { component: { name: "TxCtrlr" }, variable: { name: "TxStopPoint" } },
        ],
      },
      cp.configuration,
    );
    expect(get.getVariableResult.map((r) => r.attributeValue)).toEqual([
      "Authorized",
      "Authorized,EVConnected",
    ]);
    const set = handleSetVariablesV201(
      {
        setVariableData: [
          {
            component: { name: "TxCtrlr" },
            variable: { name: "TxStartPoint" },
            attributeValue: "EVConnected",
          },
        ],
      },
      cp.configuration,
    );
    expect(set.setVariableResult[0].attributeStatus).toBe("Rejected");
    expect(cp.configuration.get("TxStartPoint")?.value).toBe("Authorized");
  });

  it("reports them with ReadOnly mutability and the registry's data type", () => {
    const data = buildBaseReportData(cpFor(v).configuration);
    const start = data.find((d) => d.variable.name === "TxStartPoint");
    expect(start?.component).toEqual({ name: "TxCtrlr" });
    expect(start?.variableAttribute[0]).toMatchObject({
      value: "Authorized",
      mutability: "ReadOnly",
    });
    expect(start?.variableCharacteristics?.dataType).toBe("MemberList");
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
            variable: { name: "NoSuchVariable" },
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
