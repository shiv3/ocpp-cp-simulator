import type {
  GetVariablesRequestV201,
  SetVariablesRequestV201,
} from "@ocpp-cp-simulator/ocpp/index";
import { describe, expect, it } from "vitest";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { defaultConfiguration } from "../../../../domain/charge-point/Configuration";
import { ConfigurationStore } from "../../../../domain/charge-point/ConfigurationStore";
import { DeviceModelTargets } from "../../../../domain/charge-point/DeviceModelTargets";
import { buildBaseReportData } from "../baseReportV201";
import { handleGetVariablesV201 } from "../getVariablesV201";
import { handleSetVariablesV201 } from "../setVariablesV201";

// #606: reason codes and size limits of SetVariables / GetVariables
// (B05.FR.04-FR.11, B06.FR.05-FR.09; reason codes: Part 2 Appendices §5).

function newStore(): ConfigurationStore {
  const cp = {
    connectorNumber: 1,
    wsUrl: "ws://csms.example/ocpp/",
    ocppVersion: "OCPP-2.0.1",
  } as ChargePoint;
  const store = new ConfigurationStore(
    "cp-606",
    defaultConfiguration(cp),
    null,
  );
  for (const key of [
    "ItemsPerMessageGetVariables",
    "ItemsPerMessageSetVariables",
  ]) {
    store.defineRuntimeIntegerKey(key, 3);
  }
  for (const key of [
    "BytesPerMessageGetVariables",
    "BytesPerMessageSetVariables",
  ]) {
    store.defineRuntimeIntegerKey(key, 600);
  }
  return store;
}

function setOne(
  store: ConfigurationStore,
  component: string,
  variable: string,
  attributeValue: string,
  extra: Record<string, unknown> = {},
) {
  const req: SetVariablesRequestV201 = {
    setVariableData: [
      {
        attributeValue,
        component: { name: component },
        variable: { name: variable },
        ...extra,
      },
    ],
  };
  return handleSetVariablesV201(req, store).setVariableResult[0];
}

describe("SetVariables reason codes", () => {
  it("Accepted carries no statusInfo", () => {
    const r = setOne(newStore(), "OCPPCommCtrlr", "HeartbeatInterval", "60");
    expect(r.attributeStatus).toBe("Accepted");
    expect(r.attributeStatusInfo).toBeUndefined();
  });

  it("a ReadOnly variable: Rejected / ReadOnly (B05.FR.09)", () => {
    const r = setOne(newStore(), "AuthCtrlr", "AuthorizeRemoteStart", "true");
    expect(r.attributeStatus).toBe("Rejected");
    expect(r.attributeStatusInfo?.reasonCode).toBe("ReadOnly");
  });

  it("a malformed value: Rejected / InvalidValue (B05.FR.07)", () => {
    const store = newStore();
    for (const [c, v, value] of [
      ["OCPPCommCtrlr", "HeartbeatInterval", "abc"],
      ["OCPPCommCtrlr", "HeartbeatInterval", "1.5"],
      ["OCPPCommCtrlr", "HeartbeatInterval", "1e2"],
      ["OCPPCommCtrlr", "HeartbeatInterval", ""],
      ["LocalAuthListCtrlr", "Enabled", "yes"],
    ] as const) {
      const r = setOne(store, c, v, value);
      expect(r.attributeStatus, `${v}=${value}`).toBe("Rejected");
      expect(r.attributeStatusInfo?.reasonCode, `${v}=${value}`).toBe(
        "InvalidValue",
      );
    }
    expect(store.get("HeartbeatInterval")?.value).toBe(300);
  });

  it("a value outside the variable's limits: Rejected / ValueOutOfRange (B05.FR.08)", () => {
    const store = newStore();
    const low = setOne(store, "AuthCacheCtrlr", "LifeTime", "-1");
    expect(low.attributeStatus).toBe("Rejected");
    expect(low.attributeStatusInfo?.reasonCode).toBe("ValueOutOfRange");
    const high = setOne(store, "AlignedDataCtrlr", "Interval", "86401");
    expect(high.attributeStatus).toBe("Rejected");
    expect(high.attributeStatusInfo?.reasonCode).toBe("ValueOutOfRange");
    expect(
      setOne(store, "AlignedDataCtrlr", "Interval", "86400"),
    ).toMatchObject({ attributeStatus: "Accepted" });
  });

  it("a ReadOnly variable given a malformed value is a format error first (B05.FR.09 'NOT FR.04-FR.08')", () => {
    const r = setOne(newStore(), "SecurityCtrlr", "CertificateEntries", "x");
    expect(r.attributeStatusInfo?.reasonCode).toBe("InvalidValue");
  });

  it("an OptionList value outside the list: Rejected / InvalidValue", () => {
    // The list is checked before mutability (B05.FR.09 applies only when
    // FR.04-FR.08 do not).
    const r = setOne(
      newStore(),
      "ChargingStation",
      "AvailabilityState",
      "Nope",
    );
    expect(r.attributeStatus).toBe("Rejected");
    expect(r.attributeStatusInfo?.reasonCode).toBe("InvalidValue");
  });

  it("unknown component / variable / attribute type carry no reason (B05.FR.04-FR.06)", () => {
    const store = newStore();
    expect(setOne(store, "NoCtrlr", "X", "1")).toEqual({
      attributeStatus: "UnknownComponent",
      component: { name: "NoCtrlr" },
      variable: { name: "X" },
    });
    expect(setOne(store, "OCPPCommCtrlr", "Nope", "1").attributeStatus).toBe(
      "UnknownVariable",
    );
    expect(
      setOne(store, "OCPPCommCtrlr", "HeartbeatInterval", "1", {
        attributeType: "MaxSet",
      }).attributeStatus,
    ).toBe("NotSupportedAttributeType");
  });
});

