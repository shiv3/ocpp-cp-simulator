import { describe, expect, it } from "vitest";

import { normalizeChargingCurve } from "../../connector/ChargingCurve";
import type { EVSettings } from "../../connector/EVSettings";
import {
  applyVehicleSettings,
  availableCurrentTypes,
  effectiveSpecs,
  missingFields,
  resolveEvSettings,
  type VehicleProfile,
} from "../VehicleProfile";

// The Gaia ID.7 GTX curve from the Open EV Directory contract examples.
const ID7_CURVE = [
  { socPercent: 0, powerKw: 200 },
  { socPercent: 10, powerKw: 200 },
  { socPercent: 20, powerKw: 200 },
  { socPercent: 30, powerKw: 185 },
  { socPercent: 40, powerKw: 165 },
  { socPercent: 50, powerKw: 140 },
  { socPercent: 60, powerKw: 110 },
  { socPercent: 70, powerKw: 80 },
  { socPercent: 80, powerKw: 55 },
  { socPercent: 90, powerKw: 40 },
];

function profile(overrides: Partial<VehicleProfile> = {}): VehicleProfile {
  return {
    id: "vp_1",
    name: "Volkswagen ID.7 GTX",
    specs: {
      usableBatteryKwh: 86,
      acMaxKw: 11,
      acPhases: 3,
      dcMaxKw: 200,
      acConnectors: ["IEC_62196_T2"],
      dcConnectors: ["IEC_62196_T2_COMBO"],
    },
    dcCurve: ID7_CURVE,
    overrides: {},
    origin: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("effectiveSpecs (#458)", () => {
  it("applies local overrides over the imported specs", () => {
    const p = profile({ overrides: { usableBatteryKwh: 77, acPhases: 1 } });
    expect(effectiveSpecs(p)).toMatchObject({
      usableBatteryKwh: 77,
      acPhases: 1,
      acMaxKw: 11,
      dcMaxKw: 200,
    });
  });

  it("fills a missing imported value from an override", () => {
    const p = profile({
      specs: { ...profile().specs, usableBatteryKwh: null },
      overrides: { usableBatteryKwh: 60 },
    });
    expect(effectiveSpecs(p).usableBatteryKwh).toBe(60);
  });
});

describe("missingFields (#458)", () => {
  it("names the capacity when the source gives none", () => {
    const p = profile({
      specs: { ...profile().specs, usableBatteryKwh: null },
    });
    expect(missingFields(p, "DC")).toEqual(["usableBatteryKwh"]);
    expect(missingFields(p, "AC")).toEqual(["usableBatteryKwh"]);
  });

  it("accepts a DC curve in place of a missing DC maximum", () => {
    const p = profile({ specs: { ...profile().specs, dcMaxKw: null } });
    expect(missingFields(p, "DC")).toEqual([]);
  });

  it("needs a DC maximum when there is no curve either", () => {
    const p = profile({
      specs: { ...profile().specs, dcMaxKw: null },
      dcCurve: null,
    });
    expect(missingFields(p, "DC")).toEqual(["dcMaxKw"]);
  });

  it("needs an AC maximum for AC", () => {
    const p = profile({ specs: { ...profile().specs, acMaxKw: null } });
    expect(missingFields(p, "AC")).toEqual(["acMaxKw"]);
  });
});

describe("availableCurrentTypes (#458)", () => {
  it("lists the current types that can be resolved", () => {
    expect(availableCurrentTypes(profile())).toEqual(["AC", "DC"]);
    expect(
      availableCurrentTypes(
        profile({ specs: { ...profile().specs, acMaxKw: null } }),
      ),
    ).toEqual(["DC"]);
  });
});

describe("resolveEvSettings — DC (#458)", () => {
  it("turns the kW curve into fractions of the DC maximum", () => {
    const result = resolveEvSettings(profile(), "DC");
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings).toMatchObject({
      modelName: "Volkswagen ID.7 GTX",
      batteryCapacityKwh: 86,
      maxChargingPowerKw: 200,
      currentType: "DC",
    });
    expect(result.settings.phases).toBeUndefined();
    expect(result.settings.chargingCurve).toHaveLength(10);
    expect(result.settings.chargingCurve![0]).toEqual({
      socPercent: 0,
      powerFraction: 1,
    });
    expect(result.settings.chargingCurve![9]).toEqual({
      socPercent: 90,
      powerFraction: 0.2,
    });
  });

  it("never drops a point above the declared DC maximum and says so", () => {
    const p = profile({
      specs: { ...profile().specs, dcMaxKw: 150 },
    });
    const result = resolveEvSettings(p, "DC");
    if (!result.ok) throw new Error("expected ok");
    // The denominator is the curve peak, so every fraction stays in [0, 1]
    // and the domain normalizer keeps every point.
    expect(result.settings.maxChargingPowerKw).toBe(200);
    expect(normalizeChargingCurve(result.settings.chargingCurve)).toHaveLength(
      10,
    );
    expect(result.warnings).toContainEqual({
      code: "POWER_ABOVE_DC_MAX",
      dcMaxKw: 150,
      peakKw: 200,
    });
  });

  it("warns that the edges of a partial curve are held", () => {
    const result = resolveEvSettings(
      profile({
        dcCurve: [
          { socPercent: 10, powerKw: 100 },
          { socPercent: 80, powerKw: 50 },
        ],
      }),
      "DC",
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.warnings).toContainEqual({
      code: "CURVE_STARTS_ABOVE_ZERO_SOC",
      firstSocPercent: 10,
    });
    expect(result.warnings).toContainEqual({
      code: "CURVE_ENDS_BELOW_FULL_SOC",
      lastSocPercent: 80,
    });
  });

  it("charges flat at the DC maximum without a curve, and says so", () => {
    const result = resolveEvSettings(profile({ dcCurve: null }), "DC");
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.chargingCurve).toEqual([]);
    expect(result.settings.maxChargingPowerKw).toBe(200);
    expect(result.warnings).toContainEqual({ code: "NO_DC_CURVE" });
  });

  it("refuses a missing capacity instead of defaulting it", () => {
    const result = resolveEvSettings(
      profile({ specs: { ...profile().specs, usableBatteryKwh: null } }),
      "DC",
    );
    expect(result).toEqual({
      ok: false,
      reason: "missing_fields",
      missing: ["usableBatteryKwh"],
    });
  });

  it("refuses a curve it cannot use rather than dropping points", () => {
    const result = resolveEvSettings(
      profile({
        dcCurve: [
          { socPercent: 0, powerKw: 100 },
          { socPercent: 120, powerKw: 50 },
        ],
      }),
      "DC",
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid_curve" });
  });

  it("caps the curve at a DC maximum the user lowered", () => {
    // The ID.7 curve peaks at 200 kW; the user says this car takes 100 kW.
    const result = resolveEvSettings(
      profile({ overrides: { dcMaxKw: 100 } }),
      "DC",
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.maxChargingPowerKw).toBe(100);
    const curve = result.settings.chargingCurve;
    expect(curve).toHaveLength(10);
    // 200, 185, 165, 140, 110 kW are all held at the 100 kW the user set;
    // 80, 55 and 40 kW keep their shape below it.
    expect(curve.map((p) => p.powerFraction)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 0.8, 0.55, 0.4,
    ]);
    expect(result.warnings).toContainEqual({
      code: "CURVE_CAPPED_AT_DC_MAX",
      dcMaxKw: 100,
      peakKw: 200,
    });
    expect(result.warnings.some((w) => w.code === "POWER_ABOVE_DC_MAX")).toBe(
      false,
    );
  });

  it("uses overrides over imported values", () => {
    const result = resolveEvSettings(
      profile({ overrides: { usableBatteryKwh: 80, dcMaxKw: 250 } }),
      "DC",
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.batteryCapacityKwh).toBe(80);
    expect(result.settings.maxChargingPowerKw).toBe(250);
    expect(result.settings.chargingCurve![0]!.powerFraction).toBe(0.8);
  });
});

