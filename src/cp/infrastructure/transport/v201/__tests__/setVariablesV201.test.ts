import type { SetVariablesRequestV201 } from "../../../../../ocpp";
import { describe, expect, it } from "vitest";
import {
  ConfigurationKeys,
  ConfigurationStore,
  type ConfigurationValue,
  type ConfigurationValueType,
} from "../../../../domain/charge-point/ConfigurationStore";
import { DeviceModelTargets } from "../../../../domain/charge-point/DeviceModelTargets";
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

  // #490: the E13 settings are instanced variables (OCPP 2.0.1
  // §2.1.10/2.1.11, 2.1 §2.1.12); an instance-less entry still matches
  // whatever instance the CSMS names.
  it("writes instanced variables and keeps instance-less ones instance-agnostic", () => {
    const store = new ConfigurationStore(
      "cp-test",
      [
        { key: ConfigurationKeys.Core.HeartbeatInterval, value: 300 },
        { key: ConfigurationKeys.Core.TransactionMessageAttempts, value: 3 },
        {
          key: ConfigurationKeys.Core.TransactionMessageRetryInterval,
          value: 60,
        },
      ],
      null,
    );
    const changes: Array<[string, ConfigurationValueType]> = [];
    store.onChange((key, value) => changes.push([key, value]));

    const request: SetVariablesRequestV201 = {
      setVariableData: [
        {
          attributeValue: "2",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "MessageAttempts", instance: "TransactionEvent" },
        },
        {
          attributeValue: "5",
          component: { name: "OCPPCommCtrlr" },
          variable: {
            name: "MessageAttemptInterval",
            instance: "TransactionEvent",
          },
        },
        {
          attributeValue: "9",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "MessageAttempts" },
        },
        {
          attributeValue: "9",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "MessageAttemptsTransactionEvent" },
        },
        {
          attributeValue: "120",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval", instance: "Anything" },
        },
      ],
    };

    const response = handleSetVariablesV201(request, store);

    expect(response.setVariableResult).toEqual([
      {
        attributeStatus: "Accepted",
        attributeType: "Actual",
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "MessageAttempts", instance: "TransactionEvent" },
      },
      {
        attributeStatus: "Accepted",
        attributeType: "Actual",
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
        variable: { name: "MessageAttemptsTransactionEvent" },
      },
      {
        attributeStatus: "Accepted",
        attributeType: "Actual",
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "HeartbeatInterval", instance: "Anything" },
      },
    ]);
    expect(changes).toEqual([
      ["TransactionMessageAttempts", 2],
      ["TransactionMessageRetryInterval", 5],
      ["HeartbeatInterval", 120],
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

describe("handleSetVariablesV201 EVSE-scoped runtime variables (#538)", () => {
  it("rejects writing a read-only runtime value and answers UnknownComponent for an EVSE it lacks (B05.FR.04, FR.09)", () => {
    const store = storeWithDefaults();
    store.defineRuntimeKey("EVSEAvailabilityState1", "Available");
    const response = handleSetVariablesV201(
      {
        setVariableData: [
          {
            attributeValue: "Faulted",
            component: { name: "EVSE", evse: { id: 1 } },
            variable: { name: "AvailabilityState" },
          },
          {
            attributeValue: "Faulted",
            component: { name: "EVSE", evse: { id: 2 } },
            variable: { name: "AvailabilityState" },
          },
        ],
      },
      store,
      { evseExists: (evse) => evse.id === 1 },
    );
    expect(response.setVariableResult.map((r) => r.attributeStatus)).toEqual([
      "Rejected",
      "UnknownComponent",
    ]);
    expect(store.get("EVSEAvailabilityState1")?.value).toBe("Available");
  });
});

describe("handleSetVariablesV201 Target attribute (2.1, #538)", () => {
  it.each([
    ["1500", "Accepted", 1500],
    ["-2.5", "Accepted", -2.5],
    ["0x10", "Rejected", undefined],
    ["1e3", "Rejected", undefined],
    ["Infinity", "Rejected", undefined],
    ["+5", "Rejected", undefined],
    [".5", "Rejected", undefined],
    ["5.", "Rejected", undefined],
    [" 5 ", "Rejected", undefined],
    ["", "Rejected", undefined],
  ])("target %j is %s (decimal only, B05.FR.07)", (raw, status, target) => {
    const store = storeWithDefaults();
    store.defineRuntimeIntegerKey("EVSEPower1", 0);
    const targets = new DeviceModelTargets();
    targets.declare("EVSEPower1");
    const response = handleSetVariablesV201(
      {
        setVariableData: [
          {
            attributeType: "Target",
            attributeValue: raw,
            component: { name: "EVSE", evse: { id: 1 } },
            variable: { name: "Power" },
          },
        ],
      },
      store,
      { evseExists: (evse) => evse.id === 1, targets },
    );
    expect(response.setVariableResult[0].attributeStatus).toBe(status);
    expect(targets.get("EVSEPower1")).toBe(target);
  });
});
