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

function remotePrecedenceScenario(): ScenarioDefinition {
  const now = new Date().toISOString();
  return {
    id: "test-remote-precedence",
    name: "remote-captured reason wins over node stopReason",
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
        data: { label: "Start Tx", action: "start", tagId: "TC-PREC" },
      },
      {
        id: "remote-stop-trigger",
        type: ScenarioNodeType.REMOTE_STOP_TRIGGER,
        position: { x: 0, y: 200 },
        data: { label: "Wait for Remote Stop", timeout: 0 },
      },
      {
        id: "tx-stop",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 0, y: 300 },
        data: {
          label: "Stop Tx",
          action: "stop",
          stopReason: "PowerLoss",
        },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 400 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "tx-start" },
      { id: "e2", source: "tx-start", target: "remote-stop-trigger" },
      { id: "e3", source: "remote-stop-trigger", target: "tx-stop" },
      { id: "e4", source: "tx-stop", target: "end-1" },
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

  it("remote-captured reason wins over node stopReason", async () => {
    const cp = newChargePoint("CP-REMOTE-PREC");
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

    const executor = new ScenarioExecutor(
      remotePrecedenceScenario(),
      spyCallbacks,
    );
    const executorPromise = executor.start();

    // Wait until transaction is started so we can capture its ID
    await waitUntil(() => connector.transaction !== null, 1000);
    const txId = connector.transaction!.id;

    // Wait until the remote stop trigger has parked and is ready to receive the remote stop
    await waitUntil(() => cp.isScenarioStopHandled(1), 1000);

    // Fire the CSMS remote stop
    cp.notifyRemoteStopReceived(1, txId);

    // Wait for executor to complete
    await timeout(executorPromise, 2000);

    // Verify that the remote reason wins over the node's stopReason
    expect(reasons).toContain("Remote");
    expect(reasons).not.toContain("PowerLoss");
  });
});
