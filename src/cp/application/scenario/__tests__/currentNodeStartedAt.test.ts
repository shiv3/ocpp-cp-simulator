import { describe, it, expect } from "vitest";

import { ScenarioExecutor } from "../ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { ScenarioDefinition, ScenarioNodeType } from "../ScenarioTypes";

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function waitUntil(predicate: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function newChargePoint(id: string): ChargePoint {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    "ws://127.0.0.1:9/",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  cp.events.on("error", () => undefined);
  return cp;
}

function delayScenario(): ScenarioDefinition {
  const now = new Date().toISOString();
  return {
    id: "test-started-at-delay",
    name: "currentNodeStartedAt with delay",
    targetType: "connector",
    targetId: 1,
    trigger: { type: "manual" },
    defaultExecutionMode: "oneshot",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "Start", triggerOn: "connect" },
      },
      {
        id: "delay-node",
        type: ScenarioNodeType.DELAY,
        position: { x: 0, y: 100 },
        data: { label: "Delay 1s", delaySeconds: 1 },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 200 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "delay-node" },
      { id: "e2", source: "delay-node", target: "end-1" },
    ],
  };
}

function csmsCallTriggerScenario(timeoutSec = 10): ScenarioDefinition {
  const now = new Date().toISOString();
  return {
    id: "test-started-at-csms-call",
    name: "currentNodeStartedAt with CSMS call trigger",
    targetType: "connector",
    targetId: 1,
    trigger: { type: "manual" },
    defaultExecutionMode: "oneshot",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "Start", triggerOn: "connect" },
      },
      {
        id: "wait-call",
        type: ScenarioNodeType.CSMS_CALL_TRIGGER,
        position: { x: 0, y: 100 },
        data: { label: "Wait for Reset", action: "Reset", timeout: timeoutSec },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 200 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "wait-call" },
      { id: "e2", source: "wait-call", target: "end-1" },
    ],
  };
}

describe("currentNodeStartedAt field (#240)", () => {
  it("tracks when a delay node starts and clears on completion", async () => {
    const cp = newChargePoint("CP-STARTED-AT");
    const connector = cp.getConnector(1)!;
    const executor = new ScenarioExecutor(
      delayScenario(),
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    const execution = executor.start();

    try {
      // Wait for the delay node to start executing
      await waitUntil(() => {
        const ctx = executor.getContext();
        return ctx.currentNodeId === "delay-node";
      }, 1500);

      // While executing the delay, currentNodeStartedAt should be set
      const ctx = executor.getContext();
      expect(ctx.currentNodeId).toBe("delay-node");
      expect(ctx.currentNodeStartedAt).toBeDefined();
      expect(typeof ctx.currentNodeStartedAt).toBe("number");
      // currentNodeStartedAt should be within the last 5 seconds (likely within last 100ms)
      const now = Date.now();
      expect(now - (ctx.currentNodeStartedAt || 0)).toBeLessThan(5000);
      expect(now - (ctx.currentNodeStartedAt || 0)).toBeGreaterThanOrEqual(0);

      // Wait for completion
      await timeout(execution, 3000);

      // After completion, currentNodeStartedAt should be null
      const finalCtx = executor.getContext();
      expect(finalCtx.state).toBe("completed");
      expect(finalCtx.currentNodeId).toBeNull();
      expect(finalCtx.currentNodeStartedAt).toBeNull();
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });

  it("tracks when a waiting node (csmsCallTrigger) starts and clears on stop", async () => {
    const cp = newChargePoint("CP-STARTED-AT-WAIT");
    const connector = cp.getConnector(1)!;
    const executor = new ScenarioExecutor(
      csmsCallTriggerScenario(),
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    const execution = executor.start();

    try {
      // Wait for the csmsCallTrigger node to attach its listener
      await waitUntil(
        () => cp.events.listenerCount("incomingCallReceived") > 0,
        1000,
      );

      // The scenario should now be waiting on the csmsCallTrigger node
      const ctx = executor.getContext();
      expect(ctx.currentNodeId).toBe("wait-call");
      expect(ctx.state).toBe("waiting");
      expect(ctx.currentNodeStartedAt).toBeDefined();
      expect(typeof ctx.currentNodeStartedAt).toBe("number");
      // currentNodeStartedAt should be recent
      const now = Date.now();
      expect(now - (ctx.currentNodeStartedAt || 0)).toBeLessThan(1000);
      expect(now - (ctx.currentNodeStartedAt || 0)).toBeGreaterThanOrEqual(0);

      // Stop the scenario
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      );

      // After stopping, currentNodeStartedAt should be null
      const stoppedCtx = executor.getContext();
      expect(stoppedCtx.currentNodeId).toBeNull();
      expect(stoppedCtx.currentNodeStartedAt).toBeNull();
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });

  it("reports null currentNodeStartedAt when scenario is idle", () => {
    const executor = new ScenarioExecutor(delayScenario(), {});
    const ctx = executor.getContext();
    expect(ctx.state).toBe("idle");
    expect(ctx.currentNodeId).toBeNull();
    expect(ctx.currentNodeStartedAt).toBeNull();
  });
});
