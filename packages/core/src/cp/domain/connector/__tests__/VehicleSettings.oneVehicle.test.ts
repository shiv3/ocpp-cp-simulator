import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Logger, LogLevel } from "../../../shared/Logger";
import { autoTrafficVehiclePatch } from "../AutoTraffic";
import { Connector } from "../Connector";
import { vehicleTermOf } from "../OperatingPoint";
import type { VehicleSettings } from "../VehicleSettings";
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

  const AC_A: VehicleEvSettings = {
    modelName: "AC car",
    batteryCapacityKwh: 40,
    maxChargingPowerKw: 11,
    chargingCurve: [],
    currentType: "AC",
    phases: 3,
    attribution: [
      {
        text: "A",
        licenseName: "CC-BY-4.0",
        licenseUrl: "u",
        shareAlike: false,
      },
    ],
  };
  const DC_B: VehicleEvSettings = { ...PROFILE_RESOLVED, attribution: [] };
  const DC_C: VehicleEvSettings = {
    modelName: "Bare",
    batteryCapacityKwh: 30,
    maxChargingPowerKw: 50,
    chargingCurve: [],
    currentType: "DC",
    attribution: [],
  };
  const VEHICLES = [AC_A, DC_B, DC_C];

  // The invariant behind "one writer": whichever vehicles were applied before,
  // the connector ends up exactly as if the last one had been applied to a
  // fresh connector, through either entry point.
  it.each([
    [
      "profile apply",
      (c: Connector, v: VehicleEvSettings) => {
        c.evSettings = applyVehicleSettings(c.evSettings, v);
      },
    ],
    [
      "pool patch",
      (c: Connector, v: VehicleEvSettings) => {
        c.applyEvSettingsOverride(
          autoTrafficVehiclePatch({ weight: 1, vehicle: v }),
        );
      },
    ],
  ])(
    "%s: any sequence equals the last vehicle on a fresh connector",
    (_n, apply) => {
      for (const first of VEHICLES) {
        for (const second of VEHICLES) {
          for (const last of VEHICLES) {
            const seq = connector();
            apply(seq, first);
            apply(seq, second);
            apply(seq, last);
            const fresh = connector();
            apply(fresh, last);
            expect(seq.evSettings).toEqual(fresh.evSettings);
            expect(vehicleTermOf(seq.evSettings)).toEqual(
              vehicleTermOf(fresh.evSettings),
            );
          }
        }
      }
    },
  );

  it("both entry points leave the same settings for the same vehicle sequence", () => {
    for (const first of VEHICLES) {
      for (const last of VEHICLES) {
        const viaProfile = connector();
        viaProfile.evSettings = applyVehicleSettings(
          viaProfile.evSettings,
          first,
        );
        viaProfile.evSettings = applyVehicleSettings(
          viaProfile.evSettings,
          last,
        );
        const viaPool = connector();
        for (const v of [first, last]) {
          viaPool.applyEvSettingsOverride(
            autoTrafficVehiclePatch({ weight: 1, vehicle: v }),
          );
        }
        expect(viaProfile.evSettings).toEqual(viaPool.evSettings);
      }
    }
  });

  it("a DC profile applied after an AC one keeps nothing of the AC vehicle (regression)", () => {
    const c = connector();
    c.evSettings = applyVehicleSettings(c.evSettings, AC_A);
    expect(c.evSettings.phases).toBe(3);
    c.evSettings = applyVehicleSettings(c.evSettings, DC_C);
    expect(c.evSettings.phases).toBeUndefined();
    expect(c.evSettings.attribution ?? []).toEqual([]);
    expect(c.evSettings.modelName).toBe("Bare");
    expect(c.evSettings.currentType).toBe("DC");
    expect(c.evSettings.chargingCurve ?? []).toEqual([]);
    // The plain result carries no stale phases either (the web console form).
    expect(applyVehicleSettings({ phases: 3 }, DC_C).phases).toBeUndefined();
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
