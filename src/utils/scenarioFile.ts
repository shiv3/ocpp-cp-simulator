import type { ScenarioDefinition } from "../cp/application/scenario/ScenarioTypes";

/**
 * Browser-only file I/O helpers for scenario JSON files. Lifted out of
 * the old `scenarioStorage.ts` so the storage module can be deleted —
 * these don't touch localStorage / SQLite, they only marshal data
 * to/from a `<a download>` Blob and a user-picked `File`.
 */

/** Trigger a file download for the given scenario. The filename is
 *  `scenario_<name>_<timestamp>.json` so multiple exports don't collide. */
export function exportScenarioToJSON(scenario: ScenarioDefinition): void {
  const json = JSON.stringify(scenario, null, 2);
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
        const scenario = JSON.parse(content) as ScenarioDefinition;
        if (!scenario.id || !scenario.nodes || !scenario.edges) {
          throw new Error("Invalid scenario file format");
        }
        resolve(scenario);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}
