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
});
