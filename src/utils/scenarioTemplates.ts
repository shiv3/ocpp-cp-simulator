import { ScenarioDefinition } from "../cp/application/scenario/ScenarioTypes";

import essentialCpBehaviorJson from "./scenarios/essential-cp-behavior.json";
import fullChargingCycleJson from "./scenarios/full-charging-cycle.json";
import smartChargingJson from "./scenarios/smart-charging.json";
import multiStatusMonitorJson from "./scenarios/multi-status-monitor.json";
import statusTriggeredActionsJson from "./scenarios/status-triggered-actions.json";
import remoteStartAutoMeterJson from "./scenarios/remote-start-auto-meter.json";

export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  targetType: "chargePoint" | "connector";
  createScenario: (
    chargePointId: string,
    connectorId: number | null,
  ) => ScenarioDefinition;
}

/**
 * Each built-in template is a flat ScenarioDefinition JSON file under
 * ./scenarios/. The same shape that
 * docs/examples/scenarios/demo-charging.json uses, so the daemon's
 * --scenario-template-file path can load any of these straight off
 * disk without going through this loader.
 *
 * `templateFromJson` wraps the JSON in the editor-facing ScenarioTemplate
 * interface and `createScenario` deep-clones the nodes/edges + synthesizes
 * a per-instance `id` so:
 *   1. the daemon's per-connector seed loop in CPRegistry.create doesn't
 *      collide on Date.now() and overwrite earlier connectors' rows
 *   2. editing one loaded instance doesn't leak mutations back into the
 *      shared JSON module.
 */
function templateFromJson(json: ScenarioDefinition): ScenarioTemplate {
  return {
    id: json.id,
    name: json.name,
    description: json.description ?? "",
    targetType: json.targetType,
    createScenario: (chargePointId, connectorId) => {
      const now = new Date().toISOString();
      const suffix = Math.random().toString(36).slice(2, 8);
      return {
        ...json,
        id: `${json.id}-${chargePointId}-c${connectorId ?? "cp"}-${Date.now()}-${suffix}`,
        targetType: json.targetType,
        targetId: connectorId ?? undefined,
        nodes: structuredClone(json.nodes),
        edges: structuredClone(json.edges),
        trigger: json.trigger ?? { type: "manual" },
        defaultExecutionMode: json.defaultExecutionMode ?? "oneshot",
        enabled: json.enabled ?? true,
        evSettings: json.evSettings
          ? structuredClone(json.evSettings)
          : undefined,
        createdAt: now,
        updatedAt: now,
      };
    },
  };
}

/**
 * All available templates. Essential first so it surfaces at the top of
 * the template picker and as the seed in CPRegistry.create.
 */
export const scenarioTemplates: ScenarioTemplate[] = [
  templateFromJson(essentialCpBehaviorJson as ScenarioDefinition),
  templateFromJson(fullChargingCycleJson as ScenarioDefinition),
  templateFromJson(smartChargingJson as ScenarioDefinition),
  templateFromJson(multiStatusMonitorJson as ScenarioDefinition),
  templateFromJson(statusTriggeredActionsJson as ScenarioDefinition),
  templateFromJson(remoteStartAutoMeterJson as ScenarioDefinition),
];

export function getTemplateById(
  templateId: string,
): ScenarioTemplate | undefined {
  return scenarioTemplates.find((t) => t.id === templateId);
}
