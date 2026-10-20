// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { profileFromCatalog } from "../../cp/domain/vehicle/importProfile";
import {
  applyVehicleSettings,
  resolveEvSettings,
} from "../../cp/domain/vehicle/VehicleProfile";
import { presetForScenario } from "../../components/vehicle/vehicleChoice";
import { exportScenarioToJSON, parseScenarioJSON } from "../scenarioFile";

/**
 * #458: a scenario whose EV settings were filled from an imported profile
 * redistributes third-party data (Gaia curves are CC BY-SA 4.0) when it is
 * exported, so the credit and the license travel with it.
 */

const GAIA = {
  id: "CC-BY-SA-4.0",
  name: "Creative Commons Attribution-ShareAlike 4.0 International",
  url: "https://creativecommons.org/licenses/by-sa/4.0/",
  attribution: "Contains data from EVDB (https://github.com/gaia-charge/evdb)",
  shareAlike: true,
};

function importedEvSettings() {
  const imported = profileFromCatalog(
    {
      id: "var_1",
      name: "ID.7 GTX",
      makeName: "Volkswagen",
      modelName: "ID.7",
      datasetVersion: null,
      sourceRecords: [
        {
          key: "gaia:id7",
          sourceId: "gaia",
          makeName: "Volkswagen",
          modelName: "ID.7",
          variantName: "GTX",
          year: 2024,
          yearKind: "MODEL_YEAR",
          markets: [],
          sourceUrl: null,
          specs: {
            usableBatteryKwh: 86,
            acMaxKw: 11,
            acPhases: 3,
            dcMaxKw: 200,
            acConnectors: [],
            dcConnectors: [],
          },
          license: GAIA,
        },
      ],
      curves: [
        {
          id: "crv_1",
          sourceId: "gaia",
          sourceRecordKey: "gaia:id7",
          quality: "UNKNOWN",
          qualityBasis: "",
          originalQuality: "",
          observations: [],
          points: [
            { socPercent: 0, powerKw: 200 },
            { socPercent: 90, powerKw: 40 },
          ],
          datasetVersion: null,
          license: GAIA,
        },
      ],
    },
    { sourceRecordKey: "gaia:id7", curveId: "crv_1" },
    { id: "vp_1", now: "2026-10-12T00:00:00.000Z" },
  );
  if (!imported.ok) throw new Error(imported.reason);
  const resolved = resolveEvSettings(imported.profile, "DC");
  if (!resolved.ok) throw new Error(resolved.reason);
  return applyVehicleSettings({ initialSoc: 20 }, resolved.settings);
}

function scenario(
  evSettings: ScenarioDefinition["evSettings"],
): ScenarioDefinition {
  return {
    id: "s-1",
    name: "s-1",
    targetType: "connector",
    targetId: 1,
    nodes: [],
    edges: [],
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
    evSettings,
  };
}

/** The text `exportScenarioToJSON` downloads. */
async function exported(definition: ScenarioDefinition): Promise<string> {
  let blob: Blob | null = null;
  vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
    blob = b as Blob;
    return "blob:test";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  exportScenarioToJSON(definition);
  return (blob as unknown as Blob).text();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scenario export attribution (#458)", () => {
  it("exports the credit and the license of profile-derived EV settings", async () => {
    const text = await exported(scenario(importedEvSettings()));
    expect(text).toContain(GAIA.attribution);
    expect(text).toContain("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(parseScenarioJSON(text).evSettings?.attribution).toEqual(
      importedEvSettings().attribution,
    );
  });

  it("owes no credit once a preset replaces the vehicle", async () => {
    const text = await exported(
      scenario(presetForScenario(importedEvSettings(), "Tesla Model 3")),
    );
    expect(text).not.toContain("EVDB");
    // Explicitly none, so a run does not keep a connector's previous credit.
    expect(parseScenarioJSON(text).evSettings?.attribution).toEqual([]);
  });
});
