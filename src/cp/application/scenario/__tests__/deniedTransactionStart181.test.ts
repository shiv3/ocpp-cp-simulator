import { describe, expect, it } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { ScenarioDefinition, ScenarioNodeType } from "../ScenarioTypes";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

/**
 * Issue #181 Task 3: a denied local-authorize gate (Task 1) must be a
 * LOGGED SKIP at the scenario layer, not a thrown error — this is what
 * makes TC_023-style graphs expressible (plugin → tx-start(bad tag) →
 * [denied, logged] → plugout → end) without the executor halting.
 *
 * Authorize is a CP→CSMS call with no live transport in this unit test
 * (see ChargePoint construction below), so the denial is driven directly
 * via the `authorizeResult` test seam — the same seam
 * AuthorizeResultHandler uses once a real Authorize.conf arrives.
 */

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
  // wsUrl points at an unused local port — no real transport connection is
  // ever attempted; AuthorizeBeforeLocalStart stays at its default (true)
  // so this test exercises the real default wiring end-to-end.
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

function deniedTxStartScenario(tagId: string): ScenarioDefinition {
  return {
    id: "w181-denied-tx-start",
    name: "w181-denied-tx-start",
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
        id: "tx-start",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 0, y: 100 },
        data: { label: "Transaction Start", action: "start", tagId },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 200 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-tx", source: "start", target: "tx-start" },
      { id: "e-tx-end", source: "tx-start", target: "end" },
    ],
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  };
}

describe("scenario continuation on a denied transaction start (#181)", () => {
  it("logs a skip and completes the scenario instead of erroring when Authorize.conf denies the tag", async () => {
    const tagId = "TC023-INVALID-TAG";
    const cp = newChargePoint("CP-W181-DENY");
    const connector = cp.getConnector(1)!;
    const scenario = deniedTxStartScenario(tagId);

    const logs: Array<{ message: string; level?: string }> = [];
    const errors: Error[] = [];
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector,
      hooks: {
        log: (message, level) => logs.push({ message, level }),
        onError: (error) => errors.push(error),
      },
    });
    const executor = new ScenarioExecutor(scenario, callbacks);
    const execution = executor.start();

    try {
      // The tx-start node is awaiting Authorize.conf — deny it via the
      // same event AuthorizeResultHandler emits for a real CALLRESULT.
      await waitUntil(() => cp.events.listenerCount("authorizeResult") > 0);
      cp.notifyAuthorizeResult(tagId, "Invalid");

      await timeout(execution, 2000);

      expect(errors).toEqual([]);
      expect(connector.transaction).toBeNull();
      expect(
        logs.some(
          (l) =>
            l.message.toLowerCase().includes("denied") && l.level === "warn",
        ),
      ).toBe(true);
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });

  it("still starts the transaction normally when Authorize.conf accepts the tag", async () => {
    const tagId = "TC023-GOOD-TAG";
    const cp = newChargePoint("CP-W181-ACCEPT");
    const connector = cp.getConnector(1)!;
    const scenario = deniedTxStartScenario(tagId);

    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector,
    });
    const executor = new ScenarioExecutor(scenario, callbacks);
    const execution = executor.start();

    try {
      await waitUntil(() => cp.events.listenerCount("authorizeResult") > 0);
      cp.notifyAuthorizeResult(tagId, "Accepted");

      await timeout(execution, 2000);

      expect(connector.transaction).not.toBeNull();
      expect(connector.transaction?.tagId).toBe(tagId);
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });
});
