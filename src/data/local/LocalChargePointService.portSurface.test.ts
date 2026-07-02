import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScenarioManager } from "../../cp/application/scenario/ScenarioManager";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import { DefaultBootNotification } from "../../cp/domain/types/OcppTypes";
import { UnsupportedFeatureError } from "../interfaces/UnsupportedFeatureError";
import { LocalChargePointService } from "./LocalChargePointService";
import type { LocalChargePointDefinition } from "./LocalChargePointService";

function localDefinition(
  overrides: Partial<LocalChargePointDefinition> = {},
): LocalChargePointDefinition {
  return {
    id: "CP-PORT",
    connectorNumber: 1,
    bootNotification: DefaultBootNotification,
    wsUrl: "ws://localhost:9000/ocpp/",
    basicAuth: null,
    autoMeterValueSetting: null,
    ocppVersion: "OCPP-1.6J",
    ...overrides,
  };
}

async function serviceWithChargePoint(): Promise<{
  service: LocalChargePointService;
  chargePoint: ChargePoint;
}> {
  const service = new LocalChargePointService();
  await service.syncLocalChargePoints([localDefinition()]);
  const chargePoint = service.getLocalChargePoint("CP-PORT") as ChargePoint;
  return { service, chargePoint };
}

let service: LocalChargePointService | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await service?.syncLocalChargePoints([]).catch(() => undefined);
  service = null;
});

describe("LocalChargePointService A1.1d port methods", () => {
  it("sends DiagnosticsStatusNotification through the local charge point", async () => {
    const setup = await serviceWithChargePoint();
    service = setup.service;
    const spy = vi
      .spyOn(setup.chargePoint, "sendDiagnosticsStatusNotification")
      .mockImplementation(() => undefined);

    await service.sendDiagnosticsStatusNotification("CP-PORT", "Uploading");

    expect(spy).toHaveBeenCalledWith("Uploading");
  });

  it("sends FirmwareStatusNotification through the local charge point", async () => {
    const setup = await serviceWithChargePoint();
    service = setup.service;
    const spy = vi
      .spyOn(setup.chargePoint, "sendFirmwareStatusNotification")
      .mockImplementation(() => undefined);

    await service.sendFirmwareStatusNotification("CP-PORT", "Downloaded");

    expect(spy).toHaveBeenCalledWith("Downloaded");
  });

  it("sends SecurityEventNotification through the local charge point", async () => {
    const setup = await serviceWithChargePoint();
    service = setup.service;
    const spy = vi
      .spyOn(setup.chargePoint, "sendSecurityEventNotification")
      .mockImplementation(() => undefined);

    await service.sendSecurityEventNotification(
      "CP-PORT",
      "SettingSystemTime",
      "clock adjusted",
    );

    expect(spy).toHaveBeenCalledWith("SettingSystemTime", "clock adjusted");
  });

  it("sends SignCertificate through the local charge point", async () => {
    const setup = await serviceWithChargePoint();
    service = setup.service;
    const spy = vi
      .spyOn(setup.chargePoint, "sendSignCertificate")
      .mockResolvedValue(undefined);

    await service.sendSignCertificate("CP-PORT", "-----BEGIN CSR-----");

    expect(spy).toHaveBeenCalledWith("-----BEGIN CSR-----");
  });

  it("reads EV settings from the local connector snapshot source", async () => {
    const setup = await serviceWithChargePoint();
    service = setup.service;
    const settings: EVSettings = {
      modelName: "Test EV",
      batteryCapacityKwh: 64,
      maxChargingPowerKw: 90,
      initialSoc: 12,
      targetSoc: 88,
    };

    await service.setEVSettings("CP-PORT", 1, settings);

    await expect(service.getEVSettings("CP-PORT", 1)).resolves.toEqual(
      settings,
    );
  });

  it("reads auto-meter config from the local connector snapshot source", async () => {
    const setup = await serviceWithChargePoint();
    service = setup.service;
    const config: AutoMeterValueConfig = {
      enabled: true,
      curvePoints: [
        { time: 0, value: 0 },
        { time: 300, value: 7 },
      ],
      intervalSeconds: 10,
      autoCalculateInterval: false,
    };

    await service.setAutoMeterValueConfig("CP-PORT", 1, config);

    await expect(
      service.getAutoMeterValueConfig("CP-PORT", 1),
    ).resolves.toEqual(config);
  });

  it("rejects browser-local runScenarioFile with UnsupportedFeatureError", async () => {
    const setup = await serviceWithChargePoint();
    service = setup.service;

    await expect(
      service.runScenarioFile("CP-PORT", "/tmp/scenario.json", {
        connectorId: 1,
      }),
    ).rejects.toMatchObject({
      name: "UnsupportedFeatureError",
      code: "browser_scenario_file_unsupported",
    });
  });

  it("runs a browser-local scenario template through the connector executor", async () => {
    const setup = await serviceWithChargePoint();
    service = setup.service;
    const connector = setup.chargePoint.getConnector(1);
    expect(connector).toBeDefined();

    const loaded: ScenarioDefinition[][] = [];
    const manager = {
      loadScenarios: vi.fn((definitions: ScenarioDefinition[]) => {
        loaded.push(definitions);
      }),
      executeScenario: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    } as unknown as ScenarioManager;
    connector?.setScenarioManager(manager);

    const result = await service.runScenarioTemplate(
      "CP-PORT",
      "essential-cp-behavior",
      { connectorId: 1, evSettings: { maxChargingPowerKw: 3 } },
    );

    expect(result.scenarioId).toBeTruthy();
    expect(loaded[0][0]).toMatchObject({
      id: result.scenarioId,
      targetId: 1,
      evSettings: expect.objectContaining({ maxChargingPowerKw: 3 }),
    });
    expect(manager.executeScenario).toHaveBeenCalledWith(result.scenarioId);
  });

  it("rejects runScenarioTemplate when the browser executor is unavailable", async () => {
    const setup = await serviceWithChargePoint();
    service = setup.service;

    await expect(
      service.runScenarioTemplate("CP-PORT", "essential-cp-behavior", {
        connectorId: 1,
      }),
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
});
