import { describe, expect, it, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import {
  ScenarioDefinition,
  ScenarioEvents,
  ScenarioNode,
  ScenarioNodeData,
  ScenarioNodeType,
} from "../ScenarioTypes";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { EventEmitter } from "../../../shared/EventEmitter";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 3): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 100,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function waitForNodeComplete(
  eventEmitter: EventEmitter<ScenarioEvents>,
  nodeId: string,
  timeoutMs = 100,
): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      let off: (() => void) | null = null;
      off = eventEmitter.on("node.complete", (data) => {
        if (data.nodeId !== nodeId) return;
        off?.();
        resolve();
      });
    }),
    timeoutMs,
  );
}

function node(
  id: string,
  type: ScenarioNodeType,
  data: ScenarioNodeData,
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
  };
}

function linearScenario(
  id: string,
  middleNodes: ScenarioNode[],
): ScenarioDefinition {
  const nodes = [
    node("start", ScenarioNodeType.START, { label: "Start" }),
    ...middleNodes,
    node("end", ScenarioNodeType.END, { label: "End" }),
  ];

  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    nodes,
    edges: nodes.slice(0, -1).map((source, index) => ({
      id: `e-${source.id}`,
      source: source.id,
      target: nodes[index + 1]!.id,
    })),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  };
}

function statusTriggerScenario(id: string): ScenarioDefinition {
  return linearScenario(id, [
    node("status-trigger", ScenarioNodeType.STATUS_TRIGGER, {
      label: "Wait for Charging",
      targetStatus: OCPPStatus.Charging,
      timeout: 0,
    }),
    node("meter", ScenarioNodeType.METER_VALUE, {
      label: "Set Meter",
      value: 123,
      sendMessage: false,
    }),
  ]);
}