describe("SetVariables / GetVariables size limits", () => {
  const hb = {
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
  };

  it("more elements than ItemsPerMessage: every element Rejected / TooManyElements (B05.FR.11, B05.FR.01)", () => {
    const store = newStore();
    const req: SetVariablesRequestV201 = {
      setVariableData: [1, 2, 3, 4].map((n) => ({
        attributeValue: String(60 + n),
        ...hb,
      })) as SetVariablesRequestV201["setVariableData"],
    };
    const { setVariableResult } = handleSetVariablesV201(req, store);
    expect(setVariableResult).toHaveLength(4);
    for (const r of setVariableResult) {
      expect(r.attributeStatus).toBe("Rejected");
      expect(r.attributeStatusInfo?.reasonCode).toBe("TooManyElements");
      expect(r.component).toEqual(hb.component);
    }
    // Nothing was applied.
    expect(store.get("HeartbeatInterval")?.value).toBe(300);
  });

  it("exactly ItemsPerMessage elements is fine", () => {
    const req: SetVariablesRequestV201 = {
      setVariableData: [1, 2, 3].map((n) => ({
        attributeValue: String(60 + n),
        ...hb,
      })) as SetVariablesRequestV201["setVariableData"],
    };
    const { setVariableResult } = handleSetVariablesV201(req, newStore());
    expect(setVariableResult.map((r) => r.attributeStatus)).toEqual([
      "Accepted",
      "Accepted",
      "Accepted",
    ]);
  });

  it("a request longer than BytesPerMessage: Rejected / TooLargeElement", () => {
    const store = newStore();
    const req: SetVariablesRequestV201 = {
      setVariableData: [{ attributeValue: "x".repeat(700), ...hb }],
    };
    const r = handleSetVariablesV201(req, store).setVariableResult[0];
    expect(r.attributeStatus).toBe("Rejected");
    expect(r.attributeStatusInfo?.reasonCode).toBe("TooLargeElement");
  });

  it("GetVariables: TooManyElements and TooLargeElement keep one result per element (B06.FR.05, B06.FR.01)", () => {
    const store = newStore();
    const many: GetVariablesRequestV201 = {
      getVariableData: [1, 2, 3, 4].map(
        () => hb,
      ) as GetVariablesRequestV201["getVariableData"],
    };
    const res = handleGetVariablesV201(many, store).getVariableResult;
    expect(res).toHaveLength(4);
    expect(
      res.every(
        (r) =>
          r.attributeStatus === "Rejected" &&
          r.attributeStatusInfo?.reasonCode === "TooManyElements" &&
          r.attributeValue === undefined,
      ),
    ).toBe(true);

    const big: GetVariablesRequestV201 = {
      getVariableData: [
        {
          component: { name: "OCPPCommCtrlr", instance: "x".repeat(700) },
          variable: { name: "HeartbeatInterval" },
        },
      ],
    };
    expect(
      handleGetVariablesV201(big, store).getVariableResult[0]
        .attributeStatusInfo?.reasonCode,
    ).toBe("TooLargeElement");
  });

  it("without the limit keys the defaults (100 items) apply", () => {
    const cp = {
      connectorNumber: 1,
      wsUrl: "ws://x/",
      ocppVersion: "OCPP-2.0.1",
    } as ChargePoint;
    const store = new ConfigurationStore("c", defaultConfiguration(cp), null);
    const req: GetVariablesRequestV201 = {
      getVariableData: Array.from(
        { length: 100 },
        () => hb,
      ) as GetVariablesRequestV201["getVariableData"],
    };
    expect(
      handleGetVariablesV201(req, store).getVariableResult[0].attributeStatus,
    ).toBe("Accepted");
  });
});

