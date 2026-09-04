// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EVSettings } from "../../cp/domain/connector/EVSettings";

/**
 * Regression for #301: a malformed `chargingCurve` sitting in localStorage
 * must not reach either consumer of the stored Default EV Settings — neither
 * the connector-domain override (`setUserDefaultEVSettings`, which a fresh
 * connector reads at construction) nor the React state the Settings page maps
 * over to render the curve editor. Normalizing only the first left the page
 * itself crashing on exactly the input the guard exists to tolerate.
 */
const STORAGE_KEY = "ocpp-cp.default-ev-settings";

const STORED_BASE = {
  modelName: "Stored EV",
  batteryCapacityKwh: 75,
  maxChargingPowerKw: 150,
  initialSoc: 20,
  targetSoc: 80,
};

afterEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

async function loadProvider() {
  vi.resetModules();
  return import("./DataProvider");
}

describe("parseStoredDefaultEv normalizes the stored charging curve (#301)", () => {
  it("discards an array of nulls", () => {
    const raw = JSON.stringify({ ...STORED_BASE, chargingCurve: [null] });
    return loadProvider().then(({ parseStoredDefaultEv }) => {
      expect(parseStoredDefaultEv(raw)?.chargingCurve).toEqual([]);
    });
  });

  it("discards a curve that is not an array", () => {
    const raw = JSON.stringify({ ...STORED_BASE, chargingCurve: {} });
    return loadProvider().then(({ parseStoredDefaultEv }) => {
      expect(parseStoredDefaultEv(raw)?.chargingCurve).toEqual([]);
    });
  });

  it("sorts and keeps a valid curve", () => {
    const raw = JSON.stringify({
      ...STORED_BASE,
      chargingCurve: [
        { socPercent: 80, powerFraction: 0.4 },
        { socPercent: 0, powerFraction: 1 },
      ],
    });
    return loadProvider().then(({ parseStoredDefaultEv }) => {
      expect(
        parseStoredDefaultEv(raw)?.chargingCurve?.map((p) => p.socPercent),
      ).toEqual([0, 80]);
    });
  });

  it("returns null for absent or unusable storage", () => {
    return loadProvider().then(({ parseStoredDefaultEv }) => {
      expect(parseStoredDefaultEv(null)).toBeNull();
      expect(parseStoredDefaultEv("not json")).toBeNull();
      expect(
        parseStoredDefaultEv(JSON.stringify({ modelName: "x" })),
      ).toBeNull();
    });
  });

  it("seeds the connector-domain override from the same guarded value", async () => {
    // The module-level seed runs at import time, before any Connector is
    // constructed — this asserts the two consumers cannot disagree.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...STORED_BASE, chargingCurve: [null] }),
    );
    await loadProvider();
    const { getUserDefaultEVSettings, setUserDefaultEVSettings } =
      await import("../../cp/domain/connector/EVSettings");
    const seeded = getUserDefaultEVSettings() as EVSettings | null;
    expect(seeded?.chargingCurve).toEqual([]);
    setUserDefaultEVSettings(null);
  });
});
