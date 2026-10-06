import { describe, expect, it } from "vitest";

import { compactScenarioEvSettings } from "./compactScenarioEvSettings";

describe("compactScenarioEvSettings", () => {
  it("drops the empty fields, which inherit", () => {
    expect(
      compactScenarioEvSettings({
        modelName: "",
        batteryCapacityKwh: 60,
        initialSoc: undefined,
        // @ts-expect-error a cleared field can hold null
        targetSoc: null,
      }),
    ).toEqual({ batteryCapacityKwh: 60 });
  });

  it("keeps a zero and an explicit curve", () => {
    expect(
      compactScenarioEvSettings({
        initialSoc: 0,
        chargingCurve: [{ socPercent: 0, powerFraction: 1 }],
      }),
    ).toEqual({
      initialSoc: 0,
      chargingCurve: [{ socPercent: 0, powerFraction: 1 }],
    });
  });

  it("is undefined when nothing is left, so no empty object is saved", () => {
    expect(compactScenarioEvSettings({})).toBeUndefined();
    expect(compactScenarioEvSettings({ modelName: "" })).toBeUndefined();
  });
});
