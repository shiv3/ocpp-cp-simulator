import { describe, it, expect, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import { ScenarioDefinition, ScenarioNodeType } from "../ScenarioTypes";

/**
 * Builds a small four-node scenario: Start → A → B → End. Both A and B
 * are MeterValue nodes so we can spy on which ones the executor actually
 * fires via `onSetMeterValue`. Used to assert what `resumeFromNodeId`
 * does and does not re-execute.
 */
function buildLinearScenario(): ScenarioDefinition {
  return {
    id: "scenario-resume-test",
    name: "Resume test",
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
        id: "node-a",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 100 },
        data: { label: "A", value: 100, sendMessage: false },
      },
      {
        id: "node-b",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 200 },
        data: { label: "B", value: 200, sendMessage: false },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 300 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start", source: "start", target: "node-a" },
      { id: "e-a", source: "node-a", target: "node-b" },
      { id: "e-b", source: "node-b", target: "end" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  };
}

describe("ScenarioExecutor.start(resumeFromNodeId)", () => {
  it("resumes from the edge after lastCompletedNodeId", async () => {
    // After a restart that captured "we just finished node-a", the
    // executor should pick up at node-b without re-executing node-a.
    // (Re-running the meterValue node would double-bump the meter and
    // — in the real world — replay side effects like Plug In / Start
    // Transaction.)
    const onSetMeterValue = vi.fn();
    const executor = new ScenarioExecutor(buildLinearScenario(), {
      onSetMeterValue,
    });

    await executor.start({
      resumeFromNodeId: "node-a",
      executedNodes: ["start", "node-a"],
    });

    expect(onSetMeterValue).toHaveBeenCalledTimes(1);
    expect(onSetMeterValue).toHaveBeenCalledWith(200); // B, not A
  });

  it("falls back to a fresh run when the resume node is unknown", async () => {
    // Scenario edited between persistence and resume — the stored node
    // id no longer exists in the graph. Executor must warn and replay
    // from the start node instead of throwing or hanging.
    const onSetMeterValue = vi.fn();
    const log = vi.fn();
    const executor = new ScenarioExecutor(buildLinearScenario(), {
      onSetMeterValue,
      log,
    });

    await executor.start({
      resumeFromNodeId: "node-removed",
      executedNodes: ["start", "node-removed"],
    });

    expect(onSetMeterValue).toHaveBeenCalledTimes(2);
    expect(onSetMeterValue).toHaveBeenNthCalledWith(1, 100);
    expect(onSetMeterValue).toHaveBeenNthCalledWith(2, 200);
    // Warning was emitted.
    const warnedCalls = log.mock.calls.filter(([, level]) => level === "warn");
    expect(warnedCalls.length).toBeGreaterThan(0);
    expect(warnedCalls[0][0]).toMatch(/Cannot resume/);
  });

  it("runs the full flow when no resume hint is given (backward compat)", async () => {
    const onSetMeterValue = vi.fn();
    const executor = new ScenarioExecutor(buildLinearScenario(), {
      onSetMeterValue,
    });
    await executor.start();
    expect(onSetMeterValue).toHaveBeenCalledTimes(2);
    expect(onSetMeterValue).toHaveBeenNthCalledWith(1, 100);
    expect(onSetMeterValue).toHaveBeenNthCalledWith(2, 200);
  });
});
