import { describe, expect, it } from "vitest";

import type { Config } from "../../store/store";
import { LocalChargePointService } from "./LocalChargePointService";

function config(overrides: Partial<Config> = {}): Config {
  return {
    wsURL: "ws://example.test/ocpp",
    ChargePointID: "cp-local",
    connectorNumber: 1,
    tagID: "TAG-1",
    ocppVersion: "OCPP-1.6J",
    basicAuthSettings: {
      enabled: true,
      username: "local-user",
      password: "local-secret",
    },
    autoMeterValueSetting: {
      enabled: false,
      interval: 30,
      value: 10,
    },
    Experimental: {
      ChargePointIDs: [{ ChargePointID: "cp-local", ConnectorNumber: 1 }],
      TagIDs: ["TAG-1"],
    },
    BootNotification: {
      chargePointVendor: "Vendor",
      chargePointModel: "Model",
      firmwareVersion: "1.0",
    },
    ...overrides,
  };
}

describe("LocalChargePointService config persistence", () => {
  it("round-trips loadConfig/saveConfig through ConfigRepository", async () => {
    const service = new LocalChargePointService();
    const saved = config();

    await service.saveConfig(saved);

    await expect(service.loadConfig()).resolves.toEqual(saved);
  });
});
