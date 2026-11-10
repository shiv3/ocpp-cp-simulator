import { describe, expect, it } from "vitest";

import type { ChargePoint } from "../ChargePoint";
import { defaultConfiguration } from "../Configuration";
import { ConfigurationStore } from "../ConfigurationStore";
import {
  ConfigurationWriteRejectedError,
  UnknownConfigurationKeyError,
  readConfigurationKeys,
  writeConfigurationKey,
} from "../configurationAccess";
import type { Logger } from "../../../shared/Logger";
import { DEVICE_MODEL } from "../../device-model/DeviceModelRegistry";

const cpShape = {
  connectorNumber: 1,
  wsUrl: "ws://csms.example/ocpp/",
  ocppVersion: "OCPP-1.6J",
} as ChargePoint;

function store(): ConfigurationStore {
  return new ConfigurationStore(defaultConfiguration(cpShape));
}

describe("configuration key access (#612)", () => {
  describe("OCPP 1.6", () => {
    it("lists every key sorted, with type and read-only flag", () => {
      const { keys, unknown } = readConfigurationKeys(store(), false);
      expect(unknown).toEqual([]);
      expect(keys.map((k) => k.key)).toEqual(
        keys.map((k) => k.key).sort((a, b) => (a < b ? -1 : 1)),
      );
      const hb = keys.find((k) => k.key === "HeartbeatInterval");
      expect(hb).toMatchObject({ type: "integer", readonly: false });
      expect(hb?.component).toBeUndefined();
      expect(
        keys.find((k) => k.key === "GetConfigurationMaxKeys"),
      ).toMatchObject({ readonly: true });
    });

    it("reads named keys and reports unknown names", () => {
      const { keys, unknown } = readConfigurationKeys(store(), false, [
        "HeartbeatInterval",
        "NoSuchKey",
      ]);
      expect(keys.map((k) => k.key)).toEqual(["HeartbeatInterval"]);
      expect(unknown).toEqual(["NoSuchKey"]);
    });

    it("never returns the AuthorizationKey value", () => {
      const s = store();
      expect(s.applyChange("AuthorizationKey", "s3cret")).toBe("Accepted");
      const { keys } = readConfigurationKeys(s, false, ["AuthorizationKey"]);
      expect(keys[0]?.value).toBe("");
      expect(JSON.stringify(keys)).not.toContain("s3cret");
    });

    it("marks the write-only AuthorizationKey so a client can hide it", () => {
      const { keys } = readConfigurationKeys(store(), false, [
        "AuthorizationKey",
        "HeartbeatInterval",
      ]);
      expect(keys.map((k) => k.mutability)).toEqual(["WriteOnly", undefined]);
    });

    it("refuses a value longer than a CiString500, leaving the key unchanged", () => {
      const s = store();
      const before = s.get("MeterValuesSampledData")?.value;
      const long = Array(60).fill("Energy.Active.Import.Register").join(",");
      expect(long.length).toBeGreaterThan(500);
      expect(() =>
        writeConfigurationKey(s, false, "MeterValuesSampledData", long),
      ).toThrow(ConfigurationWriteRejectedError);
      expect(s.get("MeterValuesSampledData")?.value).toEqual(before);
    });

    it("logs an operator write and hides a write-only value", () => {
      const lines: string[] = [];
      const logger = {
        info: (m: string) => lines.push(m),
      } as unknown as Logger;
      const s = store();
      writeConfigurationKey(s, false, "HeartbeatInterval", "42", logger);
      writeConfigurationKey(s, false, "AuthorizationKey", "s3cret", logger);
      expect(lines[0]).toContain("HeartbeatInterval='42'");
      expect(lines[1]).toContain("AuthorizationKey=");
      expect(lines.join("\n")).not.toContain("s3cret");
    });

    it("writes a writable key through the store", () => {
      const s = store();
      expect(writeConfigurationKey(s, false, "HeartbeatInterval", "42")).toBe(
        "Accepted",
      );
      expect(s.getInteger("HeartbeatInterval")).toBe(42);
    });

    it("reports RebootRequired for a reboot-sensitive key", () => {
      expect(
        writeConfigurationKey(store(), false, "SecurityProfile", "1"),
      ).toBe("RebootRequired");
    });

    it("refuses a read-only key and leaves it unchanged", () => {
      const s = store();
      const before = s.get("GetConfigurationMaxKeys")?.value;
      expect(() =>
        writeConfigurationKey(s, false, "GetConfigurationMaxKeys", "1"),
      ).toThrow(ConfigurationWriteRejectedError);
      expect(s.get("GetConfigurationMaxKeys")?.value).toBe(before);
    });

    it("refuses an unknown key", () => {
      expect(() => writeConfigurationKey(store(), false, "Nope", "1")).toThrow(
        UnknownConfigurationKeyError,
      );
    });

    it("refuses a value the key rejects", () => {
      const s = store();
      try {
        writeConfigurationKey(s, false, "HeartbeatInterval", "abc");
        throw new Error("expected a rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigurationWriteRejectedError);
        expect((err as ConfigurationWriteRejectedError).reason).toBe(
          "invalid_value",
        );
      }
    });
  });

  describe("OCPP 2.x", () => {
    it("lists only registered keys, with their Device Model name", () => {
      const { keys, unknown } = readConfigurationKeys(store(), true);
      // Store keys outside the Device Model (GetConfigurationMaxKeys, ...) are
      // left out of a full read, not reported as unknown names.
      expect(unknown).toEqual([]);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) {
        const def = DEVICE_MODEL.byValueKey(k.key);
        expect(def, k.key).toBeDefined();
        expect(k.component).toBe(def?.component);
        expect(k.variable).toBe(def?.variable);
        expect(k.mutability).toBe(def?.mutability);
      }
      expect(keys.find((k) => k.key === "HeartbeatInterval")).toMatchObject({
        component: "OCPPCommCtrlr",
        variable: "HeartbeatInterval",
        mutability: "ReadWrite",
        readonly: false,
      });
    });

    it("treats a store key without a registry entry as unknown", () => {
      const s = store();
      expect(
        DEVICE_MODEL.byValueKey("GetConfigurationMaxKeys"),
      ).toBeUndefined();
      const { keys, unknown } = readConfigurationKeys(s, true, [
        "GetConfigurationMaxKeys",
      ]);
      expect(keys).toEqual([]);
      expect(unknown).toEqual(["GetConfigurationMaxKeys"]);
      expect(() =>
        writeConfigurationKey(s, true, "GetConfigurationMaxKeys", "1"),
      ).toThrow(UnknownConfigurationKeyError);
    });

    it("refuses every ReadOnly registry variable that the store holds", () => {
      const s = store();
      const readOnly = DEVICE_MODEL.variables.filter(
        (v) => v.mutability === "ReadOnly" && s.get(v.valueKey) !== undefined,
      );
      expect(readOnly.length).toBeGreaterThan(0);
      for (const v of readOnly) {
        expect(
          () => writeConfigurationKey(s, true, v.valueKey, "1"),
          v.valueKey,
        ).toThrow(ConfigurationWriteRejectedError);
      }
    });

    it("writes a ReadWrite variable", () => {
      const s = store();
      expect(writeConfigurationKey(s, true, "HeartbeatInterval", "77")).toBe(
        "Accepted",
      );
      expect(s.getInteger("HeartbeatInterval")).toBe(77);
    });
  });

  // #921: 1.6 §9.1.3 and 2.0.1 Part 2 §2.3.4 leave the key R or RW; it is
  // writable so both remote-start behaviours (§5.11, F01) can be exercised.
  it.each([
    ["OCPP 1.6", false],
    ["OCPP 2.x", true],
  ])("%s: lets the operator turn AuthorizeRemoteTxRequests on", (_, is2x) => {
    const s = store();
    expect(
      writeConfigurationKey(s, is2x, "AuthorizeRemoteTxRequests", "true"),
    ).toBe("Accepted");
    expect(s.authorizeRemoteTxRequests()).toBe(true);
    const { keys } = readConfigurationKeys(s, is2x, [
      "AuthorizeRemoteTxRequests",
    ]);
    expect(keys[0]).toMatchObject({ readonly: false, value: "true" });
  });
});
