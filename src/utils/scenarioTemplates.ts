import {
  ScenarioDefinition,
  ScenarioNode,
  ScenarioTrigger,
  ScenarioExecutionMode,
} from "../cp/application/scenario/ScenarioTypes";
import type { EVSettings } from "../cp/domain/connector/EVSettings";
import type { Edge } from "@xyflow/react";

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
 * Shape of every JSON file under ./scenarios/. The `scenario` block is a
 * ScenarioDefinition without the runtime fields — `id`, `targetId`,
 * `createdAt`, `updatedAt` are synthesized at instantiation time so each
 * load yields a distinct, persistable instance.
 */
interface TemplateJson {
  templateId: string;
  templateName: string;
  templateDescription: string;
  scenario: {
    name: string;
    description?: string;
    targetType: "chargePoint" | "connector";
    nodes: ScenarioNode[];
    edges: Edge[];
    trigger?: ScenarioTrigger;
    defaultExecutionMode?: ScenarioExecutionMode;
    enabled?: boolean;
    evSettings?: Partial<EVSettings>;
  };
}

/**
 * Wrap a JSON template into the ScenarioTemplate interface the editor
 * and CLI registry consume. `createScenario`:
 *  - Generates a unique scenario id that bakes in the template id, cpId
 *    and connectorId so the daemon's per-connector seed loop in
 *    CPRegistry.create doesn't collide on Date.now() and overwrite
 *    earlier connectors' `_scenarios` entries.
 *  - Deep-clones nodes/edges so each instance can be mutated
 *    independently by the editor without leaking back to the JSON.
 */
function templateFromJson(json: TemplateJson): ScenarioTemplate {
  return {
    id: json.templateId,
    name: json.templateName,
    description: json.templateDescription,
    targetType: json.scenario.targetType,
    createScenario: (chargePointId, connectorId) => {
      const now = new Date().toISOString();
      const suffix = Math.random().toString(36).slice(2, 8);
      return {
        ...json.scenario,
        id: `${json.templateId}-${chargePointId}-c${connectorId ?? "cp"}-${Date.now()}-${suffix}`,
        targetType: json.scenario.targetType,
        targetId: connectorId ?? undefined,
        nodes: structuredClone(json.scenario.nodes),
        edges: structuredClone(json.scenario.edges),
        trigger: json.scenario.trigger ?? { type: "manual" },
        defaultExecutionMode: json.scenario.defaultExecutionMode ?? "oneshot",
        enabled: json.scenario.enabled ?? true,
        evSettings: json.scenario.evSettings
          ? structuredClone(json.scenario.evSettings)
          : undefined,
        createdAt: now,
        updatedAt: now,
      };
    },
  };
}

/**
 * All available templates. Essential first so it surfaces at the top of
 * the template picker and also as the seed in CPRegistry.create —
 * matches src/utils/scenarios/essential-cp-behavior.json.
 */
export const scenarioTemplates: ScenarioTemplate[] = [
  templateFromJson(essentialCpBehaviorJson as TemplateJson),
  templateFromJson(fullChargingCycleJson as TemplateJson),
  templateFromJson(smartChargingJson as TemplateJson),
  templateFromJson(multiStatusMonitorJson as TemplateJson),
  templateFromJson(statusTriggeredActionsJson as TemplateJson),
  templateFromJson(remoteStartAutoMeterJson as TemplateJson),
];

export function getTemplateById(
  templateId: string,
): ScenarioTemplate | undefined {
  return scenarioTemplates.find((t) => t.id === templateId);
}
