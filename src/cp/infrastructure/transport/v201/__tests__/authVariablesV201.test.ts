import { describe, expect, it } from "vitest";
import type {
  GetVariablesRequestV201,
  SetVariablesRequestV201,
} from "../../../../../ocpp";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { defaultConfiguration } from "../../../../domain/charge-point/Configuration";
import { ConfigurationStore } from "../../../../domain/charge-point/ConfigurationStore";
import { handleGetVariablesV201 } from "../getVariablesV201";
import { handleSetVariablesV201 } from "../setVariablesV201";

/**
 * #452: the 2.x authorization variables (2.0.1 Part 2 referenced
 * components §2.3-§2.4) read and write the same store the 1.6 keys do, so
 * one LocalAuthorizationPolicy serves every version.
 */

function storeFor(ocppVersion: string): ConfigurationStore {
  const cp = {
    connectorNumber: 1,
    wsUrl: "ws://csms.example/ocpp/",
    ocppVersion,
  } as ChargePoint;
  return new ConfigurationStore("cp-auth", defaultConfiguration(cp), null);
}

const MAPPED: ReadonlyArray<[string, string, string, string]> = [
  // component, variable, 1.6 store key, default
  ["AuthCacheCtrlr", "Enabled", "AuthorizationCacheEnabled", "false"],
  ["AuthCacheCtrlr", "LifeTime", "AuthCacheLifeTime", "0"],
  ["AuthCtrlr", "LocalPreAuthorize", "LocalPreAuthorize", "false"],
  ["AuthCtrlr", "LocalAuthorizeOffline", "LocalAuthorizeOffline", "true"],
  [
    "AuthCtrlr",
    "OfflineTxForUnknownIdEnabled",
    "AllowOfflineTxForUnknownId",
    "false",
  ],
];

describe.each(["OCPP-2.0.1", "OCPP-2.1"])("%s authorization variables", (v) => {
  it.each(MAPPED)(
    "GetVariables reads %s.%s from %s",
    (component, variable, _key, value) => {
      const request: GetVariablesRequestV201 = {
        getVariableData: [
          { component: { name: component }, variable: { name: variable } },
        ],
      };
      expect(handleGetVariablesV201(request, storeFor(v))).toEqual({
        getVariableResult: [
          {
            attributeStatus: "Accepted",
            attributeType: "Actual",
            attributeValue: value,
            component: { name: component },
            variable: { name: variable },
          },
        ],
      });
    },
  );

  it.each(MAPPED)(
    "SetVariables writes %s.%s into %s",
    (component, variable, key) => {
      const store = storeFor(v);
      const next =
        key === "AuthCacheLifeTime" ? "3600" : String(!store.getBoolean(key));
      const request: SetVariablesRequestV201 = {
        setVariableData: [
          {
            attributeValue: next,
            component: { name: component },
            variable: { name: variable },
          },
        ],
      };
      expect(
        handleSetVariablesV201(request, store).setVariableResult[0],
      ).toEqual({
        attributeStatus: "Accepted",
        attributeType: "Actual",
        component: { name: component },
        variable: { name: variable },
      });
      expect(String(store.get(key)?.value)).toBe(next);
    },
  );

  it("refuses a negative AuthCacheCtrlr.LifeTime", () => {
    const store = storeFor(v);
    const request: SetVariablesRequestV201 = {
      setVariableData: [
        {
          attributeValue: "-1",
          component: { name: "AuthCacheCtrlr" },
          variable: { name: "LifeTime" },
        },
      ],
    };
    expect(
      handleSetVariablesV201(request, store).setVariableResult[0]
        .attributeStatus,
    ).toBe("Rejected");
    expect(store.authCacheLifeTimeSeconds()).toBeNull();
  });

  it("answers UnknownVariable for an unmapped AuthCacheCtrlr variable", () => {
    // Mapping Enabled/LifeTime makes AuthCacheCtrlr a known component, so
    // Policy / Storage / Available (all "Required: no") are unknown
    // variables rather than an unknown component.
    const request: GetVariablesRequestV201 = {
      getVariableData: [
        { component: { name: "AuthCacheCtrlr" }, variable: { name: "Policy" } },
      ],
    };
    expect(
      handleGetVariablesV201(request, storeFor(v)).getVariableResult[0]
        .attributeStatus,
    ).toBe("UnknownVariable");
  });
});

describe("AuthCacheLifeTime", () => {
  it("is not a 1.6 configuration key", () => {
    // 1.6 has no cache lifetime; GetConfiguration must not grow a key.
    expect(storeFor("OCPP-1.6J").get("AuthCacheLifeTime")).toBeUndefined();
    expect(storeFor("OCPP-1.6J").authCacheLifeTimeSeconds()).toBeNull();
  });

  it("reads 0 as no lifetime and a positive value as seconds", () => {
    const store = storeFor("OCPP-2.0.1");
    expect(store.authCacheLifeTimeSeconds()).toBeNull();
    expect(store.applyChange("AuthCacheLifeTime", "90")).toBe("Accepted");
    expect(store.authCacheLifeTimeSeconds()).toBe(90);
  });
});
