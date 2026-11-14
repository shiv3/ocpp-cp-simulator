import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Logger, LogLevel } from "../../../shared/Logger";
import { autoTrafficVehiclePatch } from "../AutoTraffic";
import { Connector } from "../Connector";
import { vehicleTermOf } from "../OperatingPoint";
import { vehicleSettingsPatch, type VehicleSettings } from "../VehicleSettings";
import {
  applyVehicleSettings,
  type VehicleEvSettings,
} from "../../vehicle/VehicleProfile";

/**
 * #327 step 3: the vehicle is one object. A vehicle profile, the auto-traffic
 * pool and the meter model all go through the connector's EV settings, so the
 * traffic generator and the operating point cannot be given two vehicles.
 */

const CURVE = [
  { socPercent: 0, powerFraction: 1 },
  { socPercent: 100, powerFraction: 0.2 },
];

const PROFILE_RESOLVED: VehicleEvSettings = {
  modelName: "ID.7 GTX",
  batteryCapacityKwh: 77,
  maxChargingPowerKw: 175,
  chargingCurve: CURVE,
  currentType: "DC",
  attribution: [],
};

function connector(): Connector {
  return new Connector(1, new Logger(LogLevel.ERROR));
}

describe("one vehicle for the traffic generator and the meter model (#327)", () => {
  it("a resolved profile is a VehicleSettings (one definition of the slice)", () => {
    // Compile-time: the strict profile form is assignable to the shared slice.
    const asSlice: VehicleSettings = PROFILE_RESOLVED;
    expect(asSlice.modelName).toBe("ID.7 GTX");
  });

  it("the pool's patch and the profile's apply give the operating point the same vehicle term", () => {
    const viaProfile = connector();
    viaProfile.evSettings = applyVehicleSettings(
      viaProfile.evSettings,
      PROFILE_RESOLVED,
    );

    const viaTraffic = connector();
    viaTraffic.applyEvSettingsOverride(
      autoTrafficVehiclePatch({ weight: 1, vehicle: PROFILE_RESOLVED }),
    );

    expect(vehicleTermOf(viaTraffic.evSettings)).toEqual(
      vehicleTermOf(viaProfile.evSettings),
    );
    expect(viaTraffic.evSettings.batteryCapacityKwh).toBe(77);
  });

  it("the pool vehicle replaces the previous vehicle whole", () => {
    const c = connector();
    c.applyEvSettingsOverride(
      autoTrafficVehiclePatch({ weight: 1, vehicle: PROFILE_RESOLVED }),
    );
    c.applyEvSettingsOverride(
      autoTrafficVehiclePatch({
        weight: 1,
        vehicle: {
          modelName: "Small",
          batteryCapacityKwh: 30,
          maxChargingPowerKw: 11,
        },
      }),
    );
    const term = vehicleTermOf(c.evSettings);
    expect(term.maxW).toBe(11_000);
    expect(term.curve ?? []).toEqual([]);
    expect(c.evSettings.currentType).toBeUndefined();
  });

  it("auto-traffic's patch is the shared one (no second writer of the slice)", () => {
    const vehicle: VehicleSettings = PROFILE_RESOLVED;
    expect(autoTrafficVehiclePatch({ weight: 2, vehicle })).toEqual(
      vehicleSettingsPatch(vehicle),
    );
    const dir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(dir, "..", "AutoTraffic.ts"), "utf8");
    expect(source).not.toMatch(/batteryCapacityKwh:\s*v\./);
    expect(source).toContain("vehicleSettingsPatch(");
  });

  it("VehicleSettings.ts is protocol-agnostic", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(dir, "..", "VehicleSettings.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/infrastructure\/transport|\/ocpp\//);
    }
  });
});
