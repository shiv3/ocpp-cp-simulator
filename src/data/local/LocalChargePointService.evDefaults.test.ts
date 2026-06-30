import { afterEach, describe, expect, it } from "vitest";

import { DefaultBootNotification } from "../../cp/domain/types/OcppTypes";
import { LocalChargePointService } from "./LocalChargePointService";
import type { LocalChargePointDefinition } from "./LocalChargePointService";
import {
  defaultEVSettings,
  type EVSettings,
} from "../../cp/domain/connector/EVSettings";

function localDefinition(
  overrides: Partial<LocalChargePointDefinition> = {},
): LocalChargePointDefinition {
  return {
    id: "CP-EV",
    connectorNumber: 2,
    bootNotification: DefaultBootNotification,
    wsUrl: "ws://localhost:9000/ocpp/",
    basicAuth: null,
    autoMeterValueSetting: null,
    ocppVersion: "OCPP-1.6J",
    ...overrides,
  };
}

let service: LocalChargePointService | null = null;

afterEach(async () => {
  // Remove the CP (disconnects it + clears its reconnect timers).
  await service?.syncLocalChargePoints([]).catch(() => undefined);
  service = null;
});

describe("LocalChargePointService.applyDefaultEVSettings (#107)", () => {
  it("pushes the new default onto every existing connector", async () => {
    service = new LocalChargePointService();
    await service.syncLocalChargePoints([
      localDefinition({ connectorNumber: 2 }),
    ]);

    const next: EVSettings = {
      modelName: "Nissan Leaf (40kWh)",
      batteryCapacityKwh: 40,
      maxChargingPowerKw: 50,
      initialSoc: 10,
      targetSoc: 30,
    };
    await service.applyDefaultEVSettings(next);

    const snapshot = await service.getChargePoint("CP-EV");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.connectors.length).toBe(2);
    for (const connector of snapshot?.connectors ?? []) {
      expect(connector.evSettings?.targetSoc).toBe(30);
      expect(connector.evSettings?.batteryCapacityKwh).toBe(40);
      expect(connector.evSettings?.initialSoc).toBe(10);
    }
  });

  it("pushes the built-in default onto connectors after default settings reset", async () => {
    service = new LocalChargePointService();
    await service.syncLocalChargePoints([
      localDefinition({ connectorNumber: 2 }),
    ]);

    await service.applyDefaultEVSettings({
      modelName: "Nissan Leaf (40kWh)",
      batteryCapacityKwh: 40,
      maxChargingPowerKw: 50,
      initialSoc: 10,
      targetSoc: 30,
    });
    await service.applyDefaultEVSettings(defaultEVSettings);

    const snapshot = await service.getChargePoint("CP-EV");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.connectors.length).toBe(2);
    for (const connector of snapshot?.connectors ?? []) {
      expect(connector.evSettings?.modelName).toBe(defaultEVSettings.modelName);
      expect(connector.evSettings?.targetSoc).toBe(defaultEVSettings.targetSoc);
      expect(connector.evSettings?.batteryCapacityKwh).toBe(
        defaultEVSettings.batteryCapacityKwh,
      );
      expect(connector.evSettings?.initialSoc).toBe(
        defaultEVSettings.initialSoc,
      );
    }
  });
});
