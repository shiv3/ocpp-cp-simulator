import { describe, it, expect } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import {
  defaultEVSettings,
  InvalidEvSettingsPatchError,
  type EVSettings,
} from "../EVSettings";

function makeConnector(): Connector {
  // ERROR-level logger so tests stay quiet without overriding stdout.
  return new Connector(1, new Logger(LogLevel.ERROR));
}

const nextDefault: EVSettings = {
  ...defaultEVSettings,
  targetSoc: 80,
};

describe("Connector EV settings override tracking (#105)", () => {
  it("applyEvSettingsOverride merges a partial into the current settings", () => {
    const connector = makeConnector();

    connector.applyEvSettingsOverride({ targetSoc: 50 });

    expect(connector.evSettings.targetSoc).toBe(50);
    // Everything else keeps its previous (default) value — this is a
    // merge, not a replace.
    expect(connector.evSettings.modelName).toBe(defaultEVSettings.modelName);
    expect(connector.evSettings.batteryCapacityKwh).toBe(
      defaultEVSettings.batteryCapacityKwh,
    );
  });

  it("applyDefaultEvSettings is a no-op while an override is active", () => {
    const connector = makeConnector();

    connector.applyEvSettingsOverride({ targetSoc: 50 });
    connector.applyDefaultEvSettings(nextDefault);

    expect(connector.evSettings.targetSoc).toBe(50);
  });

  it("clearEvSettingsOverride keeps the current values but lets the next default propagation apply", () => {
    const connector = makeConnector();

    connector.applyEvSettingsOverride({ targetSoc: 50 });
    connector.clearEvSettingsOverride();

    // Values survive the clear itself...
    expect(connector.evSettings.targetSoc).toBe(50);

    // ...but the next default propagation is no longer blocked.
    connector.applyDefaultEvSettings(nextDefault);
    expect(connector.evSettings.targetSoc).toBe(80);
  });

  it("applyDefaultEvSettings sets a complete default as given when there is no override", () => {
    const connector = makeConnector();

    connector.applyDefaultEvSettings(nextDefault);

    expect(connector.evSettings).toEqual(nextDefault);
  });
});

describe("applyDefaultEvSettings merges onto the built-in defaults (#333)", () => {
  it("reads an omitted required field back as the built-in default", () => {
    const connector = makeConnector();
    connector.applyDefaultEvSettings({
      ...defaultEVSettings,
      initialSoc: 35,
      targetSoc: 90,
    });

    // A partial default: `initialSoc` is not named. It used to vanish from
    // the connector, so `EVSettings.initialSoc: number` held nothing.
    connector.applyDefaultEvSettings({
      modelName: "Partial EV",
      targetSoc: 70,
    });

    expect(connector.evSettings).toEqual({
      ...defaultEVSettings,
      modelName: "Partial EV",
      targetSoc: 70,
    });
    expect(connector.evSettings.initialSoc).toBe(defaultEVSettings.initialSoc);
  });

  it("merges onto the constant, not onto the current settings", () => {
    const connector = makeConnector();
    connector.applyDefaultEvSettings({
      ...defaultEVSettings,
      chargingCurve: [{ socPercent: 0, powerFraction: 0.5 }],
      phases: 3,
    });
    expect(connector.evSettings.chargingCurve).toBeDefined();

    // A default that does not name the curve or the phases describes a car
    // without them: nothing of the previous default carries over.
    connector.applyDefaultEvSettings({ targetSoc: 60 });

    expect("chargingCurve" in connector.evSettings).toBe(false);
    expect("phases" in connector.evSettings).toBe(false);
    expect(connector.evSettings.targetSoc).toBe(60);
  });

  it("still refuses a null required field, and changes nothing", () => {
    const connector = makeConnector();
    const before = { ...connector.evSettings };

    expect(() =>
      connector.applyDefaultEvSettings({ initialSoc: null } as never),
    ).toThrow(InvalidEvSettingsPatchError);
    expect(connector.evSettings).toEqual(before);
  });
});
