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
  it("clears armed overrides when scenario completes", async () => {
    const cp = newChargePoint("CP-OVERRIDE-NODE");
    const connector = cp.getConnector(1)!;
    const executor = new ScenarioExecutor(
      overrideScenario(),
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    await timeout(executor.start(), 1000);

    // After completion, the override should be cleared
    expect(cp.consumeResponseOverride("RemoteStartTransaction")).toBeNull();
  });

  it("clears armed overrides when scenario is stopped", async () => {
    const cp = newChargePoint("CP-OVERRIDE-STOP");
    const connector = cp.getConnector(1)!;
    const parkedScenario: ScenarioDefinition = {
      id: "test-response-override-parked",
      name: "responseOverride armed, then parked",
      targetType: "connector",
      targetId: 1,
      trigger: { type: "manual" },
      defaultExecutionMode: "oneshot",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
            label: "Arm override",
            action: "RemoteStartTransaction",
            status: "Rejected",
          },
        },
        {
          id: "park",
          type: ScenarioNodeType.CSMS_CALL_TRIGGER,
          position: { x: 0, y: 200 },
          data: {
            label: "Wait for RemoteStopTransaction",
            action: "RemoteStopTransaction",
            timeout: 30,
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
        { id: "e1", source: "start-1", target: "arm-override" },
        { id: "e2", source: "arm-override", target: "park" },
        { id: "e3", source: "park", target: "end-1" },
      ],
    };

    const executor = new ScenarioExecutor(
      parkedScenario,
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    const startPromise = executor.start();

    // Give the executor time to arm the override and reach the parked state
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Stop the scenario while parked (the override is armed)
    executor.stop();

    // Wait for the start promise to resolve
    await timeout(startPromise, 1000);

    // After stop, the executor's finally block should have cleared the armed override
    expect(cp.consumeResponseOverride("RemoteStartTransaction")).toBeNull();
  });
});
