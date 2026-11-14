import { describe, expect, it } from "vitest";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { defaultConfiguration } from "../../../../domain/charge-point/Configuration";
import { ConfigurationStore } from "../../../../domain/charge-point/ConfigurationStore";
import { chargePointIdentityRejection } from "../../../../domain/charge-point/chargePointIdentity";
import { readConfigurationKeys } from "../../../../domain/charge-point/configurationAccess";
import { buildBaseReportData } from "../baseReportV201";
import { handleGetVariablesV201 } from "../getVariablesV201";
import { handleSetVariablesV201 } from "../setVariablesV201";

// #924: SecurityCtrlr.Identity is the 2.x face of the ChargePointIdentity key.

function newStore(): ConfigurationStore {
  const cp = {
    id: "CP-ACTIVE",
    connectorNumber: 1,
    wsUrl: "ws://csms.example/ocpp/",
    ocppVersion: "OCPP-2.0.1",
  } as ChargePoint;
  return new ConfigurationStore(defaultConfiguration(cp), null);
}

const set = (store: ConfigurationStore, value: string) =>
  handleSetVariablesV201(
    {
      setVariableData: [
        {
          attributeValue: value,
          component: { name: "SecurityCtrlr" },
          variable: { name: "Identity" },
        },
      ],
    },
    store,
  ).setVariableResult[0];

describe("SecurityCtrlr.Identity (#924)", () => {
  it("answers RebootRequired through the host, and reads the active identity until then", () => {
    const store = newStore();
    const pending: string[] = [];
    store.setChangeInterceptor("ChargePointIdentity", (raw) => {
      pending.push(raw);
      return chargePointIdentityRejection(raw) === undefined
        ? "RebootRequired"
        : "Rejected";
    });
    expect(set(store, "NEW_ID").attributeStatus).toBe("RebootRequired");
    expect(pending).toEqual(["NEW_ID"]);
    const read = handleGetVariablesV201(
      {
        getVariableData: [
          {
            component: { name: "SecurityCtrlr" },
            variable: { name: "Identity" },
          },
        ],
      },
      store,
    ).getVariableResult[0];
    expect(read.attributeValue).toBe("CP-ACTIVE");
  });

  it("is Rejected without a host that can rename", () => {
    const store = newStore();
    const res = set(store, "NEW_ID");
    expect(res.attributeStatus).toBe("Rejected");
    expect(store.getString("ChargePointIdentity")).toBe("CP-ACTIVE");
  });

  it("is reported read-only until a host can rename, then ReadWrite", () => {
    const store = newStore();
    const mutability = () =>
      readConfigurationKeys(store, true, ["ChargePointIdentity"]).keys[0];
    expect(mutability()?.readonly).toBe(true);
    expect(mutability()?.mutability).toBe("ReadOnly");
    const report = buildBaseReportData(store);
    const datum = report.find((d) => d.variable.name === "Identity");
    expect(datum?.variableAttribute[0]?.mutability).toBe("ReadOnly");

    store.setChangeInterceptor("ChargePointIdentity", () => "RebootRequired");
    expect(mutability()?.readonly).toBe(false);
    expect(mutability()?.mutability).toBe("ReadWrite");
    // 1.6 view of the same store.
    expect(
      readConfigurationKeys(store, false, ["ChargePointIdentity"]).keys[0]
        ?.readonly,
    ).toBe(false);
  });

  it("rejects what cannot go in a URL path", () => {
    for (const bad of ["", "a/b", "a b", "a?b", "a#b", "a%2Fb", "é"]) {
      expect(chargePointIdentityRejection(bad)).toBeDefined();
    }
    expect(chargePointIdentityRejection("x".repeat(48))).toBeUndefined();
    expect(chargePointIdentityRejection("x".repeat(49))).toBeDefined();
    expect(chargePointIdentityRejection("TEST_16J-P0.SUP~1")).toBeUndefined();
  });
});
