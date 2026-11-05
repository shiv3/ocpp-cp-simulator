import { describe, expect, it } from "vitest";

import { Connector } from "../../connector/Connector";
import type { ActiveChargingProfile } from "../../connector/Connector";
import { buildSampledValues } from "../../connector/MeterValueBuilder";
import type { Transaction } from "../../connector/Transaction";
import { VehicleProfileRepository } from "../../persistence/VehicleProfileRepository";
import { Logger, LogLevel } from "../../../shared/Logger";
import {
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
  OCPPStatus,
} from "../../types/OcppTypes";
import { OpenEvDirectoryClient } from "../../../infrastructure/vehicle-catalog/open-ev-directory/OpenEvDirectoryClient";
import id7Curves from "../../../infrastructure/vehicle-catalog/open-ev-directory/__fixtures__/id7GtxChargingCurves.json";
import id7Variant from "../../../infrastructure/vehicle-catalog/open-ev-directory/__fixtures__/id7GtxVariant.json";
import { profileFromCatalog } from "../importProfile";
import { applyVehicleSettings, resolveEvSettings } from "../VehicleProfile";

/**
 * #458 acceptance: an imported profile is a local copy. Once saved, the
 * catalog can be gone — every call failing — and a connector given the
 * profile still charges along its curve, under the CSMS's limits.
 */

const GAIA = "gaia:volkswagen-id7-gtx-2024";

function transaction(): Transaction {
  return {
    id: 458,
    connectorId: 1,
    tagId: "TAG-OED",
    meterStart: 0,
    meterStop: null,
    startTime: new Date("2026-10-11T00:00:00.000Z"),
    stopTime: null,
    meterSent: false,
  };
}

function wattLimit(limitWatts: number): ActiveChargingProfile {
  return {
    chargingProfileId: 458,
    connectorId: 1,
    stackLevel: 0,
    chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
    chargingProfileKind: ChargingProfileKindType.Relative,
    chargingRateUnit: ChargingRateUnitType.W,
    chargingSchedulePeriods: [{ startPeriod: 0, limit: limitWatts }],
  };
}

function reportedPowerW(connector: Connector): number {
  return Number(
    buildSampledValues(
      connector,
      ["Power.Active.Import"],
      "Sample.Periodic",
    ).find((s) => s.measurand === "Power.Active.Import")?.value ?? "NaN",
  );
}

describe("an imported vehicle profile works offline (#458)", () => {
  it("charges a connector along the imported curve after the catalog is gone", async () => {
    let catalogUp = true;
    let calls = 0;
    const client = new OpenEvDirectoryClient({
      baseUrl: "https://evd.example.test",
      fetch: async (url) => {
        calls++;
        if (!catalogUp) throw new TypeError("network down");
        const body = new URL(url).pathname.endsWith("/charging-curves")
          ? id7Curves
          : id7Variant;
        return Response.json(body);
      },
    });

    // Import and save.
    const variant = await client.getVariant(id7Variant.id);
    const imported = profileFromCatalog(
      variant,
      { sourceRecordKey: GAIA, curveId: "crv_2523855ffac08d0a" },
      { id: "vp_id7", now: "2026-10-11T10:00:00.000Z" },
    );
    if (!imported.ok) throw new Error(imported.reason);
    const repository = new VehicleProfileRepository(null);
    repository.save(imported.profile);

    // The catalog is gone from here on.
    catalogUp = false;
    await expect(client.getVariant(id7Variant.id)).rejects.toMatchObject({
      kind: "network",
    });
    const callsAfterOutage = calls;

    const stored = repository.get("vp_id7")!;
    expect(stored).toEqual(imported.profile);
    const resolved = resolveEvSettings(stored, "DC");
    if (!resolved.ok) throw new Error(resolved.reason);

    const connector = new Connector(1, new Logger(LogLevel.ERROR));
    connector.evSettings = applyVehicleSettings(
      connector.evSettings,
      resolved.settings,
    );
    connector.socMeterSyncEnabled = false;
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction());

    // The Gaia ID.7 curve: 200 kW up to 20 %, 140 kW at 50 %, 40 kW at 90 %.
    connector.soc = 10;
    expect(reportedPowerW(connector)).toBe(200_000);
    connector.soc = 50;
    expect(reportedPowerW(connector)).toBe(140_000);
    connector.soc = 95;
    expect(reportedPowerW(connector)).toBe(40_000);

    // The CSMS's limit still wins over the vehicle's curve.
    connector.soc = 10;
    connector.addChargingProfile(wattLimit(50_000));
    expect(reportedPowerW(connector)).toBe(50_000);

    // Nothing above reached the catalog, and the stored profile is unchanged.
    expect(calls).toBe(callsAfterOutage);
    expect(repository.get("vp_id7")).toEqual(imported.profile);
  });
});
