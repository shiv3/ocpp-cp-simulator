import { describe, expect, it } from "vitest";
import { isValidNotifyReportRequestV201 } from "../../../../../ocpp/v201";
import { isValidNotifyReportRequestV21 } from "../../../../../ocpp/v21";
import { ConfigurationStore } from "../../../../domain/charge-point/ConfigurationStore";
import { DeviceModelTargets } from "../../../../domain/charge-point/DeviceModelTargets";
import { buildBaseReportData } from "../baseReportV201";

/** #538: the per-EVSE runtime values and the 2.1 Target of EVSE.Power. */

function store(): ConfigurationStore {
  const configuration = new ConfigurationStore("cp-report", [], null);
  configuration.defineRuntimeIntegerKey("EVSEPower1", 7400);
  configuration.defineRuntimeIntegerKey("EVSEPower2", 0);
  return configuration;
}

const notifyReport = (reportData: unknown[]) => ({
  requestId: 1,
  generatedAt: "2026-10-30T00:00:00.000Z",
  seqNo: 0,
  tbc: false,
  reportData,
});

describe("buildBaseReportData", () => {
  it("lists EVSE.Power once per EVSE, Actual only without targets (2.0.1)", () => {
    const data = buildBaseReportData(store(), [2, 1]);
    expect(isValidNotifyReportRequestV201(notifyReport(data))).toBe(true);
    expect(
      data.map((d) => [d.component, d.variableAttribute.map((a) => a.type)]),
    ).toEqual([
      [{ name: "EVSE", evse: { id: 1 } }, ["Actual"]],
      [{ name: "EVSE", evse: { id: 2 } }, ["Actual"]],
    ]);
  });

  it("adds the ReadWrite Target of EVSE.Power on 2.1, its value once set", () => {
    const targets = new DeviceModelTargets();
    targets.declare("EVSEPower1");
    targets.declare("EVSEPower2");
    targets.set("EVSEPower1", 7000);
    const data = buildBaseReportData(store(), [1, 2], targets);
    expect(isValidNotifyReportRequestV21(notifyReport(data))).toBe(true);
    expect(data.map((d) => d.variableAttribute)).toEqual([
      [
        { type: "Actual", value: "7400", mutability: "ReadOnly" },
        { type: "Target", value: "7000", mutability: "ReadWrite" },
      ],
      [
        { type: "Actual", value: "0", mutability: "ReadOnly" },
        { type: "Target", mutability: "ReadWrite" },
      ],
    ]);
  });
});
