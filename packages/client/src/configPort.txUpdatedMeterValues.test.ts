import { describe, expect, it } from "vitest";
import type { SimulatorConfigInput } from "@ocpp-cp-simulator/contracts/index";
import { mergeWriteOnlyConfigSecrets } from "./configPort";

function input(
  extra: Partial<SimulatorConfigInput> = {},
): SimulatorConfigInput {
  return {
    wsURL: "ws://localhost:9000/",
    ChargePointID: "CP-1",
    connectorNumber: 1,
    tagID: "TAG",
    ocppVersion: "OCPP-2.0.1",
    basicAuthSettings: { enabled: false, username: "" },
    autoMeterValueSetting: { enabled: false, interval: 30, value: 10 },
    Experimental: null,
    BootNotification: null,
    ...extra,
  };
}

describe("mergeWriteOnlyConfigSecrets txUpdatedMeterValues (#550)", () => {
  it("keeps the option when the config carries it, true or false", () => {
    for (const value of [true, false]) {
      const merged = mergeWriteOnlyConfigSecrets(
        input({ txUpdatedMeterValues: value }),
        null,
      );
      expect(merged?.txUpdatedMeterValues).toBe(value);
    }
  });

  it("leaves the key out when the config does not carry it", () => {
    const merged = mergeWriteOnlyConfigSecrets(input(), null);
    expect(merged).not.toHaveProperty("txUpdatedMeterValues");
  });
});
