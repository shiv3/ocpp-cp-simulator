import { describe, it, expect } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import { defaultEVSettings, type EVSettings } from "../EVSettings";

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

  it("applyDefaultEvSettings replaces settings wholesale when there is no override", () => {
    const connector = makeConnector();

    connector.applyDefaultEvSettings(nextDefault);

    expect(connector.evSettings).toEqual(nextDefault);
  });
});
