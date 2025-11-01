import {
  ScenarioDefinition,
  ConnectorScenariosCollection,
} from "../cp/application/scenario/ScenarioTypes";

const STORAGE_KEY_PREFIX = "scenario_";
const SCENARIOS_KEY_PREFIX = "scenarios_"; // New prefix for multiple scenarios
const STORAGE_VERSION = 1;

/**
 * Save scenario to localStorage
 */
export function saveScenario(
  chargePointId: string,
  connectorId: number | null,
  scenario: ScenarioDefinition,
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
  connectorId: number | null,
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
export function deleteScenario(
  chargePointId: string,
  connectorId: number | null,
): void {
  const key = buildStorageKey(chargePointId, connectorId);
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.error("Failed to delete scenario:", error);
  }
}

/**
 * List all scenarios for a charge point (LEGACY - uses old storage format)
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
 * List all scenarios for a charge point using the NEW storage format
 * Aggregates scenarios from all connectors and the charge point itself
 */
export function listAllScenarios(chargePointId: string): ScenarioDefinition[] {
  const scenarios: ScenarioDefinition[] = [];
  const prefix = `${SCENARIOS_KEY_PREFIX}${chargePointId}_`;

  try {
    const keys = Object.keys(localStorage);
    keys.forEach((key) => {
      if (key.startsWith(prefix)) {
        const stored = localStorage.getItem(key);
        if (stored) {
          const collection = JSON.parse(stored) as ConnectorScenariosCollection;
          scenarios.push(...(collection.scenarios || []));
        }
      }
    });

    // Also check for legacy scenarios and migrate them
    const legacyScenarios = listScenarios(chargePointId);
    if (legacyScenarios.length > 0) {
      console.log(
        `[scenarioStorage] Found ${legacyScenarios.length} legacy scenarios, migrating...`,
      );
      // Migrate each legacy scenario
      legacyScenarios.forEach((legacyScenario) => {
        const connectorId = legacyScenario.targetId || null;
        const migrated = migrateScenarioToNew(legacyScenario);

        // Load existing scenarios for this connector
        const existing = loadScenarios(chargePointId, connectorId);

        // Check if this scenario already exists in the new format
        const alreadyMigrated = existing.some((s) => s.id === migrated.id);

        if (!alreadyMigrated) {
          // Add to new storage
          existing.push(migrated);
          saveScenarios(chargePointId, connectorId, existing);
          scenarios.push(migrated);
        }
      });

      // Delete legacy storage keys after migration
      legacyScenarios.forEach((scenario) => {
        const connectorId = scenario.targetId || null;
        deleteScenario(chargePointId, connectorId);
      });
    }
  } catch (error) {
    console.error("Failed to list all scenarios:", error);
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
export function importScenarioFromJSON(
  file: File,
): Promise<ScenarioDefinition> {
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
function buildStorageKey(
  chargePointId: string,
  connectorId: number | null,
): string {
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
  name?: string,
): ScenarioDefinition {
  const targetType = connectorId === null ? "chargePoint" : "connector";
  const scenarioName =
    name ||
    `Scenario for ${targetType === "chargePoint" ? chargePointId : `${chargePointId} Connector ${connectorId}`}`;

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
    trigger: { type: "manual" },
    defaultExecutionMode: "oneshot",
    enabled: true,
  };
}

// ============================================================================
// MULTIPLE SCENARIOS SUPPORT (NEW)
// ============================================================================

/**
 * Build storage key for multiple scenarios
 */
function buildScenariosStorageKey(
  chargePointId: string,
  connectorId: number | null,
): string {
  if (connectorId === null) {
    return `${SCENARIOS_KEY_PREFIX}${chargePointId}_chargepoint`;
  }
  return `${SCENARIOS_KEY_PREFIX}${chargePointId}_connector_${connectorId}`;
}

/**
 * Load all scenarios for a connector
 * Automatically migrates from legacy storage if needed
 */
export function loadScenarios(
  chargePointId: string,
  connectorId: number | null,
): ScenarioDefinition[] {
  const key = buildScenariosStorageKey(chargePointId, connectorId);

  try {
    const stored = localStorage.getItem(key);

    if (stored) {
      // Load from new storage format
      const collection = JSON.parse(stored) as ConnectorScenariosCollection;
      return collection.scenarios || [];
    } else {
      // Try to migrate from legacy storage
      const legacyScenario = loadScenario(chargePointId, connectorId);
      if (legacyScenario) {
        // Migrate to new format
        const migrated = migrateScenarioToNew(legacyScenario);
        saveScenarios(chargePointId, connectorId, [migrated]);
        // Delete legacy storage
        deleteScenario(chargePointId, connectorId);
        return [migrated];
      }
    }
  } catch (error) {
    console.error("Failed to load scenarios:", error);
  }

  return [];
}

/**
 * Save all scenarios for a connector
 */
export function saveScenarios(
  chargePointId: string,
  connectorId: number | null,
  scenarios: ScenarioDefinition[],
): void {
  const key = buildScenariosStorageKey(chargePointId, connectorId);

  try {
    const collection: ConnectorScenariosCollection = {
      version: STORAGE_VERSION,
      scenarios,
    };
    localStorage.setItem(key, JSON.stringify(collection));
  } catch (error) {
    console.error("Failed to save scenarios:", error);
  }
}

/**
 * Add a new scenario to the collection
 * NOTE: Only one scenario per connector is allowed.
 * This will replace any existing scenario.
 */
export function addScenario(
  chargePointId: string,
  connectorId: number | null,
  scenario: ScenarioDefinition,
): void {
  // Replace all existing scenarios with this one (only one scenario per connector)
  saveScenarios(chargePointId, connectorId, [scenario]);
}

/**
 * Update an existing scenario
 * NOTE: Since only one scenario per connector is allowed,
 * this will replace the existing scenario.
 */
export function updateScenario(
  chargePointId: string,
  connectorId: number | null,
  scenarioId: string,
  updatedScenario: ScenarioDefinition,
): void {
  // Simply save the updated scenario as the only scenario
  const updated = { ...updatedScenario, updatedAt: new Date().toISOString() };
  saveScenarios(chargePointId, connectorId, [updated]);
}

/**
 * Delete a specific scenario by ID
 * NOTE: Since only one scenario per connector is allowed,
 * this will delete the only scenario.
 */
export function deleteScenarioById(
  chargePointId: string,
  connectorId: number | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _scenarioId: string,
): void {
  // Delete all scenarios (which should only be one)
  saveScenarios(chargePointId, connectorId, []);
}

/**
 * Get a specific scenario by ID
 */
export function getScenarioById(
  chargePointId: string,
  connectorId: number | null,
  scenarioId: string,
): ScenarioDefinition | null {
  const scenarios = loadScenarios(chargePointId, connectorId);
  return scenarios.find((s) => s.id === scenarioId) || null;
}

/**
 * Migrate legacy scenario to new format
 */
function migrateScenarioToNew(
  scenario: ScenarioDefinition,
): ScenarioDefinition {
  return {
    ...scenario,
    trigger: scenario.trigger || { type: "manual" },
    defaultExecutionMode: scenario.defaultExecutionMode || "oneshot",
    enabled: scenario.enabled !== undefined ? scenario.enabled : true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Ensure only one scenario per connector
 * Call this to clean up any existing multiple scenarios
 */
export function ensureSingleScenario(
  chargePointId: string,
  connectorId: number | null,
): void {
  const scenarios = loadScenarios(chargePointId, connectorId);

  if (scenarios.length > 1) {
    console.warn(
      `[scenarioStorage] Found ${scenarios.length} scenarios for connector ${connectorId}, keeping only the first one`,
    );
    // Keep only the first (most recent or enabled) scenario
    const firstEnabled = scenarios.find((s) => s.enabled) || scenarios[0];
    saveScenarios(chargePointId, connectorId, [firstEnabled]);
  }
}
