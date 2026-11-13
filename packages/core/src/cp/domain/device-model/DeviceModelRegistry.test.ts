import { describe, expect, it } from "vitest";
import type { ChargePoint } from "../charge-point/ChargePoint";
import { defaultConfiguration } from "../charge-point/Configuration";
import {
  createDeviceModelRegistry,
  DEVICE_MODEL,
  deviceModelVariableId,
  type DeviceModelVariableDef,
} from "./DeviceModelRegistry";

/** #604: the registry's metadata, its consistency with the store, #569's rule. */

const cpOf = (ocppVersion: string) =>
  ({
    connectorNumber: 1,
    wsUrl: "ws://csms.example/ocpp/",
    ocppVersion,
    supportsWebSocketPing: true,
  }) as ChargePoint;

describe("DEVICE_MODEL", () => {
  it("has the components of #604", () => {
    for (const name of [
      "ChargingStation",
      "ClockCtrlr",
      "DeviceDataCtrlr",
      "TariffCostCtrlr",
      "ISO15118Ctrlr",
      "TxCtrlr",
      "SecurityCtrlr",
    ]) {
      expect(DEVICE_MODEL.hasComponent(name), name).toBe(true);
    }
    expect(DEVICE_MODEL.hasComponent("NoSuchCtrlr")).toBe(false);
  });

  it("never lists a writable variable without simulated behavior (#569)", () => {
    for (const v of DEVICE_MODEL.variables) {
      if (v.mutability === "ReadOnly") {
        expect(v.effect, deviceModelVariableId(v)).toBeUndefined();
      } else {
        expect(v.effect, deviceModelVariableId(v)).toBeTruthy();
        expect(v.persistence, deviceModelVariableId(v)).toBe("Persistent");
      }
    }
  });

  it("registers TxStartPoint / TxStopPoint ReadOnly until timing follows them", () => {
    for (const name of ["TxStartPoint", "TxStopPoint"]) {
      const v = DEVICE_MODEL.find("TxCtrlr", name);
      expect(v?.mutability).toBe("ReadOnly");
      expect(v?.constant).toBe(true);
    }
  });

  it("agrees with the ConfigurationStore keys it maps onto", () => {
    const v201 = new Map(
      defaultConfiguration(cpOf("OCPP-2.0.1")).map((e) => [e.key.name, e]),
    );
    const v16 = new Set(
      defaultConfiguration(cpOf("OCPP-1.6J")).map((e) => e.key.name),
    );
    for (const def of DEVICE_MODEL.variables) {
      const id = deviceModelVariableId(def);
      if (def.persistence === "Volatile") {
        expect(v201.has(def.valueKey), id).toBe(false);
        continue;
      }
      const entry = v201.get(def.valueKey);
      expect(entry, id).toBeDefined();
      if (!entry) continue;
      expect(def.mutability === "ReadOnly", id).toBe(entry.key.readonly);
      expect(def.sharedWith16, id).toBe(v16.has(def.valueKey));
      expect(def.min, id).toBe(entry.key.min);
      expect(def.max, id).toBe(entry.key.max);
      expect(def.default, id).toEqual(entry.value);
      const expectedType = {
        integer: "integer",
        boolean: "boolean",
        string: entry.key.allowed ? "OptionList" : "string",
        array: "MemberList",
      }[entry.key.type];
      expect(def.dataType, id).toBe(expectedType);
      // A MemberList may advertise values the store does not enforce (the
      // measurands); an OptionList's values are the store's `allowed`.
      if (entry.key.allowed !== undefined || def.dataType !== "MemberList") {
        expect(def.valuesList, id).toEqual(entry.key.allowed);
      }
    }
  });

  it("keeps ResetRetries read-write on 1.6 and 2.x (Part 2 §2.1.14)", () => {
    const resetRetries = (version: "OCPP-1.6J" | "OCPP-2.0.1") =>
      defaultConfiguration(cpOf(version)).find(
        (e) => e.key.name === "ResetRetries",
      )?.key.readonly;
    expect(resetRetries("OCPP-1.6J")).toBe(false);
    expect(resetRetries("OCPP-2.0.1")).toBe(false);
    expect(DEVICE_MODEL.find("OCPPCommCtrlr", "ResetRetries")?.mutability).toBe(
      "ReadWrite",
    );
  });

  it("reports a valuesList for every MemberList", () => {
    for (const def of DEVICE_MODEL.variables) {
      if (def.dataType === "MemberList") {
        expect(
          def.valuesList?.length,
          deviceModelVariableId(def),
        ).toBeGreaterThan(0);
      }
    }
  });

  it("resolves an instanced variable only with its instance", () => {
    expect(
      DEVICE_MODEL.find("OCPPCommCtrlr", "MessageAttempts"),
    ).toBeUndefined();
    expect(
      DEVICE_MODEL.find("OCPPCommCtrlr", "MessageAttempts", "TransactionEvent")
        ?.valueKey,
    ).toBe("TransactionMessageAttempts");
    expect(
      DEVICE_MODEL.byValueKey("TransactionMessageAttempts")?.variable,
    ).toBe("MessageAttempts");
  });
});

describe("createDeviceModelRegistry", () => {
  const components = [{ name: "C", summary: "c" }];
  const base: DeviceModelVariableDef = {
    component: "C",
    variable: "V",
    valueKey: "K",
    sharedWith16: false,
    mutability: "ReadOnly",
    dataType: "integer",
    persistence: "Persistent",
  };
  const build = (...vars: DeviceModelVariableDef[]) =>
    createDeviceModelRegistry(components, vars);

  it("accepts a consistent definition", () => {
    const registry = build({ ...base, min: 1, max: 5, default: 3 });
    expect(registry.find("C", "V")?.valueKey).toBe("K");
    expect(registry.variablesOf("C")).toHaveLength(1);
  });

  it.each<[string, DeviceModelVariableDef[], RegExp]>([
    ["duplicate", [base, base], /duplicate variable/],
    ["unknown component", [{ ...base, component: "X" }], /unknown component/],
    [
      "writable without effect",
      [{ ...base, mutability: "ReadWrite" }],
      /needs its effect/,
    ],
    [
      "writable volatile",
      [
        {
          ...base,
          mutability: "ReadWrite",
          effect: "e",
          persistence: "Volatile",
        },
      ],
      /volatile variable is read-only/,
    ],
    [
      "bounds on a string",
      [{ ...base, dataType: "string", min: 1 }],
      /non-numeric/,
    ],
    ["default out of range", [{ ...base, max: 2, default: 3 }], /above max/],
    [
      "valuesList without OptionList or MemberList",
      [{ ...base, valuesList: ["a"] }],
      /valuesList goes with OptionList and MemberList/,
    ],
    [
      "default outside valuesList",
      [{ ...base, dataType: "OptionList", valuesList: ["a"], default: "b" }],
      /outside valuesList/,
    ],
    [
      "a MemberList without valuesList",
      [{ ...base, dataType: "MemberList" }],
      /valuesList goes with OptionList and MemberList/,
    ],
    [
      "a MemberList default outside valuesList",
      [
        {
          ...base,
          dataType: "MemberList",
          valuesList: ["a", "b"],
          default: "a,c",
        },
      ],
      /outside valuesList/,
    ],
    ["shared key", [base, { ...base, variable: "W" }], /already registered/],
  ])("refuses %s", (_name, vars, message) => {
    expect(() => build(...vars)).toThrow(message);
  });
});
