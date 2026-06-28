import { describe, it, expect, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import { ScenarioDefinition, ScenarioNodeType } from "../ScenarioTypes";

function buildCompletingScenario(): ScenarioDefinition {
  return {
    id: "scenario-context-test",
    name: "Context reporting test",
    targetType: "connector",
    targetId: 1,
    nodes: [
      {
        id: "start",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "meter",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 100 },
        data: { label: "Meter", value: 123, sendMessage: false },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 200 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start", source: "start", target: "meter" },
      { id: "e-meter", source: "meter", target: "end" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  };
}

describe("ScenarioExecutor context reporting", () => {
  it("reports completed state and node progress after a completed run", async () => {
    const onSetMeterValue = vi.fn();
    const onNodeExecute = vi.fn();
    const executor = new ScenarioExecutor(buildCompletingScenario(), {
      onSetMeterValue,
      onNodeExecute,
    });

    await executor.start();

    expect(onSetMeterValue).toHaveBeenCalledWith(123);
    expect(onNodeExecute).toHaveBeenNthCalledWith(1, "start");
    expect(onNodeExecute).toHaveBeenNthCalledWith(2, "meter");
    expect(onNodeExecute).toHaveBeenNthCalledWith(3, "end");
    expect(executor.getContext()).toMatchObject({
      state: "completed",
      executedNodes: ["start", "meter", "end"],
      currentNodeId: null,
    });
  });
});
