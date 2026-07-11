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

function stopReasonScenario(): ScenarioDefinition {
  const now = new Date().toISOString();
  return {
    id: "test-tx-stop-reason",
    name: "transaction stop carries node stopReason",
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
        id: "tx-start",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 0, y: 100 },
        data: { label: "Start Tx", action: "start", tagId: "TC005" },
      },
      {
        id: "tx-stop",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 0, y: 200 },
        data: {
          label: "Stop Tx",
          action: "stop",
          stopReason: "EVDisconnected",
        },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 300 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "tx-start" },
      { id: "e2", source: "tx-start", target: "tx-stop" },
      { id: "e3", source: "tx-stop", target: "end-1" },
    ],
  };
}

describe("transaction stop reason (issue #110, TC_005 support)", () => {
  it("passes the node's stopReason through to the stop path", async () => {
    const cp = newChargePoint("CP-STOP-REASON");
    const connector = cp.getConnector(1)!;
    const reasons: Array<string | undefined> = [];

    // Wrap callbacks to spy on onStopTransaction's reason argument
    const baseCallbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector,
    });
    const spyCallbacks = {
      ...baseCallbacks,
      onStopTransaction: async (
        reason?: string,
        options?: Parameters<
          NonNullable<typeof baseCallbacks.onStopTransaction>
        >[1],
      ) => {
        reasons.push(reason);
        return baseCallbacks.onStopTransaction?.(reason, options);
      },
    };

    const executor = new ScenarioExecutor(stopReasonScenario(), spyCallbacks);
    await timeout(executor.start(), 2000);

    expect(reasons).toContain("EVDisconnected");
  });
});
