import type { GetVariablesRequestV201 } from "../../../../../ocpp";
import { describe, expect, it } from "vitest";
import {
  ConfigurationKeys,
  ConfigurationStore,
  type ConfigurationValue,
} from "../../../../domain/charge-point/ConfigurationStore";
import { DeviceModelTargets } from "../../../../domain/charge-point/DeviceModelTargets";
import {
  isValidGetVariablesResponseV21,
  isValidSetVariablesResponseV21,
} from "../../../../../ocpp/v21";
import { handleGetVariablesV201 } from "../getVariablesV201";
import { handleSetVariablesV201 } from "../setVariablesV201";

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

describe("handleGetVariablesV201 EVSE-scoped runtime variables (#538)", () => {
  /** A two-EVSE station's runtime values, as ChargePoint publishes them. */
  function runtimeStore(): ConfigurationStore {
    const store = storeWithDefaults();
    store.defineRuntimeIntegerKey("EVSEPower1", 7400);
    store.defineRuntimeIntegerKey("EVSEPower2", 0);
    for (const n of [1, 2]) {
      const state = n === 1 ? "Occupied" : "Available";
      store.defineRuntimeKey(`EVSEAvailabilityState${n}`, state);
      store.defineRuntimeKey(`ConnectorAvailabilityState${n}`, state);
    }
    store.defineRuntimeKey("ChargingStationAvailabilityState", "Available");
    return store;
  }
  const twoEvses = (evse: { id: number; connectorId?: number }) =>
    evse.id >= 1 && evse.id <= 2 && (evse.connectorId ?? 1) === 1;

  function get(data: GetVariablesRequestV201["getVariableData"][number]) {
    return handleGetVariablesV201({ getVariableData: [data] }, runtimeStore(), {
      evseExists: twoEvses,
    }).getVariableResult[0];
  }

  it("reads EVSE.Power, the AvailabilityStates and ChargingStation.AvailabilityState per EVSE", () => {
    expect(
      [
        { component: { name: "EVSE", evse: { id: 1 } }, variable: "Power" },
        { component: { name: "EVSE", evse: { id: 2 } }, variable: "Power" },
        {
          component: { name: "EVSE", evse: { id: 1 } },
          variable: "AvailabilityState",
        },
        {
          component: { name: "Connector", evse: { id: 2, connectorId: 1 } },
          variable: "AvailabilityState",
        },
        {
          component: { name: "ChargingStation" },
          variable: "AvailabilityState",
        },
      ].map(({ component, variable }) =>
        get({ component, variable: { name: variable } }),
      ),
    ).toEqual([
      expect.objectContaining({
        attributeStatus: "Accepted",
        attributeValue: "7400",
      }),
      expect.objectContaining({
        attributeStatus: "Accepted",
        attributeValue: "0",
      }),
      expect.objectContaining({
        attributeStatus: "Accepted",
        attributeValue: "Occupied",
      }),
      expect.objectContaining({
        attributeStatus: "Accepted",
        attributeValue: "Available",
      }),
      expect.objectContaining({
        attributeStatus: "Accepted",
        attributeValue: "Available",
      }),
    ]);
    expect(
      get({
        component: { name: "EVSE", evse: { id: 1 } },
        variable: { name: "Power" },
      }),
    ).toEqual({
      attributeStatus: "Accepted",
      attributeType: "Actual",
      attributeValue: "7400",
      component: { name: "EVSE", evse: { id: 1 } },
      variable: { name: "Power" },
    });
  });

  it("answers UnknownComponent for an EVSE-scoped component without an EVSE or with one the station lacks", () => {
    for (const component of [
      { name: "EVSE" },
      { name: "EVSE", evse: { id: 3 } },
      { name: "EVSE", evse: { id: 0 } },
      { name: "Connector", evse: { id: 1, connectorId: 2 } },
    ]) {
      expect(
        get({ component, variable: { name: "AvailabilityState" } })
          .attributeStatus,
      ).toBe("UnknownComponent");
    }
  });

  it("answers UnknownVariable for a variable the EVSE does not publish", () => {
    expect(
      get({
        component: { name: "EVSE", evse: { id: 1 } },
        variable: { name: "EvseId" },
      }).attributeStatus,
    ).toBe("UnknownVariable");
  });

  it("does not find EVSE-scoped variables without the station's EVSE topology", () => {
    expect(
      handleGetVariablesV201(
        {
          getVariableData: [
            {
              component: { name: "EVSE", evse: { id: 1 } },
              variable: { name: "Power" },
            },
          ],
        },
        runtimeStore(),
      ).getVariableResult[0].attributeStatus,
    ).toBe("UnknownComponent");
  });
});

