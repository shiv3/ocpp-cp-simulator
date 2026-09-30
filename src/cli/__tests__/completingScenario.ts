import {
  ScenarioNodeType,
  type AssertionSpec,
  type ScenarioDefinition,
} from "../../cp/application/scenario/ScenarioTypes";

/**
 * Test fixture: start → meterValue (not sent) → end, on `connectorId`. It
 * needs no CSMS, so a run finishes on its own within a few ticks.
 */
export function completingScenario(
  id: string,
  {
    connectorId = 1,
    assertions,
  }: { connectorId?: number; assertions?: AssertionSpec[] } = {},
): ScenarioDefinition {
  return {
    id,
    name: `Completing ${id}`,
    targetType: "connector",
    targetId: connectorId,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "S" },
      },
      {
        id: "mv-1",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 1 },
        data: { label: "MV", value: 100, sendMessage: false },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 2 },
        data: { label: "E" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "mv-1" },
      { id: "e2", source: "mv-1", target: "end-1" },
    ],
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
    ...(assertions ? { assertions } : {}),
  };
}
