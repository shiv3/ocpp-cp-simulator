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

function overrideScenario(): ScenarioDefinition {
  const now = new Date().toISOString();
  return {
    id: "test-response-override",
    name: "responseOverride arms one-shot response",
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
        id: "arm-override",
        type: ScenarioNodeType.RESPONSE_OVERRIDE,
        position: { x: 0, y: 100 },
        data: {
          label: "Reject next RemoteStart",
          action: "RemoteStartTransaction",
          status: "Rejected",
        },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 200 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "arm-override" },
      { id: "e2", source: "arm-override", target: "end-1" },
    ],
  };
}

describe("responseOverride node (issue #110)", () => {
  it("arms a one-shot override on the charge point and completes", async () => {
    const cp = newChargePoint("CP-OVERRIDE-NODE");
    const connector = cp.getConnector(1)!;
    const executor = new ScenarioExecutor(
      overrideScenario(),
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    await timeout(executor.start(), 1000);

    expect(cp.consumeResponseOverride("RemoteStartTransaction")).toBe(
      "Rejected",
    );
    expect(cp.consumeResponseOverride("RemoteStartTransaction")).toBeNull();
  });
});