describe("handleGetVariablesV201 / handleSetVariablesV201 Target attribute (2.1, #538)", () => {
  function setup() {
    const store = storeWithDefaults();
    store.defineRuntimeIntegerKey("EVSEPower1", 7400);
    const targets = new DeviceModelTargets();
    targets.declare("EVSEPower1");
    return {
      store,
      targets,
      context: { evseExists: (e: { id: number }) => e.id === 1, targets },
    };
  }
  const POWER = {
    component: { name: "EVSE", evse: { id: 1 } },
    variable: { name: "Power" },
  };

  it("answers an empty Target until one is set, then the target, echoing attributeType (B06.FR.03, FR.13)", () => {
    const { store, targets, context } = setup();
    const getTarget = () =>
      handleGetVariablesV201(
        { getVariableData: [{ attributeType: "Target", ...POWER }] },
        store,
        context,
      );
    const unset = getTarget();
    expect(isValidGetVariablesResponseV21(unset)).toBe(true);
    expect(unset.getVariableResult[0]).toEqual({
      attributeStatus: "Accepted",
      attributeType: "Target",
      attributeValue: "",
      ...POWER,
    });

    const set = handleSetVariablesV201(
      {
        setVariableData: [
          { attributeType: "Target", attributeValue: "7000.5", ...POWER },
        ],
      },
      store,
      context,
    );
    expect(isValidSetVariablesResponseV21(set)).toBe(true);
    expect(set.setVariableResult[0]).toEqual({
      attributeStatus: "Accepted",
      attributeType: "Target",
      ...POWER,
    });
    expect(targets.get("EVSEPower1")).toBe(7000.5);
    expect(getTarget().getVariableResult[0].attributeValue).toBe("7000.5");
    // The Actual value is untouched.
    expect(store.get("EVSEPower1")?.value).toBe(7400);
  });

  it("rejects a Target that is not a number (B05.FR.07)", () => {
    const { store, targets, context } = setup();
    for (const attributeValue of ["", "abc", "Infinity", "1e999"]) {
      const result = handleSetVariablesV201(
        {
          setVariableData: [
            { attributeType: "Target", attributeValue, ...POWER },
          ],
        },
        store,
        context,
      ).setVariableResult[0];
      expect(result.attributeStatus).toBe("Rejected");
    }
    expect(targets.get("EVSEPower1")).toBeUndefined();
  });

  it("answers NotSupportedAttributeType for a Target on a variable without one, or without targets (2.0.1) (B05.FR.06, B06.FR.08)", () => {
    const { store, context } = setup();
    expect(
      handleGetVariablesV201(
        {
          getVariableData: [
            {
              attributeType: "Target",
              component: { name: "OCPPCommCtrlr" },
              variable: { name: "HeartbeatInterval" },
            },
          ],
        },
        store,
        context,
      ).getVariableResult[0].attributeStatus,
    ).toBe("NotSupportedAttributeType");
    expect(
      handleGetVariablesV201(
        { getVariableData: [{ attributeType: "Target", ...POWER }] },
        store,
        { evseExists: context.evseExists },
      ).getVariableResult[0].attributeStatus,
    ).toBe("NotSupportedAttributeType");
    expect(
      handleSetVariablesV201(
        {
          setVariableData: [
            { attributeType: "Target", attributeValue: "1", ...POWER },
          ],
        },
        store,
        { evseExists: context.evseExists },
      ).setVariableResult[0].attributeStatus,
    ).toBe("NotSupportedAttributeType");
    expect(
      handleGetVariablesV201(
        { getVariableData: [{ attributeType: "MaxSet", ...POWER }] },
        store,
        context,
      ).getVariableResult[0].attributeStatus,
    ).toBe("NotSupportedAttributeType");
  });
});
