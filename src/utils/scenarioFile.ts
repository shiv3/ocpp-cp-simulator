import {
  SCENARIO_SCHEMA_VERSION,
  type ScenarioDefinition,
} from "../cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "../scenario/scenarioSchemaValidator";

/**
 * Browser-only file I/O helpers for scenario JSON files. Lifted out of
 * the old `scenarioStorage.ts` so the storage module can be deleted —
 * these don't touch localStorage / SQLite, they only marshal data
 * to/from a `<a download>` Blob and a user-picked `File`.
 */

/** Stamp the current {@link SCENARIO_SCHEMA_VERSION} onto a scenario without
 *  mutating the input (issue #214). Exported separately from
 *  {@link exportScenarioToJSON} so the stamping behavior is unit-testable
 *  without a DOM (Blob/download) environment. */
export function withScenarioSchemaVersion(
  scenario: ScenarioDefinition,
): ScenarioDefinition {
  return { ...scenario, schemaVersion: SCENARIO_SCHEMA_VERSION };
}

/** Trigger a file download for the given scenario. The filename is
 *  `scenario_<name>_<timestamp>.json` so multiple exports don't collide.
 *  Stamps the current {@link SCENARIO_SCHEMA_VERSION} onto the exported
 *  file (issue #214) so newly-exported scenarios declare their format
 *  version; the in-memory `scenario` object passed in is not mutated. */
export function exportScenarioToJSON(scenario: ScenarioDefinition): void {
  const withSchemaVersion = withScenarioSchemaVersion(scenario);
  const json = JSON.stringify(withSchemaVersion, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `scenario_${scenario.name}_${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Parse and validate a scenario from JSON text. Throws on invalid structure —
 *  rejects non-objects, requires a non-empty string `id`, and requires `nodes`
 *  and `edges` to be arrays (truthiness alone would accept `nodes: {}` etc.).
 *
 *  Issue #214: additionally runs the imported value through the published
 *  `schema/scenario.schema.json` and, on a mismatch, logs a `console.warn`
 *  listing the first few errors. This is ADVISORY ONLY — unlike the
 *  structural checks above, a schema mismatch never throws; the scenario is
 *  still returned and loads exactly as before. */
export function parseScenarioJSON(text: string): ScenarioDefinition {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid scenario file format");
  }
  const scenario = parsed as Partial<ScenarioDefinition>;
  if (
    typeof scenario.id !== "string" ||
    scenario.id.length === 0 ||
    !Array.isArray(scenario.nodes) ||
    !Array.isArray(scenario.edges)
  ) {
    throw new Error("Invalid scenario file format");
  }
  const schemaResult = validateScenarioSchema(parsed);
  if (!schemaResult.valid) {
    console.warn(
      `[scenarioFile] Imported scenario "${scenario.id}" does not match schema/scenario.schema.json (loading anyway): ${schemaResult.errors.slice(0, 5).join("; ")}`,
    );
  }
  return scenario as ScenarioDefinition;
}

/** Parse a user-picked file as a `ScenarioDefinition`. Rejects when the
 *  structure is missing required fields. */
export function importScenarioFromJSON(
  file: File,
): Promise<ScenarioDefinition> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const scenario = parseScenarioJSON(content);
        resolve(scenario);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}
