import { describe, expect, it } from "vitest";

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

function triggerScenario(action: string, timeoutSec = 0): ScenarioDefinition {
  const now = new Date().toISOString();
  return {
    id: `test-csms-call-trigger-${action}`,
    name: `csmsCallTrigger ${action}`,
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
        data: { label: `Wait for ${action}`, action, timeout: timeoutSec },
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

describe("csmsCallTrigger node (issue #110)", () => {
  it("parks until the matching incoming call arrives, ignores others", async () => {
    const cp = newChargePoint("CP-TRIG-RESET");
    const connector = cp.getConnector(1)!;
    const executor = new ScenarioExecutor(
      triggerScenario("Reset"),
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );
    const execution = executor.start();

    try {
      // parked: a non-matching action must not release it
      cp.notifyIncomingCall("GetConfiguration", {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      let done = false;
      void execution.then(() => (done = true));
      expect(done).toBe(false);

      cp.notifyIncomingCall("Reset", { type: "Hard" });
      await timeout(execution, 1000);
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });

  it("rejects when the timeout elapses without a matching call", async () => {
    const cp = newChargePoint("CP-TRIG-TIMEOUT");
    const connector = cp.getConnector(1)!;
    const errors: Error[] = [];
    const callbacks = {
      ...createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
      onError: (e: Error) => errors.push(e),
    };
    const executor = new ScenarioExecutor(
      triggerScenario("ClearCache", 1),
      callbacks,
    );

    await timeout(executor.start(), 3000);
    expect(
      errors.some((e) =>
        /Timeout waiting for CSMS call ClearCache/.test(e.message),
      ),
    ).toBe(true);
  });
});
