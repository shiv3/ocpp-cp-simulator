import { describe, expect, it } from "vitest";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { defaultConfiguration } from "../../../../domain/charge-point/Configuration";
import { ConfigurationStore } from "../../../../domain/charge-point/ConfigurationStore";
import { DEVICE_MODEL } from "../../../../domain/device-model/DeviceModelRegistry";
import {
  CONFIGURATION_VALUE_MAX_SIZE,
  REPORTING_VALUE_MAX_SIZE,
  truncateValue,
} from "../../../../domain/device-model/deviceDataCtrlrKeys";
import { buildBaseReportData } from "../baseReportV201";
import { handleGetVariablesV201 } from "../getVariablesV201";
import { handleSetVariablesV201 } from "../setVariablesV201";

// Part 2 DeviceDataCtrlr.ConfigurationValueSize / ReportingValueSize: the
// longest value SetVariables takes, and the longest value the station reports.

function newStore(sizes?: {
  configuration?: number;
  reporting?: number;
}): ConfigurationStore {
  const cp = {
    connectorNumber: 1,
    wsUrl: "ws://csms.example/ocpp/",
    ocppVersion: "OCPP-2.0.1",
  } as ChargePoint;
  const store = new ConfigurationStore(defaultConfiguration(cp), null);
  store.defineRuntimeIntegerKey(
    "ConfigurationValueSize",
    sizes?.configuration ?? CONFIGURATION_VALUE_MAX_SIZE,
  );
  store.defineRuntimeIntegerKey(
    "ReportingValueSize",
    sizes?.reporting ?? REPORTING_VALUE_MAX_SIZE,
  );
  return store;
}

const set = (store: ConfigurationStore, value: string) =>
  handleSetVariablesV201(
    {
      setVariableData: [
        {
          component: { name: "AuthCtrlr" },
          variable: { name: "MasterPassGroupId" },
          attributeValue: value,
        },
      ],
    },
    store,
  ).setVariableResult[0];

const get = (store: ConfigurationStore) =>
  handleGetVariablesV201(
    {
      getVariableData: [
        {
          component: { name: "AuthCtrlr" },
          variable: { name: "MasterPassGroupId" },
        },
      ],
    },
    store,
  ).getVariableResult[0];

describe("DeviceDataCtrlr value sizes", () => {
  it("registers both as read-only integers at the schema's maxLength", () => {
    for (const [name, size] of [
      ["ConfigurationValueSize", CONFIGURATION_VALUE_MAX_SIZE],
      ["ReportingValueSize", REPORTING_VALUE_MAX_SIZE],
    ] as const) {
      const def = DEVICE_MODEL.find("DeviceDataCtrlr", name);
      expect(def).toMatchObject({
        mutability: "ReadOnly",
        dataType: "integer",
        default: size,
        max: size,
      });
    }
    expect(get(newStore()).attributeStatus).toBe("Accepted");
    const read = handleGetVariablesV201(
      {
        getVariableData: [
          {
            component: { name: "DeviceDataCtrlr" },
            variable: { name: "ConfigurationValueSize" },
          },
        ],
      },
      newStore(),
    ).getVariableResult[0];
    expect(read.attributeValue).toBe(String(CONFIGURATION_VALUE_MAX_SIZE));
  });

  it("SetVariables: a value longer than ConfigurationValueSize is Rejected / TooLargeElement", () => {
    const store = newStore({ configuration: 8 });
    expect(set(store, "12345678").attributeStatus).toBe("Accepted");
    const r = set(store, "123456789");
    expect(r.attributeStatus).toBe("Rejected");
    expect(r.attributeStatusInfo?.reasonCode).toBe("TooLargeElement");
    expect(store.get("MasterPassGroupId")?.value).toBe("12345678");
  });

  it("counts characters, not bytes", () => {
    const store = newStore({ configuration: 3 });
    expect(set(store, "äöü").attributeStatus).toBe("Accepted");
    expect(set(store, "😀😀😀").attributeStatus).toBe("Accepted");
    expect(set(store, "😀😀😀😀").attributeStatus).toBe("Rejected");
  });

  it("GetVariables and the base report truncate to ReportingValueSize", () => {
    const store = newStore({ reporting: 5 });
    expect(set(store, "ABCDEFGHIJ").attributeStatus).toBe("Accepted");
    expect(get(store)).toMatchObject({
      attributeStatus: "Accepted",
      attributeValue: "ABCDE",
    });
    const datum = buildBaseReportData(store).find(
      (rd) => rd.variable.name === "MasterPassGroupId",
    );
    expect(datum?.variableAttribute[0].value).toBe("ABCDE");
  });

  it("truncateValue keeps whole characters", () => {
    expect(truncateValue("😀😀😀", 2)).toBe("😀😀");
    expect(truncateValue("abc", 5)).toBe("abc");
  });
});
