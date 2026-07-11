import { describe, expect, it } from "vitest";

import { DefaultBootNotification } from "../../../cp/domain/types/OcppTypes";
import { LocalChargePointService } from "../LocalChargePointService";

describe("LocalChargePointService SOAP support", () => {
  it("accepts OCPP 1.5 SOAP in browser/local mode (send-only)", async () => {
    const service = new LocalChargePointService();

    const result = service.syncLocalChargePoints([
      {
        id: "CP-SOAP",
        connectorNumber: 1,
        bootNotification: DefaultBootNotification,
        wsUrl: "http://127.0.0.1:8180/steve/services/CentralSystemService",
        basicAuth: null,
        autoMeterValueSetting: null,
        ocppVersion: "OCPP-1.5",
      },
    ]);

    // Should not throw; SOAP versions are now supported in local mode
    await expect(result).resolves.toBeDefined();
    const cps = await result;
    expect(cps).toHaveLength(1);
    expect(cps[0].id).toBe("CP-SOAP");
  });

  it("accepts OCPP 1.2 SOAP in browser/local mode (send-only)", async () => {
    const service = new LocalChargePointService();

    const result = service.syncLocalChargePoints([
      {
        id: "CP-1.2",
        connectorNumber: 1,
        bootNotification: DefaultBootNotification,
        wsUrl: "http://127.0.0.1:8180/steve/services/CentralSystemService",
        basicAuth: null,
        autoMeterValueSetting: null,
        ocppVersion: "OCPP-1.2",
      },
    ]);

    // Should not throw; SOAP versions are now supported in local mode
    await expect(result).resolves.toBeDefined();
    const cps = await result;
    expect(cps).toHaveLength(1);
    expect(cps[0].id).toBe("CP-1.2");
  });

  it("accepts OCPP 1.6S SOAP in browser/local mode (send-only)", async () => {
    const service = new LocalChargePointService();

    const result = service.syncLocalChargePoints([
      {
        id: "CP-1.6S",
        connectorNumber: 1,
        bootNotification: DefaultBootNotification,
        wsUrl: "http://127.0.0.1:8180/steve/services/CentralSystemService",
        basicAuth: null,
        autoMeterValueSetting: null,
        ocppVersion: "OCPP-1.6S",
      },
    ]);

    // Should not throw; SOAP versions are now supported in local mode
    await expect(result).resolves.toBeDefined();
    const cps = await result;
    expect(cps).toHaveLength(1);
    expect(cps[0].id).toBe("CP-1.6S");
  });
});