describe("GetVariables reason codes", () => {
  it("a registered variable without a stored value: Rejected / MissingDevModelInfo", () => {
    const cp = {
      connectorNumber: 1,
      wsUrl: "ws://x/",
      ocppVersion: "OCPP-2.0.1",
    } as ChargePoint;
    const store = new ConfigurationStore("c", defaultConfiguration(cp), null);
    // ActiveMonitoringLevel is published at runtime; a bare store has none.
    const r = handleGetVariablesV201(
      {
        getVariableData: [
          {
            component: { name: "MonitoringCtrlr" },
            variable: { name: "ActiveMonitoringLevel" },
          },
        ],
      },
      store,
    ).getVariableResult[0];
    expect(r.attributeStatus).toBe("Rejected");
    expect(r.attributeStatusInfo?.reasonCode).toBe("MissingDevModelInfo");
    expect(r.attributeValue).toBeUndefined();
  });
});

describe("MinSet / MaxSet (B05 remark, Part 2 §3.2)", () => {
  const POWER = {
    component: { name: "EVSE", evse: { id: 1 } },
    variable: { name: "Power" },
  };
  function setup() {
    const store = newStore();
    store.defineRuntimeIntegerKey("EVSEPower1", 7400);
    const targets = new DeviceModelTargets();
    targets.declare("EVSEPower1");
    return {
      store,
      targets,
      context: { evseExists: (e: { id: number }) => e.id === 1, targets },
    };
  }
  const set = (
    s: ReturnType<typeof setup>,
    attributeType: "Target" | "MinSet" | "MaxSet",
    attributeValue: string,
  ) =>
    handleSetVariablesV201(
      { setVariableData: [{ attributeType, attributeValue, ...POWER }] },
      s.store,
      s.context,
    ).setVariableResult[0];
  const get = (
    s: ReturnType<typeof setup>,
    attributeType: "MinSet" | "MaxSet",
  ) =>
    handleGetVariablesV201(
      { getVariableData: [{ attributeType, ...POWER }] },
      s.store,
      s.context,
    ).getVariableResult[0];

  it("reads an empty value until set, then the value, echoing the type (B06.FR.13)", () => {
    const s = setup();
    expect(get(s, "MinSet")).toMatchObject({
      attributeStatus: "Accepted",
      attributeType: "MinSet",
      attributeValue: "",
    });
    expect(set(s, "MinSet", "1000")).toMatchObject({
      attributeStatus: "Accepted",
      attributeType: "MinSet",
    });
    expect(set(s, "MaxSet", "5000.5")).toMatchObject({
      attributeStatus: "Accepted",
      attributeType: "MaxSet",
    });
    expect(get(s, "MinSet").attributeValue).toBe("1000");
    expect(get(s, "MaxSet").attributeValue).toBe("5000.5");
    // The Actual value is untouched.
    expect(s.store.get("EVSEPower1")?.value).toBe(7400);
  });

  it("a Target outside [MinSet, MaxSet] is Rejected / ValueOutOfRange", () => {
    const s = setup();
    set(s, "MinSet", "1000");
    set(s, "MaxSet", "5000");
    for (const bad of ["999", "5001"]) {
      const r = set(s, "Target", bad);
      expect(r.attributeStatus).toBe("Rejected");
      expect(r.attributeStatusInfo?.reasonCode).toBe("ValueOutOfRange");
    }
    expect(s.targets.get("EVSEPower1")).toBeUndefined();
    expect(set(s, "Target", "3000").attributeStatus).toBe("Accepted");
    expect(s.targets.get("EVSEPower1")).toBe(3000);
  });

  it("MinSet may not pass MaxSet, and a malformed limit is InvalidValue", () => {
    const s = setup();
    set(s, "MaxSet", "5000");
    const crossed = set(s, "MinSet", "6000");
    expect(crossed.attributeStatus).toBe("Rejected");
    expect(crossed.attributeStatusInfo?.reasonCode).toBe("ValueOutOfRange");
    expect(s.targets.getLimit("EVSEPower1", "MinSet")).toBeUndefined();
    const bad = set(s, "MaxSet", "lots");
    expect(bad.attributeStatusInfo?.reasonCode).toBe("InvalidValue");
    expect(s.targets.getLimit("EVSEPower1", "MaxSet")).toBe(5000);
  });

  it("a variable without a Target has no MinSet / MaxSet", () => {
    const s = setup();
    expect(
      setOne(s.store, "OCPPCommCtrlr", "HeartbeatInterval", "1", {
        attributeType: "MinSet",
      }).attributeStatus,
    ).toBe("NotSupportedAttributeType");
  });

  it("GetBaseReport lists MinSet and MaxSet once they are set", () => {
    const s = setup();
    const power = () =>
      buildBaseReportData(s.store, [1], s.targets).find(
        (d) => d.component.name === "EVSE" && d.variable.name === "Power",
      );
    expect(power()?.variableAttribute.map((a) => a.type)).toEqual([
      "Actual",
      "Target",
    ]);
    set(s, "MinSet", "1000");
    set(s, "MaxSet", "5000");
    expect(power()?.variableAttribute.map((a) => [a.type, a.value])).toEqual([
      ["Actual", "7400"],
      ["Target", undefined],
      ["MinSet", "1000"],
      ["MaxSet", "5000"],
    ]);
  });
});
