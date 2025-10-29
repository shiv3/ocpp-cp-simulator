import { ScenarioDefinition } from "../cp/types/ScenarioTypes";

const STORAGE_KEY_PREFIX = "scenario_";

/**
 * Save scenario to localStorage
 */
export function saveScenario(
  chargePointId: string,
  connectorId: number | null,
  scenario: ScenarioDefinition
): void {
  const key = buildStorageKey(chargePointId, connectorId);
  try {
    localStorage.setItem(key, JSON.stringify(scenario));
  } catch (error) {
    console.error("Failed to save scenario:", error);
  }
}

/**
 * Load scenario from localStorage
 */
export function loadScenario(
  chargePointId: string,
  connectorId: number | null
): ScenarioDefinition | null {
  const key = buildStorageKey(chargePointId, connectorId);
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      return JSON.parse(stored) as ScenarioDefinition;
    }
  } catch (error) {
    console.error("Failed to load scenario:", error);
  }
  return null;
}

/**
 * Delete scenario from localStorage
 */
export function deleteScenario(chargePointId: string, connectorId: number | null): void {
  const key = buildStorageKey(chargePointId, connectorId);
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.error("Failed to delete scenario:", error);
  }
}

/**
 * List all scenarios for a charge point
 */
export function listScenarios(chargePointId: string): ScenarioDefinition[] {
  const scenarios: ScenarioDefinition[] = [];
  const prefix = `${STORAGE_KEY_PREFIX}${chargePointId}_`;

  try {
    const keys = Object.keys(localStorage);
    keys.forEach((key) => {
      if (key.startsWith(prefix)) {
        const stored = localStorage.getItem(key);
        if (stored) {
          scenarios.push(JSON.parse(stored));
        }
      }
    });
  } catch (error) {
    console.error("Failed to list scenarios:", error);
  }

  return scenarios;
}

/**
 * Export scenario to JSON file
 */
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

/**
 * Import scenario from JSON file
 */
export function importScenarioFromJSON(file: File): Promise<ScenarioDefinition> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const scenario = JSON.parse(content) as ScenarioDefinition;

        // Validate scenario structure
        if (!scenario.id || !scenario.nodes || !scenario.edges) {
          throw new Error("Invalid scenario file format");
        }

        resolve(scenario);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => {
      reject(new Error("Failed to read file"));
    };

    reader.readAsText(file);
  });
}

/**
 * Build storage key
 */
function buildStorageKey(chargePointId: string, connectorId: number | null): string {
  if (connectorId === null) {
    return `${STORAGE_KEY_PREFIX}${chargePointId}_chargepoint`;
  }
  return `${STORAGE_KEY_PREFIX}${chargePointId}_connector_${connectorId}`;
}

/**
 * Create default scenario
 */
export function createDefaultScenario(
  chargePointId: string,
  connectorId: number | null,
  name?: string
): ScenarioDefinition {
  const targetType = connectorId === null ? "chargePoint" : "connector";
  const scenarioName =
    name || `Scenario for ${targetType === "chargePoint" ? chargePointId : `${chargePointId} Connector ${connectorId}`}`;

  return {
    id: `${chargePointId}_${connectorId || "cp"}_${Date.now()}`,
    name: scenarioName,
    description: "",
    targetType,
    targetId: connectorId || undefined,
    nodes: [
      {
        id: "start-1",
        type: "start",
        position: { x: 250, y: 50 },
        data: { label: "Start" },
      },
      {
        id: "end-1",
        type: "end",
        position: { x: 250, y: 300 },
        data: { label: "End" },
      },
    ],
    edges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
