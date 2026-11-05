import { describe, expect, it } from "vitest";

import { MAX_VEHICLE_CURVE_POINTS, vehicleProfileSchema } from "../vehicle";

const PROFILE = {
  id: "vp_1",
  name: "Volkswagen ID.7 GTX",
  specs: {
    usableBatteryKwh: 86,
    acMaxKw: 11,
    acPhases: 3,
    dcMaxKw: null,
    acConnectors: ["IEC_62196_T2"],
    dcConnectors: ["IEC_62196_T2_COMBO"],
  },
  dcCurve: [{ socPercent: 0, powerKw: 200 }],
  overrides: { dcMaxKw: 200 },
  origin: null,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
};

describe("vehicleProfileSchema (#458)", () => {
  it("accepts a profile with missing values", () => {
    expect(vehicleProfileSchema.safeParse(PROFILE).success).toBe(true);
  });

  it("refuses an empty id, a negative power and an out-of-range SoC", () => {
    expect(vehicleProfileSchema.safeParse({ ...PROFILE, id: "" }).success).toBe(
      false,
    );
    expect(
      vehicleProfileSchema.safeParse({
        ...PROFILE,
        dcCurve: [{ socPercent: 0, powerKw: -1 }],
      }).success,
    ).toBe(false);
    expect(
      vehicleProfileSchema.safeParse({
        ...PROFILE,
        dcCurve: [{ socPercent: 101, powerKw: 1 }],
      }).success,
    ).toBe(false);
  });

  it("bounds the curve", () => {
    const dcCurve = Array.from(
      { length: MAX_VEHICLE_CURVE_POINTS + 1 },
      (_, i) => ({
        socPercent: (i * 100) / MAX_VEHICLE_CURVE_POINTS,
        powerKw: 1,
      }),
    );
    expect(
      vehicleProfileSchema.safeParse({ ...PROFILE, dcCurve }).success,
    ).toBe(false);
  });

  it("drops fields it does not know rather than storing them", () => {
    const parsed = vehicleProfileSchema.parse({ ...PROFILE, apiKey: "x" });
    expect("apiKey" in parsed).toBe(false);
  });
});
