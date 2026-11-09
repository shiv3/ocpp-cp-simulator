import { describe, it, expect } from "bun:test";
import { startMockCsms } from "./mockCsms";
import { bootedChargePoint, callsOf } from "./stationHarness";
import { validateV201Request } from "../codec/validateV201";

interface SetVarsReply {
  setVariableResult: Array<{
    attributeStatus: string;
    attributeStatusInfo: { reasonCode: string };
  }>;
}
interface MeterValuesPayload {
  meterValue: Array<{ sampledValue: Array<{ measurand: string }> }>;
}

// #714: B05.FR.07 - a measurand outside MeasurandEnumType is Rejected
// (InvalidValue), and no schema-invalid MeterValues leaves the station.
const SET = (value: string) => ({
  setVariableData: [
    {
      attributeValue: value,
      component: { name: "SampledDataCtrlr" },
      variable: { name: "TxUpdatedMeasurands" },
    },
  ],
});

describe.each(["OCPP-2.0.1", "OCPP-2.1"])("%s measurand lists (#714)", (v) => {
  it("rejects Temperature/Foo, keeps the list, and never sends them", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP714", v);
    try {
      const before = cp.configuration.meterValuesSampledData();
      csms.send([
        2,
        "sv-1",
        "SetVariables",
        SET("Energy.Active.Import.Register,Temperature,Foo"),
      ]);
      const reply = await csms.waitForFrame(
        (f) => f[0] === 3 && f[1] === "sv-1",
      );
      const result = (reply[2] as SetVarsReply).setVariableResult[0];
      expect(result.attributeStatus).toBe("Rejected");
      expect(result.attributeStatusInfo.reasonCode).toBe("InvalidValue");
      expect(cp.configuration.meterValuesSampledData()).toEqual(before);

      // A list that got in another way (persisted state, a scenario) is still
      // filtered at the wire.
      cp.configuration.applyChange(
        "MeterValuesSampledData",
        "Energy.Active.Import.Register,Temperature,RPM,Foo,Frequency",
      );
      cp.sendMeterValue(1);
      const mv = await csms.waitForFrame(
        (f) => f[0] === 2 && f[2] === "MeterValues",
      );
      const payload = mv[3] as MeterValuesPayload;
      expect(
        payload.meterValue[0].sampledValue.map((s) => s.measurand),
      ).toEqual(["Energy.Active.Import.Register", "Frequency"]);
      expect(validateV201Request("MeterValues", payload).valid).toBe(true);
      expect(callsOf(csms, "MeterValues")).toHaveLength(1);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});

describe("OCPP-1.6J keeps Temperature (#714)", () => {
  it("ChangeConfiguration accepts it", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP714-16", "OCPP-1.6J");
    try {
      csms.send([
        2,
        "cc-1",
        "ChangeConfiguration",
        {
          key: "MeterValuesSampledData",
          value: "Energy.Active.Import.Register,Temperature",
        },
      ]);
      const reply = await csms.waitForFrame(
        (f) => f[0] === 3 && f[1] === "cc-1",
      );
      expect((reply[2] as { status: string }).status).toBe("Accepted");
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
