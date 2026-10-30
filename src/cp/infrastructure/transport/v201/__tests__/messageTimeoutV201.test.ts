import { describe, expect, it } from "vitest";
import type {
  GetVariablesRequestV201,
  SetVariablesRequestV201,
} from "../../../../../ocpp";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { defaultConfiguration } from "../../../../domain/charge-point/Configuration";
import { ConfigurationStore } from "../../../../domain/charge-point/ConfigurationStore";
import { buildBaseReportData } from "../baseReportV201";
import { handleGetVariablesV201 } from "../getVariablesV201";
import { handleSetVariablesV201 } from "../setVariablesV201";

/**
 * #529: `OCPPCommCtrlr.MessageTimeout[Default]` (2.0.1 / 2.1 Part 2
 * referenced components §2.1.3 "DefaultMessageTimeout": ReadOnly, seconds)
 * is the wait after which an unanswered TransactionEvent counts as a failed
 * transmission (E13).
 */

function storeFor(ocppVersion: string): ConfigurationStore {
  const cp = {
    connectorNumber: 1,
    wsUrl: "ws://csms.example/ocpp/",
    ocppVersion,
  } as ChargePoint;
  return new ConfigurationStore("cp-529", defaultConfiguration(cp), null);
}

const component = { name: "OCPPCommCtrlr" };
const variable = { name: "MessageTimeout", instance: "Default" };

describe.each(["OCPP-2.0.1", "OCPP-2.1"])("%s MessageTimeout", (v) => {
  it("defaults to 30 seconds", () => {
    expect(storeFor(v).messageTimeout()).toBe(30);
  });

  it("GetVariables reads OCPPCommCtrlr.MessageTimeout[Default]", () => {
    const request: GetVariablesRequestV201 = {
      getVariableData: [{ component, variable }],
    };
    expect(handleGetVariablesV201(request, storeFor(v))).toEqual({
      getVariableResult: [
        {
          attributeStatus: "Accepted",
          attributeType: "Actual",
          attributeValue: "30",
          component,
          variable,
        },
      ],
    });
  });

  it("SetVariables is rejected: the variable is ReadOnly", () => {
    const store = storeFor(v);
    const request: SetVariablesRequestV201 = {
      setVariableData: [{ attributeValue: "5", component, variable }],
    };
    expect(handleSetVariablesV201(request, store).setVariableResult[0]).toEqual(
      {
        attributeStatus: "Rejected",
        component,
        variable,
      },
    );
    expect(store.messageTimeout()).toBe(30);
  });

  it("GetBaseReport lists it as ReadOnly with its instance", () => {
    const entry = buildBaseReportData(storeFor(v)).find(
      (d) => d.variable.name === "MessageTimeout",
    );
    expect(entry).toMatchObject({
      component,
      variable,
      variableAttribute: [{ value: "30", mutability: "ReadOnly" }],
      variableCharacteristics: { dataType: "integer" },
    });
  });
});

describe("MessageTimeout on 1.6", () => {
  it("is not a 1.6 configuration key", () => {
    // 1.6 GetConfiguration must not grow a key.
    expect(storeFor("OCPP-1.6J").get("MessageTimeout")).toBeUndefined();
  });
});
