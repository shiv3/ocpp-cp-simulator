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

function connectionScenario(
  event: "connected" | "disconnected",
  timeoutSec = 0,
): ScenarioDefinition {
  const now = new Date().toISOString();
  return {
    id: `test-connection-trigger-${event}`,
    name: `connectionTrigger ${event}`,
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
        data: { label: "Start" },
      },
      {
        id: "wait-conn",
        type: ScenarioNodeType.CONNECTION_TRIGGER,
        position: { x: 0, y: 100 },
        data: { label: `Wait ${event}`, event, timeout: timeoutSec },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 200 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "wait-conn" },
      { id: "e2", source: "wait-conn", target: "end-1" },
    ],
  };
}

describe("connectionTrigger node (issue #240)", () => {
  it("level-triggers: 'disconnected' resolves immediately on an unconnected CP", async () => {
    const cp = newChargePoint("CP-CONN-LEVEL");
    const connector = cp.getConnector(1)!;
    const executor = new ScenarioExecutor(
      connectionScenario("disconnected"),
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );
    await timeout(executor.start(), 1000); // completes without any event
  });

  it("level-triggers: 'connected' resolves immediately when already connected", async () => {
    const cp = newChargePoint("CP-CONN-LEVEL2");
    // isWebSocketConnected is a prototype getter; shadow it with an own
    // property (vi.spyOn on inherited accessors is flaky across versions).
    Object.defineProperty(cp, "isWebSocketConnected", {
      get: () => true,
      configurable: true,
    });
    const connector = cp.getConnector(1)!;
    const executor = new ScenarioExecutor(
      connectionScenario("connected"),
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );
    await timeout(executor.start(), 1000);
  });

  it("edge: parks for 'connected' and survives an intervening disconnected event", async () => {
    const cp = newChargePoint("CP-CONN-EDGE");
    const connector = cp.getConnector(1)!;
    const executor = new ScenarioExecutor(
      connectionScenario("connected"),
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );
    const execution = executor.start();
    try {
      await waitUntil(() => cp.events.listenerCount("connected") > 0);

      // The wait must NOT be killed by a disconnect — that is its point.
      cp.events.emit("disconnected", { code: 1006, reason: "test" });
      await new Promise((r) => setTimeout(r, 50));
      let done = false;
      void execution.then(() => (done = true));
      await new Promise((r) => setTimeout(r, 0));
      expect(done).toBe(false);

      cp.events.emit("connected", undefined);
      await timeout(execution, 1000);
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });

  it("edge: parks for 'disconnected' while connected, releases on the event", async () => {
    const cp = newChargePoint("CP-CONN-EDGE2");
    Object.defineProperty(cp, "isWebSocketConnected", {
      get: () => true,
      configurable: true,
    });
    const connector = cp.getConnector(1)!;
    const executor = new ScenarioExecutor(
      connectionScenario("disconnected"),
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );
    const execution = executor.start();
    try {
      await waitUntil(() => cp.events.listenerCount("disconnected") > 0);
      cp.events.emit("disconnected", { code: 1000, reason: "bye" });
      await timeout(execution, 1000);
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });

  it("rejects when the timeout elapses", async () => {
    const cp = newChargePoint("CP-CONN-TIMEOUT");
    const connector = cp.getConnector(1)!;
    const errors: Error[] = [];
    const callbacks = {
      ...createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
      onError: (e: Error) => errors.push(e),
    };
    const executor = new ScenarioExecutor(
      connectionScenario("connected", 1),
      callbacks,
    );
    await timeout(executor.start(), 3000);
    expect(
      errors.some((e) =>
        /Timeout waiting for connected \(1s\)/.test(e.message),
      ),
    ).toBe(true);
  });
});
