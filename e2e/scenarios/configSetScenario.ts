import type { ScenarioDefinition } from "../../src/cp/application/scenario/ScenarioTypes";
import { ScenarioNodeType } from "../../src/cp/application/scenario/ScenarioTypes";

export const HEARTBEAT_INTERVAL_VALUE = "240";

const STAMP = "2026-01-01T00:00:00.000Z";
const POSITION = { x: 0, y: 0 };

export function makeConfigSetScenario(): ScenarioDefinition {
  return {
    id: "e2e-config-set",
    name: "E2E Config Set",
    targetType: "connector",
    targetId: 1,
    trigger: { type: "manual" },
    defaultExecutionMode: "oneshot",
    enabled: true,
    createdAt: STAMP,
    updatedAt: STAMP,
    nodes: [
      {
        id: "start",
        type: ScenarioNodeType.START,
        position: POSITION,
        data: { label: "Start" },
      },
      {
        id: "config-set-heartbeat",
        type: ScenarioNodeType.CONFIG_SET,
        position: POSITION,
        data: {
          label: "Set HeartbeatInterval",
          key: "HeartbeatInterval",
          value: HEARTBEAT_INTERVAL_VALUE,
        },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: POSITION,
        data: { label: "End" },
      },
    ],
    edges: [
      {
        id: "e-start-config-set",
        source: "start",
        target: "config-set-heartbeat",
      },
      { id: "e-config-set-end", source: "config-set-heartbeat", target: "end" },
    ],
  } satisfies ScenarioDefinition;
}
