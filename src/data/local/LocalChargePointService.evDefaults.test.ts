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

  it("keeps a scenario/explicit override across a default propagation, and applies the default again once cleared (#105)", async () => {
    service = new LocalChargePointService();
    await service.syncLocalChargePoints([
      localDefinition({ connectorNumber: 1 }),
    ]);

    const chargePoint = service.getLocalChargePoint("CP-EV");
    const connector = chargePoint?.getConnector(1);
    expect(connector).toBeDefined();

    connector?.applyEvSettingsOverride({ targetSoc: 50 });

    await service.applyDefaultEVSettings({
      ...defaultEVSettings,
      targetSoc: 80,
    });

    // A browser reload re-pushing the default (#107) must not stomp the
    // active override (#105) — the target SoC set via the scenario/explicit
    // override stays at 50.
    await expect(service.getEVSettings("CP-EV", 1)).resolves.toMatchObject({
      targetSoc: 50,
    });

    connector?.clearEvSettingsOverride();

    await service.applyDefaultEVSettings({
      ...defaultEVSettings,
      targetSoc: 80,
    });

    // Once the override clears (e.g. the scenario stopped), the next
    // default propagation is free to apply.
    await expect(service.getEVSettings("CP-EV", 1)).resolves.toMatchObject({
      targetSoc: 80,
    });
  });
});
