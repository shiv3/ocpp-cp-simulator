import { describe, it, expect, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import type { ScenarioDefinition } from "../ScenarioTypes";
import { ScenarioNodeType } from "../ScenarioTypes";

// Regression: stopping a scenario while its auto-meter node is waiting out
// `maxTime` must (a) stop the auto-meter immediately and (b) never let the
// flow advance to the downstream node. Before the fix, stop() neither aborted
// the maxTime wait nor stopped the scheduler, so `maxTime` seconds later the
// node "completed" and a stale "Stop Transaction" fired — ending an unrelated
// charge that had since started on the same connector.
function autoMeterThenStopScenario(): ScenarioDefinition {
  return {
    id: "stop-during-auto-meter",
    name: "Stop during auto-meter",
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
        id: "auto-meter",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 100 },
        data: {
          label: "Auto MeterValue",
          value: 0,
          sendMessage: false,
          autoIncrement: true,
          incrementInterval: 1,
          incrementAmount: 10,
          maxValue: 999999,
          maxTime: 1,
        },
      },
      {
        id: "stop-tx",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 0, y: 200 },
        data: { label: "Stop Transaction", action: "stop" },
      },
    ],
    edges: [
      { id: "e1", source: "start", target: "auto-meter" },
      { id: "e2", source: "auto-meter", target: "stop-tx" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  };
}

describe("ScenarioExecutor stop during auto-meter", () => {
  it("stops the auto-meter promptly and does not advance to the downstream node", async () => {
    const onStartAutoMeterValue = vi.fn();
    const onStopAutoMeterValue = vi.fn();
    const onStopTransaction = vi.fn(async () => {});

    const executor = new ScenarioExecutor(autoMeterThenStopScenario(), {
      onStartAutoMeterValue,
      onStopAutoMeterValue,
      onStopTransaction,
    });

    const execution = executor.start();

    // Let the flow reach the auto-meter node and begin its maxTime wait.
    await new Promise((r) => setTimeout(r, 50));
    expect(onStartAutoMeterValue).toHaveBeenCalledTimes(1);
    expect(onStopTransaction).not.toHaveBeenCalled();

    // Stop mid-wait: the auto-meter must be cancelled now, not after maxTime.
    executor.stop();
    expect(onStopAutoMeterValue).toHaveBeenCalled();

    // Wait well past maxTime (1s) to prove the stale timer never advances.
    await new Promise((r) => setTimeout(r, 1200));
    await execution.catch(() => {});

    expect(onStopTransaction).not.toHaveBeenCalled();
  });
});

// A run's last node may leave frames still going out (a fire-and-forget
// DataTransfer queued behind another CALL): the executor waits for
// `onRunEnding` before it reports the run completed, so the transcript the
// recorder closes then holds them. A stop ends the wait.
describe("ScenarioExecutor onRunEnding", () => {
  function twoNodeScenario(): ScenarioDefinition {
    return {
      id: "run-ending",
      name: "Run ending",
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
          id: "end",
          type: ScenarioNodeType.END,
          position: { x: 0, y: 100 },
          data: { label: "End" },
        },
      ],
      edges: [{ id: "e1", source: "start", target: "end" }],
    } as ScenarioDefinition;
  }

  it("does not complete before onRunEnding resolves", async () => {
    let release: () => void = () => undefined;
    const ending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = new ScenarioExecutor(twoNodeScenario(), {
      onRunEnding: () => ending,
    });
    let finished = false;
    const run = executor.start().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    release();
    await run;
    expect(finished).toBe(true);
  });

  it("stop() ends the wait", async () => {
    const executor = new ScenarioExecutor(twoNodeScenario(), {
      onRunEnding: () => new Promise<void>(() => undefined),
    });
    const run = executor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    executor.stop();
    await run;
  });
});