describe("ScenarioExecutor control flow", () => {
  it("pause then resume completes; parked-on-status-trigger reports waiting (#179)", async () => {
    const waitStarted = deferred();
    const statusGate = deferred();
    const states: string[] = [];

    const executor = new ScenarioExecutor(
      statusTriggerScenario("pause-resume"),
      {
        onWaitForStatus: vi.fn(() => {
          waitStarted.resolve();
          return statusGate.promise;
        }),
        onSetMeterValue: vi.fn(),
        onStateChange: (context) => states.push(context.state),
      },
    );

    const execution = executor.start();
    await waitStarted.promise;

    // #179: parked on the status trigger, the machine stays "running" but the
    // reported state is now "waiting" with the awaited condition surfaced.
    const parked = executor.getContext();
    expect(parked.state).toBe("waiting");
    expect(parked.expectation).toMatchObject({
      type: "connector_status",
      targetStatus: "Charging",
    });

    executor.pause();
    expect(executor.getContext().state).toBe("paused");
    executor.resume();
    // Still parked after resume → back to "waiting", not "running".
    expect(executor.getContext().state).toBe("waiting");

    statusGate.resolve();
    await execution;

    const done = executor.getContext();
    expect(done.state).toBe("completed");
    expect(done.expectation).toBeFalsy();
    expect(states).toContain("waiting");
    expect(states).toContain("paused");
    expect(states.at(-1)).toBe("completed");
  });

  it("step mode makes exactly one more node visible per step", async () => {
    const eventEmitter = new EventEmitter<ScenarioEvents>();
    const onSetMeterValue = vi.fn();
    const onNodeExecute = vi.fn();
    const executor = new ScenarioExecutor(
      linearScenario("step-mode", [
        node("meter-a", ScenarioNodeType.METER_VALUE, {
          label: "A",
          value: 100,
          sendMessage: false,
        }),
        node("meter-b", ScenarioNodeType.METER_VALUE, {
          label: "B",
          value: 200,
          sendMessage: false,
        }),
      ]),
      { onSetMeterValue, onNodeExecute },
      eventEmitter,
    );

    const execution = executor.start({ mode: "step" });

    expect(executor.getContext()).toMatchObject({
      mode: "step",
      executedNodes: [],
    });
    expect(onNodeExecute).not.toHaveBeenCalled();

    const expectedNodes = ["start", "meter-a", "meter-b", "end"];
    for (let i = 0; i < expectedNodes.length; i += 1) {
      const complete = eventEmitter.waitFor("node.complete");
      executor.step();
      await complete;

      expect(executor.getContext().executedNodes).toEqual(
        expectedNodes.slice(0, i + 1),
      );
      expect(onNodeExecute).toHaveBeenCalledTimes(i + 1);
      expect(onNodeExecute).toHaveBeenNthCalledWith(i + 1, expectedNodes[i]);
    }

    await execution;

    expect(onSetMeterValue).toHaveBeenCalledTimes(2);
    expect(executor.getContext()).toMatchObject({
      state: "completed",
      currentNodeId: null,
      executedNodes: expectedNodes,
    });
  });

  it("buffers a step issued immediately after step-mode start", async () => {
    const eventEmitter = new EventEmitter<ScenarioEvents>();
    const onNodeExecute = vi.fn();
    const executor = new ScenarioExecutor(
      linearScenario("step-immediate-start", [
        node("meter", ScenarioNodeType.METER_VALUE, {
          label: "Meter",
          value: 100,
          sendMessage: false,
        }),
      ]),
      { onSetMeterValue: vi.fn(), onNodeExecute },
      eventEmitter,
    );

    const execution = executor.start({ mode: "step" });

    const startComplete = waitForNodeComplete(eventEmitter, "start");
    executor.step();
    await startComplete;

    expect(executor.getContext().executedNodes).toEqual(["start"]);
    expect(onNodeExecute).toHaveBeenCalledTimes(1);
    expect(onNodeExecute).toHaveBeenNthCalledWith(1, "start");

    const meterComplete = waitForNodeComplete(eventEmitter, "meter");
    executor.step();
    await meterComplete;

    const endComplete = waitForNodeComplete(eventEmitter, "end");
    executor.step();
    await endComplete;
    await execution;

    expect(executor.getContext()).toMatchObject({
      state: "completed",
      executedNodes: ["start", "meter", "end"],
    });
  });

  it("buffers a next step issued synchronously from node.complete", async () => {
    const eventEmitter = new EventEmitter<ScenarioEvents>();
    const onNodeExecute = vi.fn();
    let executor: ScenarioExecutor | null = null;

    eventEmitter.on("node.complete", (data) => {
      if (data.nodeId === "start") {
        executor?.step();
      }
    });

    executor = new ScenarioExecutor(
      linearScenario("step-after-complete", [
        node("meter-a", ScenarioNodeType.METER_VALUE, {
          label: "A",
          value: 100,
          sendMessage: false,
        }),
        node("meter-b", ScenarioNodeType.METER_VALUE, {
          label: "B",
          value: 200,
          sendMessage: false,
        }),
      ]),
      { onSetMeterValue: vi.fn(), onNodeExecute },
      eventEmitter,
    );

    const execution = executor.start({ mode: "step" });
    await flushMicrotasks();

    const meterAComplete = waitForNodeComplete(eventEmitter, "meter-a");
    executor.step();
    await meterAComplete;
    await flushMicrotasks();

    expect(executor.getContext().executedNodes).toEqual(["start", "meter-a"]);
    expect(onNodeExecute).toHaveBeenCalledTimes(2);

    const meterBComplete = waitForNodeComplete(eventEmitter, "meter-b");
    executor.step();
    await meterBComplete;

    const endComplete = waitForNodeComplete(eventEmitter, "end");
    executor.step();
    await endComplete;
    await execution;

    expect(executor.getContext()).toMatchObject({
      state: "completed",
      executedNodes: ["start", "meter-a", "meter-b", "end"],
    });
  });

  it("stop unblocks a run parked at the step gate", async () => {
    const executor = new ScenarioExecutor(
      linearScenario("step-stop-parked", [
        node("meter", ScenarioNodeType.METER_VALUE, {
          label: "Meter",
          value: 100,
          sendMessage: false,
        }),
      ]),
      { onSetMeterValue: vi.fn() },
    );

    const execution = executor.start({ mode: "step" });
    await flushMicrotasks();

    expect(executor.getContext()).toMatchObject({
      state: "stepping",
      executedNodes: [],
    });

    executor.stop();
    await withTimeout(execution);

    expect(executor.getContext()).toMatchObject({
      state: "idle",
      currentNodeId: null,
      executedNodes: [],
    });
  });

  it("captures callback errors, resolves start, and does not execute downstream nodes", async () => {
    const eventEmitter = new EventEmitter<ScenarioEvents>();
    const executionErrors: string[] = [];
    eventEmitter.on("execution.error", (data) =>
      executionErrors.push(data.error),
    );

    const onSetMeterValue = vi.fn();
    const executor = new ScenarioExecutor(
      linearScenario("callback-error", [
        node("bad-status", ScenarioNodeType.STATUS_CHANGE, {
          label: "Bad Status",
          status: OCPPStatus.Charging,
        }),
        node("meter", ScenarioNodeType.METER_VALUE, {
          label: "Meter",
          value: 1,
          sendMessage: false,
        }),
      ]),
      {
        onStatusChange: vi.fn(async () => {
          throw new Error("status callback failed");
        }),
        onSetMeterValue,
      },
      eventEmitter,
    );

    await executor.start();

    expect(executor.getContext()).toMatchObject({
      state: "error",
      error: "status callback failed",
    });
    expect(executionErrors).toEqual(["status callback failed"]);
    expect(onSetMeterValue).not.toHaveBeenCalled();
  });

  it("stop mid-run returns to idle and does not emit completion", async () => {
    const waitStarted = deferred();
    const statusGate = deferred();
    const eventEmitter = new EventEmitter<ScenarioEvents>();
    const completed = vi.fn();
    eventEmitter.on("execution.completed", completed);

    const onSetMeterValue = vi.fn();
    const executor = new ScenarioExecutor(
      statusTriggerScenario("stop-mid-run"),
      {
        onWaitForStatus: vi.fn(() => {
          waitStarted.resolve();
          return statusGate.promise;
        }),
        onSetMeterValue,
      },
      eventEmitter,
    );

    const execution = executor.start();
    await waitStarted.promise;

    executor.stop();
    await execution;

    expect(executor.getContext().state).toBe("idle");
    expect(completed).not.toHaveBeenCalled();
    expect(onSetMeterValue).not.toHaveBeenCalled();
  });

  it("reports the executing currentNodeId mid-run and clears it at completion", async () => {
    const waitStarted = deferred();
    const statusGate = deferred();
    const executor = new ScenarioExecutor(
      statusTriggerScenario("current-node"),
      {
        onWaitForStatus: vi.fn(() => {
          waitStarted.resolve();
          return statusGate.promise;
        }),
        onSetMeterValue: vi.fn(),
      },
    );

    const execution = executor.start();
    await waitStarted.promise;

    expect(executor.getContext().currentNodeId).toBe("status-trigger");

    statusGate.resolve();
    await execution;

    expect(executor.getContext()).toMatchObject({
      state: "completed",
      currentNodeId: null,
    });
  });

  it("does not make the next node visible after an in-flight wait resolves while paused", async () => {
    const waitStarted = deferred();
    const statusGate = deferred();
    const eventEmitter = new EventEmitter<ScenarioEvents>();
    const statusComplete = deferred();
    eventEmitter.on("node.complete", (data) => {
      if (data.nodeId === "status-trigger") {
        statusComplete.resolve();
      }
    });
    const onSetMeterValue = vi.fn();
    const executor = new ScenarioExecutor(
      statusTriggerScenario("pause-mid-wait"),
      {
        onWaitForStatus: vi.fn(() => {
          waitStarted.resolve();
          return statusGate.promise;
        }),
        onSetMeterValue,
      },
      eventEmitter,
    );

    const execution = executor.start();
    await waitStarted.promise;
    executor.pause();

    statusGate.resolve();
    await statusComplete.promise;
    await flushMicrotasks(20);

    try {
      expect(executor.getContext().executedNodes).toEqual([
        "start",
        "status-trigger",
      ]);
      expect(onSetMeterValue).not.toHaveBeenCalled();
    } finally {
      executor.resume();
      await execution;
    }

    expect(onSetMeterValue).toHaveBeenCalledWith(123);
    expect(executor.getContext().state).toBe("completed");
  });

  it("transitions to error when a pending callback rejects while paused", async () => {
    const waitStarted = deferred();
    const statusGate = deferred();
    const eventEmitter = new EventEmitter<ScenarioEvents>();
    const executionErrors: string[] = [];
    eventEmitter.on("execution.error", (data) =>
      executionErrors.push(data.error),
    );

    const executor = new ScenarioExecutor(
      statusTriggerScenario("error-from-paused"),
      {
        onWaitForStatus: vi.fn(() => {
          waitStarted.resolve();
          return statusGate.promise;
        }),
        onSetMeterValue: vi.fn(),
      },
      eventEmitter,
    );

    const execution = executor.start();
    await waitStarted.promise;
    executor.pause();

    statusGate.reject(new Error("status wait failed while paused"));
    await execution;

    expect(executor.getContext()).toMatchObject({
      state: "error",
      error: "status wait failed while paused",
    });
    expect(executionErrors).toEqual(["status wait failed while paused"]);
  });

  it("stop interrupts an in-flight delay promptly and does not execute downstream nodes", async () => {
    const delayStarted = deferred();
    const delayGate = deferred();
    const eventEmitter = new EventEmitter<ScenarioEvents>();
    const completed = vi.fn();
    eventEmitter.on("execution.completed", completed);

    const onSetMeterValue = vi.fn();
    const executor = new ScenarioExecutor(
      linearScenario("delay-abort", [
        node("delay", ScenarioNodeType.DELAY, {
          label: "Long Delay",
          delaySeconds: 60,
        }),
        node("meter", ScenarioNodeType.METER_VALUE, {
          label: "Meter",
          value: 999,
          sendMessage: false,
        }),
      ]),
      {
        onDelay: vi.fn(() => {
          delayStarted.resolve();
          return delayGate.promise;
        }),
        onSetMeterValue,
      },
      eventEmitter,
    );

    const execution = executor.start();
    await delayStarted.promise;

    executor.stop();
    const result = await Promise.race([
      execution.then(() => "completed" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 50),
      ),
    ]);

    expect(result).toBe("completed");
    expect(executor.getContext().state).toBe("idle");
    expect(completed).not.toHaveBeenCalled();
    expect(onSetMeterValue).not.toHaveBeenCalled();
  });
});
