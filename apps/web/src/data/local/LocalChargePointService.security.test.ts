import { describe, expect, it } from "vitest";

import { DefaultBootNotification } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import { LocalChargePointService } from "./LocalChargePointService";
import {
  BROWSER_TLS_UNSUPPORTED_MESSAGE,
  UnsupportedFeatureError,
} from "@ocpp-cp-simulator/client/interfaces/UnsupportedFeatureError";
import type { LocalChargePointDefinition } from "./LocalChargePointService";

function localDefinition(
  overrides: Partial<LocalChargePointDefinition> = {},
): LocalChargePointDefinition {
  return {
    id: "CP-LOCAL",
    connectorNumber: 1,
    bootNotification: DefaultBootNotification,
    wsUrl: "ws://localhost:9000/ocpp/",
    basicAuth: null,
    autoMeterValueSetting: null,
    ocppVersion: "OCPP-1.6J",
    ...overrides,
  };
}

describe("LocalChargePointService TLS/security-profile gate", () => {
  it("rejects browser/local profile 2 creation with a typed error", async () => {
    const service = new LocalChargePointService();

    await expect(
      service.syncLocalChargePoints([localDefinition({ securityProfile: 2 })]),
    ).rejects.toMatchObject({
      name: "UnsupportedFeatureError",
      code: "browser_tls_unsupported",
      message: BROWSER_TLS_UNSUPPORTED_MESSAGE,
    });
  });

  it("rejects browser/local profile 3 creation with a typed error", async () => {
    const service = new LocalChargePointService();

    await expect(
      service.syncLocalChargePoints([localDefinition({ securityProfile: 3 })]),
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("rejects browser/local TLS certificate material", async () => {
    const service = new LocalChargePointService();

    await expect(
      service.syncLocalChargePoints([
        localDefinition({ tls: { cert: "CERT PEM", key: "KEY PEM" } }),
      ]),
    ).rejects.toMatchObject({ code: "browser_tls_unsupported" });
  });
});
