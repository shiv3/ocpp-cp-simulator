import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "../../cp/application/scenario/ScenarioTypes";

/**
 * Test fixture: start → park on a `GetConfiguration` csmsCallTrigger (node
 * `wait-cfg`) → end. The CALL never arrives in a test, so the run stays
 * parked until it is stopped, continued or times out (`timeout` seconds,
 * 0 = forever).
 */
export function parkingScenario(
  id: string,
  {
    timeout = 0,
    connectorId = 1,
  }: { timeout?: number; connectorId?: number } = {},
): ScenarioDefinition {
  return {
    id,
    name: "Park on GetConfiguration",
    targetType: "connector",
    targetId: connectorId,
    trigger: { type: "manual" },
    enabled: true,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "S" },
      },
      {
        id: "wait-cfg",
        type: ScenarioNodeType.CSMS_CALL_TRIGGER,
        position: { x: 0, y: 1 },
        data: {
          label: "Wait GetConfiguration",
          action: "GetConfiguration",
          timeout,
        },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 2 },
        data: { label: "E" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "wait-cfg" },
      { id: "e2", source: "wait-cfg", target: "end-1" },
    ],
    createdAt: "2026-07-13T00:00:00Z",
    updatedAt: "2026-07-13T00:00:00Z",
  };
}
