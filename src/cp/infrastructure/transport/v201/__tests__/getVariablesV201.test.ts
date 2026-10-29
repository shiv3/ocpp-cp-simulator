import type { GetVariablesRequestV201 } from "../../../../../ocpp";
import { describe, expect, it } from "vitest";
import {
  ConfigurationKeys,
  ConfigurationStore,
  type ConfigurationValue,
} from "../../../../domain/charge-point/ConfigurationStore";
import { handleGetVariablesV201 } from "../getVariablesV201";

function storeWithDefaults(): ConfigurationStore {
  const entries: ConfigurationValue[] = [
    {
      key: ConfigurationKeys.Core.HeartbeatInterval,
      value: 300,
    },
    {
      key: ConfigurationKeys.LocalAuthListManagement.LocalAuthListEnabled,
      value: true,
    },
  ];

  return new ConfigurationStore("cp-test", entries, null);
}

describe("handleGetVariablesV201", () => {
  it("reads mapped Actual values from the flat ConfigurationStore", () => {
    const request: GetVariablesRequestV201 = {
      getVariableData: [
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
        },
        {
          component: { name: "LocalAuthListCtrlr" },
          variable: { name: "Enabled" },
        },
      ],
    };

    const response = handleGetVariablesV201(request, storeWithDefaults());

    expect(response).toEqual({
      getVariableResult: [
        {
          attributeStatus: "Accepted",
          attributeType: "Actual",
          attributeValue: "300",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
        },
        {
          attributeStatus: "Accepted",
          attributeType: "Actual",
          attributeValue: "true",
          component: { name: "LocalAuthListCtrlr" },
          variable: { name: "Enabled" },
        },
      ],
    });
    expect(response.getVariableResult[0].component).toBe(
      request.getVariableData[0].component,
    );
    expect(response.getVariableResult[0].variable).toBe(
      request.getVariableData[0].variable,
    );
    expect(response.getVariableResult[1].component).toBe(
      request.getVariableData[1].component,
    );
    expect(response.getVariableResult[1].variable).toBe(
      request.getVariableData[1].variable,
    );
  });

  it("returns UnknownVariable for a known component with an unmapped variable", () => {
    const request: GetVariablesRequestV201 = {
      getVariableData: [
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "Nonexistent" },
        },
      ],
    };

    const response = handleGetVariablesV201(request, storeWithDefaults());

    expect(response.getVariableResult[0]).toEqual({
      attributeStatus: "UnknownVariable",
      component: request.getVariableData[0].component,
      variable: request.getVariableData[0].variable,
    });
  });

  it("returns UnknownComponent before variable or attribute checks", () => {
    const request: GetVariablesRequestV201 = {
      getVariableData: [
        {
          attributeType: "Target",
          component: { name: "FooCtrlr" },
          variable: { name: "Bar" },
        },
      ],
    };

    const response = handleGetVariablesV201(request, storeWithDefaults());

    expect(response.getVariableResult[0]).toEqual({
      attributeStatus: "UnknownComponent",
      component: request.getVariableData[0].component,
      variable: request.getVariableData[0].variable,
    });
  });

  // #490: OCPP 2.0.1 §2.1.10/2.1.11 and 2.1 §2.1.12 name these
  // MessageAttempts / MessageAttemptInterval with variableInstance
  // "TransactionEvent"; the flat "...TransactionEvent" names never existed.
  it("resolves an instanced variable and echoes the instance back", () => {
    const store = new ConfigurationStore(
      "cp-test",
      [
        { key: ConfigurationKeys.Core.TransactionMessageAttempts, value: 4 },
        {
          key: ConfigurationKeys.Core.TransactionMessageRetryInterval,
          value: 30,
        },
      ],
      null,
    );
    const request: GetVariablesRequestV201 = {
      getVariableData: [
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "MessageAttempts", instance: "TransactionEvent" },
        },
        {
          component: { name: "OCPPCommCtrlr" },
          variable: {
            name: "MessageAttemptInterval",
            instance: "TransactionEvent",
          },
        },
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "MessageAttempts" },
        },
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "MessageAttempts", instance: "Other" },
        },
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "MessageAttemptsTransactionEvent" },
        },
      ],
    };

    const response = handleGetVariablesV201(request, store);

    expect(response.getVariableResult).toEqual([
      {
        attributeStatus: "Accepted",
        attributeType: "Actual",
        attributeValue: "4",
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "MessageAttempts", instance: "TransactionEvent" },
      },
      {
        attributeStatus: "Accepted",
        attributeType: "Actual",
        attributeValue: "30",
        component: { name: "OCPPCommCtrlr" },
        variable: {
          name: "MessageAttemptInterval",
          instance: "TransactionEvent",
        },
      },
      {
        attributeStatus: "UnknownVariable",
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "MessageAttempts" },
      },
      {
        attributeStatus: "UnknownVariable",
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "MessageAttempts", instance: "Other" },
      },
      {
        attributeStatus: "UnknownVariable",
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "MessageAttemptsTransactionEvent" },
      },
    ]);
  });

  it("still resolves an instance-less variable when the CSMS names an instance", () => {
    const request: GetVariablesRequestV201 = {
      getVariableData: [
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval", instance: "Anything" },
        },
      ],
    };

    const response = handleGetVariablesV201(request, storeWithDefaults());

    expect(response.getVariableResult[0]).toEqual({
      attributeStatus: "Accepted",
      attributeType: "Actual",
      attributeValue: "300",
      component: { name: "OCPPCommCtrlr" },
      variable: { name: "HeartbeatInterval", instance: "Anything" },
    });
  });

  it("returns NotSupportedAttributeType for non-Actual mapped variables", () => {
    const request: GetVariablesRequestV201 = {
      getVariableData: [
        {
          attributeType: "Target",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
        },
      ],
    };

    const response = handleGetVariablesV201(request, storeWithDefaults());

    expect(response.getVariableResult[0]).toEqual({
      attributeStatus: "NotSupportedAttributeType",
      component: request.getVariableData[0].component,
      variable: request.getVariableData[0].variable,
    });
  });
});
