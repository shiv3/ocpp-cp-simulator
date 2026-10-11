import { afterEach, describe, expect, it } from "vitest";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNode,
} from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { buildSampledValues } from "../../cp/domain/connector/MeterValueBuilder";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../cp/domain/types/OcppTypes";
import { profileFromCatalog } from "../../cp/domain/vehicle/importProfile";
import {
  applyVehicleSettings,
  resolveEvSettings,
} from "../../cp/domain/vehicle/VehicleProfile";
import { OpenEvDirectoryClient } from "../../cp/infrastructure/vehicle-catalog/open-ev-directory/OpenEvDirectoryClient";
import id7Curves from "../../cp/infrastructure/vehicle-catalog/open-ev-directory/__fixtures__/id7GtxChargingCurves.json";
import id7Variant from "../../cp/infrastructure/vehicle-catalog/open-ev-directory/__fixtures__/id7GtxVariant.json";
import { LocalChargePointService } from "./LocalChargePointService";

/**
 * #458 acceptance: "a successful import yields a reusable local profile and
 * can run a scenario after API access is disabled". The connector starts with
 * another vehicle's DC curve and phases, which the scenario's EV settings must
 * replace — the scenario start merges settings (`applyEvSettingsOverride`).
 */

const CP_ID = "CP-OED";
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let service: LocalChargePointService | null = null;

afterEach(async () => {
  await service?.syncLocalChargePoints([]).catch(() => undefined);
  service = null;
});

function node(
  id: string,
  type: ScenarioNodeType,
  data: Record<string, unknown> = {},
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data },
  } as ScenarioNode;
}

describe("a scenario runs on an imported profile with the catalog gone (#458)", () => {
  it("applies the profile's AC values over the previous vehicle and meters them", async () => {
    let catalogUp = true;
    const catalog = new OpenEvDirectoryClient({
      baseUrl: "https://evd.example.test",
      fetch: async (url) => {
        if (!catalogUp) throw new TypeError("network down");
        return Response.json(
          new URL(url).pathname.endsWith("/charging-curves")
            ? id7Curves
            : id7Variant,
        );
      },
    });

    service = new LocalChargePointService(null);
    await service.syncLocalChargePoints([
      {
        id: CP_ID,
        connectorNumber: 1,
        bootNotification: DefaultBootNotification,
        wsUrl: "ws://127.0.0.1:1/ocpp/",
        basicAuth: null,
        autoMeterValueSetting: null,
        ocppVersion: "OCPP-1.6J",
      },
    ]);
    const chargePoint = service.getLocalChargePoint(CP_ID) as ChargePoint;
    const connector = chargePoint.getConnector(1)!;
    // The previous vehicle: a DC car with a tapering curve.
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "DC",
      phases: 1,
      maxChargingPowerKw: 150,
      chargingCurve: [
        { socPercent: 0, powerFraction: 1 },
        { socPercent: 100, powerFraction: 0.1 },
      ],
    };

    // Import and save a profile, then lose the catalog.
    const imported = profileFromCatalog(
      await catalog.getVariant(id7Variant.id),
      { sourceRecordKey: "gaia:volkswagen-id7-gtx-2024", curveId: null },
      { id: "vp_id7", now: "2026-10-11T10:00:00.000Z" },
    );
    if (!imported.ok) throw new Error(imported.reason);
    await service.saveVehicleProfile(imported.profile);
    catalogUp = false;

    const [stored] = await service.listVehicleProfiles();
    const resolved = resolveEvSettings(stored!, "AC");
    if (!resolved.ok) throw new Error(resolved.reason);
    const definition: ScenarioDefinition = {
      id: "s-oed",
      name: "s-oed",
      targetType: "connector",
      targetId: 1,
      nodes: [
        node("start", ScenarioNodeType.START),
        node("set", ScenarioNodeType.STATUS_CHANGE, {
          status: OCPPStatus.Preparing,
        }),
        node("end", ScenarioNodeType.END),
      ],
      edges: [
        { id: "e1", source: "start", target: "set" },
        { id: "e2", source: "set", target: "end" },
      ],
      createdAt: "2026-10-11T10:00:00.000Z",
      updatedAt: "2026-10-11T10:00:00.000Z",
      defaultExecutionMode: "oneshot",
      enabled: true,
      trigger: { type: "manual" },
      evSettings: applyVehicleSettings({}, resolved.settings),
    };

    chargePoint.status = OCPPStatus.Available;
    const { scenarioId } = await service.loadScenario(CP_ID, 1, definition);
    await service.runScenario(CP_ID, 1, scenarioId);
    await settle();

    expect(connector.status).toBe(OCPPStatus.Preparing);
    expect(connector.evSettings).toMatchObject({
      modelName: "Volkswagen ID.7 GTX",
      batteryCapacityKwh: 86,
      maxChargingPowerKw: 11,
      currentType: "AC",
      phases: 3,
      chargingCurve: [],
    });

    // A MeterValues sample of a session on it: 11 kW, the previous curve gone.
    connector.socMeterSyncEnabled = false;
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction({
      id: 458,
      connectorId: 1,
      tagId: "TAG-OED",
      meterStart: 0,
      meterStop: null,
      startTime: new Date("2026-10-11T10:00:00.000Z"),
      stopTime: null,
      meterSent: false,
    });
    connector.soc = 90;
    const power = buildSampledValues(
      connector,
      ["Power.Active.Import"],
      "Sample.Periodic",
    ).find((s) => s.measurand === "Power.Active.Import")?.value;
    expect(Number(power)).toBe(11_000);

    // The stored profile is unchanged and nothing needed the catalog.
    expect((await service.listVehicleProfiles())[0]).toEqual(imported.profile);
  });
});
