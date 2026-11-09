import {
  SCENARIO_SCHEMA_VERSION,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "@ocpp-cp-simulator/core/scenario/scenarioSchemaValidator";
import {
  checkLoadableScenario,
  describeLoadDiagnostic,
} from "@ocpp-cp-simulator/core/scenario/loadableScenario";

/**
 * Browser-only file I/O helpers for scenario JSON files. Lifted out of
 * the old `scenarioStorage.ts` so the storage module can be deleted —
 * these don't touch localStorage / SQLite, they only marshal data
 * to/from a `<a download>` Blob and a user-picked `File`.
 */

/** `major.minor` of a schema version string, or `null` when it is not one. */
function parseSchemaVersion(v: unknown): [number, number] | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)(?:\..*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** True when `v` is a schema version newer than {@link SCENARIO_SCHEMA_VERSION}. */
function isNewerThanEditor(v: unknown): boolean {
  const have = parseSchemaVersion(v);
  const mine = parseSchemaVersion(SCENARIO_SCHEMA_VERSION)!;
  return (
    !!have && (have[0] > mine[0] || (have[0] === mine[0] && have[1] > mine[1]))
  );
}

/** Stamp the current {@link SCENARIO_SCHEMA_VERSION} onto a scenario without
 *  mutating the input (issue #214). A file that already declares a newer
 *  version keeps it: the editor never downgrades what it may not understand. Exported separately from
 *  {@link exportScenarioToJSON} so the stamping behavior is unit-testable
 *  without a DOM (Blob/download) environment. */
export function withScenarioSchemaVersion(
  scenario: ScenarioDefinition,
): ScenarioDefinition {
  if (isNewerThanEditor(scenario.schemaVersion)) return { ...scenario };
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
 *  The gate is the daemon's (`checkLoadableScenario`): a missing `name` /
 *  `targetType` is filled in (the id, "connector") and logged with
 *  `console.warn`, and so is an id the daemon could not address.
 *
 *  Issue #214: additionally runs the imported value through the published
 *  `packages/core/schema/scenario.schema.json` and, on a mismatch, logs a `console.warn`
 *  listing the first few errors. This is ADVISORY ONLY — unlike the
 *  structural checks above, a schema mismatch never throws; the scenario is
 *  still returned and loads exactly as before. */
export function parseScenarioJSON(text: string): ScenarioDefinition {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid scenario file format");
  }
  const check = checkLoadableScenario(parsed);
  if (!check.definition) {
    throw new Error("Invalid scenario file format");
  }
  const scenario = check.definition;
  for (const diagnostic of check.diagnostics) {
    console.warn(
      `[scenarioFile] Imported scenario "${scenario.id}": ${describeLoadDiagnostic(diagnostic)}`,
    );
  }
  const schemaResult = validateScenarioSchema(parsed);
  if (!schemaResult.valid) {
    console.warn(
      `[scenarioFile] Imported scenario "${scenario.id}" does not match packages/core/schema/scenario.schema.json (loading anyway): ${schemaResult.errors.slice(0, 5).join("; ")}`,
    );
  }
  return scenario;
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
