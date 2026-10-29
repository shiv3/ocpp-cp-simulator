import type { SetVariablesRequestV201 } from "../../../../../ocpp";
import { describe, expect, it } from "vitest";
import {
  ConfigurationKeys,
  ConfigurationStore,
  type ConfigurationValue,
  type ConfigurationValueType,
} from "../../../../domain/charge-point/ConfigurationStore";
import { handleSetVariablesV201 } from "../setVariablesV201";

function storeWithDefaults(): ConfigurationStore {
  const entries: ConfigurationValue[] = [
    {
      key: ConfigurationKeys.Core.HeartbeatInterval,
      value: 300,
    },
    {
      key: ConfigurationKeys.Core.AuthorizeRemoteTxRequests,
      value: false,
    },
    {
      key: ConfigurationKeys.LocalAuthListManagement.LocalAuthListEnabled,
      value: true,
    },
  ];

  return new ConfigurationStore("cp-test", entries, null);
}

describe("handleSetVariablesV201", () => {
  it("writes mapped Actual values and reports per-variable status", () => {
    const store = storeWithDefaults();
    const changes: Array<[string, ConfigurationValueType]> = [];
    store.onChange((key, value) => changes.push([key, value]));

    const request: SetVariablesRequestV201 = {
      setVariableData: [
        {
          attributeValue: "120",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
        },
        {
          attributeValue: "true",
          component: { name: "AuthCtrlr" },
          variable: { name: "AuthorizeRemoteStart" },
        },
        {
          attributeValue: "anything",
          component: { name: "FooCtrlr" },
          variable: { name: "Bar" },
        },
        {
          attributeValue: "anything",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "Nonexistent" },
        },
        {
          attributeType: "Target",
          attributeValue: "60",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
        },
        {
          attributeValue: "false",
          component: { name: "LocalAuthListCtrlr" },
          variable: { name: "Enabled" },
        },
      ],
    };

    const response = handleSetVariablesV201(request, store);

    expect(response).toEqual({
      setVariableResult: [
        {
          attributeStatus: "Accepted",
          attributeType: "Actual",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
        },
        {
          attributeStatus: "Rejected",
          component: { name: "AuthCtrlr" },
          variable: { name: "AuthorizeRemoteStart" },
        },
        {
          attributeStatus: "UnknownComponent",
          component: { name: "FooCtrlr" },
          variable: { name: "Bar" },
        },
        {
          attributeStatus: "UnknownVariable",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "Nonexistent" },
        },
        {
          attributeStatus: "NotSupportedAttributeType",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
        },
        {
          attributeStatus: "Accepted",
          attributeType: "Actual",
          component: { name: "LocalAuthListCtrlr" },
          variable: { name: "Enabled" },
        },
      ],
    });

    request.setVariableData.forEach((data, index) => {
      expect(response.setVariableResult[index].component).toBe(data.component);
      expect(response.setVariableResult[index].variable).toBe(data.variable);
    });

    expect(store.getInteger("HeartbeatInterval")).toBe(120);
    expect(store.getBoolean("AuthorizeRemoteTxRequests")).toBe(false);
    expect(store.getBoolean("LocalAuthListEnabled")).toBe(false);
    expect(changes).toEqual([
      ["HeartbeatInterval", 120],
      ["LocalAuthListEnabled", false],
    ]);
  });

  // #454: AlignedDataCtrlr drives the clock-aligned scheduler through the
  // same 1.6 keys ChangeConfiguration writes.
  it("maps AlignedDataCtrlr Interval and Measurands, rejecting a negative interval", () => {
    const store = new ConfigurationStore(
      "cp-test",
      [
        { key: ConfigurationKeys.Core.ClockAlignedDataInterval, value: 0 },
        { key: ConfigurationKeys.Core.MeterValuesAlignedData, value: [] },
      ],
      null,
    );
    const changes: Array<[string, ConfigurationValueType]> = [];
    store.onChange((key, value) => changes.push([key, value]));

    const response = handleSetVariablesV201(
      {
        setVariableData: [
          {
            attributeValue: "900",
            component: { name: "AlignedDataCtrlr" },
            variable: { name: "Interval" },
          },
          {
            attributeValue: "Energy.Active.Import.Register,Voltage",
            component: { name: "AlignedDataCtrlr" },
            variable: { name: "Measurands" },
          },
          {
            attributeValue: "-60",
            component: { name: "AlignedDataCtrlr" },
            variable: { name: "Interval" },
          },
        ],
      },
      store,
    );

    expect(response.setVariableResult.map((r) => r.attributeStatus)).toEqual([
      "Accepted",
      "Accepted",
      "Rejected",
    ]);
    expect(changes).toEqual([
      ["ClockAlignedDataInterval", 900],
      ["MeterValuesAlignedData", ["Energy.Active.Import.Register", "Voltage"]],
    ]);
  });
});
