import { describe, expect, it, vi } from "vitest";
import {
  isValidGetVariablesResponseV201,
  isValidGetVariablesResponseV21,
  isValidSetVariablesResponseV201,
  isValidSetVariablesResponseV21,
  type GetVariablesRequestV201,
  type SetVariablesRequestV201,
} from "../../../../../ocpp";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { defaultConfiguration } from "../../../../domain/charge-point/Configuration";
import { ConfigurationStore } from "../../../../domain/charge-point/ConfigurationStore";
import { MonitoringStore } from "../../../../domain/monitoring/MonitoringStore";
import { buildBaseReportData } from "../baseReportV201";
import { handleGetVariablesV201 } from "../getVariablesV201";
import { handleSetVariablesV201 } from "../setVariablesV201";
import { handleSetVariableMonitoringV201 } from "../variableMonitoringV201";

/**
 * #537: the SecurityCtrlr variables of 2.0.1 / 2.1 Part 2 referenced
 * components §2.2.4 (CertificateEntries), §2.2.7 (MaxCertificateChainSize),
 * §2.2.8 (CertSigningWaitMinimum) and §2.2.9 (CertSigningRepeatTimes).
 * They exist on 2.x charge points only.
 */

function storeFor(ocppVersion: string): ConfigurationStore {
  const cp = {
    connectorNumber: 1,
    wsUrl: "ws://csms.example/ocpp/",
    ocppVersion,
  } as ChargePoint;
  return new ConfigurationStore("cp-security", defaultConfiguration(cp), null);
}

const VARIABLES: ReadonlyArray<[string, string, string]> = [
  // variable, default, mutability
  ["CertificateEntries", "0", "ReadOnly"],
  ["MaxCertificateChainSize", "10000", "ReadOnly"],
  ["CertSigningWaitMinimum", "60", "ReadWrite"],
  ["CertSigningRepeatTimes", "3", "ReadWrite"],
];

const VALIDATORS = {
  "OCPP-2.0.1": {
    get: isValidGetVariablesResponseV201,
    set: isValidSetVariablesResponseV201,
  },
  "OCPP-2.1": {
    get: isValidGetVariablesResponseV21,
    set: isValidSetVariablesResponseV21,
  },
} as const;

function getVariable(store: ConfigurationStore, variable: string) {
  const request: GetVariablesRequestV201 = {
    getVariableData: [
      { component: { name: "SecurityCtrlr" }, variable: { name: variable } },
    ],
  };
  return handleGetVariablesV201(request, store);
}

function setVariable(
  store: ConfigurationStore,
  variable: string,
  attributeValue: string,
) {
  const request: SetVariablesRequestV201 = {
    setVariableData: [
      {
        attributeValue,
        component: { name: "SecurityCtrlr" },
        variable: { name: variable },
      },
    ],
  };
  return handleSetVariablesV201(request, store);
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"] as const)(
  "%s SecurityCtrlr variables",
  (version) => {
    it.each(VARIABLES)(
      "GetVariables reads SecurityCtrlr.%s (default %s)",
      (variable, value) => {
        const response = getVariable(storeFor(version), variable);
        expect(VALIDATORS[version].get(response)).toBe(true);
        expect(response.getVariableResult[0]).toEqual({
          attributeStatus: "Accepted",
          attributeType: "Actual",
          attributeValue: value,
          component: { name: "SecurityCtrlr" },
          variable: { name: variable },
        });
      },
    );

    it.each(VARIABLES)(
      "GetBaseReport lists SecurityCtrlr.%s as %s",
      (variable, value, mutability) => {
        const entry = buildBaseReportData(storeFor(version)).find(
          (d) =>
            d.component.name === "SecurityCtrlr" &&
            d.variable.name === variable,
        );
        expect(entry?.variableAttribute).toEqual([
          { type: "Actual", value, mutability },
        ]);
        expect(entry?.variableCharacteristics?.dataType).toBe("integer");
      },
    );

    it.each(["CertificateEntries", "MaxCertificateChainSize"])(
      "SetVariables refuses the ReadOnly SecurityCtrlr.%s",
      (variable) => {
        const store = storeFor(version);
        const response = setVariable(store, variable, "5");
        expect(VALIDATORS[version].set(response)).toBe(true);
        expect(response.setVariableResult[0].attributeStatus).toBe("Rejected");
      },
    );

    it("SetVariables writes CertSigningWaitMinimum and CertSigningRepeatTimes", () => {
      const store = storeFor(version);
      expect(
        setVariable(store, "CertSigningWaitMinimum", "30").setVariableResult[0]
          .attributeStatus,
      ).toBe("Accepted");
      expect(
        setVariable(store, "CertSigningRepeatTimes", "0").setVariableResult[0]
          .attributeStatus,
      ).toBe("Accepted");
      expect(store.certSigningWaitMinimum()).toBe(30);
      expect(store.certSigningRepeatTimes()).toBe(0);
    });

    it.each([
      ["CertSigningWaitMinimum", "0"],
      ["CertSigningRepeatTimes", "-1"],
    ])("SetVariables refuses %s = %s", (variable, value) => {
      const response = setVariable(storeFor(version), variable, value);
      expect(response.setVariableResult[0].attributeStatus).toBe("Rejected");
    });

    it("reads CertificateEntries from the value the station keeps current", () => {
      const store = storeFor(version);
      const listener = vi.fn();
      store.onChange(listener);

      expect(store.setRuntimeValue("CertificateEntries", 2)).toBe(true);
      expect(
        getVariable(store, "CertificateEntries").getVariableResult[0]
          .attributeValue,
      ).toBe("2");
      expect(listener).toHaveBeenCalledWith("CertificateEntries", 2);

      // Same value: no change event.
      listener.mockClear();
      store.setRuntimeValue("CertificateEntries", 2);
      expect(listener).not.toHaveBeenCalled();
    });

    it("accepts a Delta monitor on CertificateEntries", () => {
      const response = handleSetVariableMonitoringV201(
        {
          setMonitoringData: [
            {
              value: 1,
              type: "Delta",
              severity: 5,
              component: { name: "SecurityCtrlr" },
              variable: { name: "CertificateEntries" },
            },
          ],
        },
        new MonitoringStore(),
        storeFor(version),
        {},
      );
      expect(response.setMonitoringResult[0].status).toBe("Accepted");
    });
  },
);

describe("OCPP 1.6 configuration", () => {
  it.each(VARIABLES)("has no %s key", (variable) => {
    expect(storeFor("OCPP-1.6J").get(variable)).toBeUndefined();
  });
});

describe("setRuntimeValue", () => {
  it("refuses an unknown key", () => {
    expect(storeFor("OCPP-1.6J").setRuntimeValue("CertificateEntries", 1)).toBe(
      false,
    );
  });

  it("refuses a value of the wrong type", () => {
    expect(
      storeFor("OCPP-2.0.1").setRuntimeValue(
        "CertificateEntries",
        "1" as unknown as number,
      ),
    ).toBe(false);
  });
});