describe("resolveEvSettings — AC (#458)", () => {
  it("uses the AC maximum and the phase count, without a curve", () => {
    const result = resolveEvSettings(profile(), "AC");
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings).toEqual({
      modelName: "Volkswagen ID.7 GTX",
      batteryCapacityKwh: 86,
      maxChargingPowerKw: 11,
      currentType: "AC",
      chargingCurve: [],
      phases: 3,
      attribution: [],
    });
    expect(result.warnings).toEqual([]);
  });

  it("charges an unsupported phase count on one phase and says so", () => {
    const result = resolveEvSettings(
      profile({ specs: { ...profile().specs, acPhases: 2 } }),
      "AC",
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.phases).toBe(1);
    expect(result.warnings).toContainEqual({
      code: "UNSUPPORTED_AC_PHASES",
      acPhases: 2,
    });
  });

  it("charges an unknown phase count on one phase and says so", () => {
    const result = resolveEvSettings(
      profile({ specs: { ...profile().specs, acPhases: null } }),
      "AC",
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.phases).toBe(1);
    expect(result.warnings).toContainEqual({ code: "AC_PHASES_UNKNOWN" });
  });
});

describe("resolveEvSettings — attribution (#458)", () => {
  const GAIA = {
    id: "CC-BY-SA-4.0",
    name: "Creative Commons Attribution-ShareAlike 4.0 International",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution: "Contains data from EVDB …",
    shareAlike: true,
    sourceId: "gaia",
  };

  it("carries the licenses of an imported profile into the settings", () => {
    const imported = profile({
      origin: {
        provider: "open-ev-directory",
        variantId: "var_1",
        makeName: "Volkswagen",
        modelName: "ID.7",
        variantName: "GTX",
        sourceId: "gaia",
        sourceRecordKey: "gaia:x",
        sourceUrl: null,
        curveId: "crv_1",
        curveSourceId: "gaia",
        curveQuality: "UNKNOWN",
        qualityBasis: null,
        observations: [],
        datasetVersion: null,
        licenses: [GAIA],
        importedAt: "2026-10-11T00:00:00.000Z",
      },
    });
    for (const type of ["AC", "DC"] as const) {
      const result = resolveEvSettings(imported, type);
      if (!result.ok) throw new Error("expected ok");
      expect(result.settings.attribution).toEqual([
        {
          sourceId: "gaia",
          text: "Contains data from EVDB …",
          licenseName: GAIA.name,
          licenseUrl: GAIA.url,
          shareAlike: true,
        },
      ]);
    }
  });

  it("owes nothing for a hand-made profile, explicitly", () => {
    const result = resolveEvSettings(profile(), "DC");
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.attribution).toEqual([]);
  });
});

