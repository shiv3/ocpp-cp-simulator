import { describe, expect, it } from "vitest";

import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import { meterFromSoc, socFromMeter } from "./useSocMeterSync";

const evSettings: EVSettings = {
  modelName: "Test EV",
  batteryCapacityKwh: 50,
  maxChargingPowerKw: 100,
  initialSoc: 20,
  targetSoc: 80,
};

describe("SoC/Meter conversions", () => {
  it("clamps SoC before deriving meter Wh", () => {
    expect(meterFromSoc(120, evSettings)).toBe(40_000);
    expect(meterFromSoc(-10, evSettings)).toBe(0);
  });

  it("clamps derived SoC to 100", () => {
    expect(socFromMeter(100_000, evSettings)).toBe(100);
  });
});
