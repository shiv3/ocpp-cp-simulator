import { describe, it, expect, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import { ScenarioDefinition, ScenarioNodeType } from "../ScenarioTypes";
import { OCPPStatus } from "../../../domain/types/OcppTypes";

describe("ScenarioExecutor StatusTrigger", () => {
  it("waits for onWaitForStatus before executing the next node", async () => {
    let resolveStatus: (() => void) | null = null;
    const waitForStatusPromise = new Promise<void>((resolve) => {
      resolveStatus = resolve;
    });

    const onSetMeterValue = vi.fn();

    const scenario: ScenarioDefinition = {
      id: "scenario-test",
      name: "StatusTrigger wait test",
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
          id: "status-trigger",
          type: ScenarioNodeType.STATUS_TRIGGER,
          position: { x: 0, y: 100 },
          data: {
            label: "Wait Status",
            targetStatus: OCPPStatus.Charging,
            timeout: 0,
          },
        },
        {
          id: "meter",
          type: ScenarioNodeType.METER_VALUE,
          position: { x: 0, y: 200 },
          data: { label: "Set Meter", value: 123, sendMessage: false },
        },
        {
          id: "end",
          type: ScenarioNodeType.END,
          position: { x: 0, y: 300 },
          data: { label: "End" },
        },
      ],
      edges: [
        { id: "e-start", source: "start", target: "status-trigger" },
        { id: "e-status", source: "status-trigger", target: "meter" },
        { id: "e-meter", source: "meter", target: "end" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      defaultExecutionMode: "oneshot",
      enabled: true,
      trigger: { type: "manual" },
    };

    const executor = new ScenarioExecutor(scenario, {
      onWaitForStatus: () => waitForStatusPromise,
      onSetMeterValue,
    });

    const execution = executor.start("oneshot");

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSetMeterValue).not.toHaveBeenCalled();

    resolveStatus?.();
    await execution;

    expect(onSetMeterValue).toHaveBeenCalledWith(123);
  });
});