describe("applyVehicleSettings (#458)", () => {
  const base: EVSettings = {
    modelName: "Generic EV",
    batteryCapacityKwh: 75,
    maxChargingPowerKw: 150,
    initialSoc: 20,
    targetSoc: 80,
    chargingCurve: [{ socPercent: 0, powerFraction: 0.5 }],
    currentType: "DC",
    phases: 3,
    voltageV: 400,
  };

  it("keeps the session SoCs and the electrical values the vehicle does not set", () => {
    const result = resolveEvSettings(profile(), "DC");
    if (!result.ok) throw new Error("expected ok");
    const applied = applyVehicleSettings(base, result.settings);
    expect(applied.initialSoc).toBe(20);
    expect(applied.targetSoc).toBe(80);
    expect(applied.voltageV).toBe(400);
    expect(applied.batteryCapacityKwh).toBe(86);
  });

  // The connector and a scenario start *merge* settings into the current
  // ones (`applyEvSettingsOverride`), so "no curve" has to be a value: a
  // missing key would keep the previous vehicle's curve and phases.
  it("overwrites a previous curve when merged the way the connector merges", () => {
    const result = resolveEvSettings(profile({ dcCurve: null }), "DC");
    if (!result.ok) throw new Error("expected ok");
    const merged = { ...base, ...applyVehicleSettings(base, result.settings) };
    expect(merged.chargingCurve).toEqual([]);
  });

  it("overwrites a previous curve and phase count for AC", () => {
    const result = resolveEvSettings(
      profile({ specs: { ...profile().specs, acPhases: null } }),
      "AC",
    );
    if (!result.ok) throw new Error("expected ok");
    const merged = { ...base, ...applyVehicleSettings(base, result.settings) };
    expect(merged.chargingCurve).toEqual([]);
    expect(merged.phases).toBe(1);
    expect(merged.currentType).toBe("AC");
  });
});
