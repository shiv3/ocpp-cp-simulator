import { describe, expect, it } from "vitest";

import { Logger, LogLevel } from "../../../shared/Logger";
import { Connector } from "../Connector";
import {
  getDefaultEVSettings,
  setUserDefaultEVSettings,
  type EVSettings,
  type EVSettingsPatch,
} from "../EVSettings";

/**
 * #458: an EV settings write is a merge patch — an absent key keeps the
 * current value, `null` removes it. Without a way to remove a field, a
 * vehicle without a curve or an electrical model could never replace one
 * that has them: the merge kept the previous vehicle's values.
 */

function connectorWithProfileVehicle(): Connector {
  const connector = new Connector(1, new Logger(LogLevel.ERROR));
  connector.evSettings = {
    ...connector.evSettings,
    modelName: "Volkswagen ID.7 GTX",
    currentType: "AC",
    phases: 3,
    chargingCurve: [
      { socPercent: 0, powerFraction: 1 },
      { socPercent: 100, powerFraction: 0.1 },
    ],
  };
  return connector;
}

describe("EV settings merge patch (#458)", () => {
  it("removes the fields a patch sets to null and keeps the absent ones", () => {
    const connector = connectorWithProfileVehicle();
    const patch: EVSettingsPatch = {
      modelName: "Tesla Model 3",
      chargingCurve: null,
      currentType: null,
      phases: null,
    };
    connector.applyEvSettingsOverride(patch);
    const settings = connector.evSettings;
    expect(settings.modelName).toBe("Tesla Model 3");
    expect("chargingCurve" in settings).toBe(false);
    expect("currentType" in settings).toBe(false);
    expect("phases" in settings).toBe(false);
    expect(settings.batteryCapacityKwh).toBeGreaterThan(0);
  });

  it("never exposes a null, in the settings or in the change event", () => {
    const connector = connectorWithProfileVehicle();
    const emitted: unknown[] = [];
    connector.events.on("evSettingsChange", (e) => emitted.push(e));
    connector.applyEvSettingsOverride({ currentType: null });
    expect(JSON.stringify(connector.evSettings)).not.toContain("null");
    expect(JSON.stringify(emitted)).not.toContain("null");
  });

  it("strips nulls written wholesale too", () => {
    const connector = connectorWithProfileVehicle();
    connector.evSettings = {
      ...connector.evSettings,
      phases: null,
    } as unknown as EVSettings;
    expect("phases" in connector.evSettings).toBe(false);
  });

  it("strips nulls from the user's default EV settings", () => {
    setUserDefaultEVSettings({
      ...getDefaultEVSettings(),
      currentType: null,
    } as unknown as EVSettings);
    try {
      expect("currentType" in getDefaultEVSettings()).toBe(false);
    } finally {
      setUserDefaultEVSettings(null);
    }
  });
});
