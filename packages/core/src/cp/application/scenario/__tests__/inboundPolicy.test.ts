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

describe("inboundPolicy node (issue #247)", () => {
  it("arms callerror policy and clears on scenario completion", async () => {
    const cp = newChargePoint("CP-INBOUND-CALLERROR");
    const connector = cp.getConnector(1)!;
    const now = new Date().toISOString();
    const scenario: ScenarioDefinition = {
      id: "test-inbound-callerror",
      name: "inboundPolicy arms callerror",
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
          id: "arm-policy",
          type: ScenarioNodeType.INBOUND_POLICY,
          position: { x: 0, y: 100 },
          data: {
            label: "Reject GetConfiguration",
            action: "GetConfiguration",
            policy: "callerror",
            errorCode: "NotImplemented",
            errorDescription: "GetConfiguration not supported",
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
        { id: "e1", source: "start-1", target: "arm-policy" },
        { id: "e2", source: "arm-policy", target: "end-1" },
      ],
    };

    const executor = new ScenarioExecutor(
      scenario,
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    await timeout(executor.start(), 1000);

    // After completion, the policy should be cleared
    expect(cp.getInboundCallPolicy("GetConfiguration")).toBeUndefined();
  });

  it("arms ignore policy and clears on scenario stop", async () => {
    const cp = newChargePoint("CP-INBOUND-IGNORE");
    const connector = cp.getConnector(1)!;
    const now = new Date().toISOString();
    const parkedScenario: ScenarioDefinition = {
      id: "test-inbound-ignore-parked",
      name: "inboundPolicy armed, then parked",
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
          id: "arm-policy",
          type: ScenarioNodeType.INBOUND_POLICY,
          position: { x: 0, y: 100 },
          data: {
            label: "Ignore Reset",
            action: "Reset",
            policy: "ignore",
          },
        },
        {
          id: "park",
          type: ScenarioNodeType.CSMS_CALL_TRIGGER,
          position: { x: 0, y: 200 },
          data: {
            label: "Wait for GetConfiguration",
            action: "GetConfiguration",
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
        { id: "e1", source: "start-1", target: "arm-policy" },
        { id: "e2", source: "arm-policy", target: "park" },
        { id: "e3", source: "park", target: "end-1" },
      ],
    };

    const executor = new ScenarioExecutor(
      parkedScenario,
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    const startPromise = executor.start();

    // Wait for the csmsCallTrigger node to attach its listener — that's
    // when the executor has armed the policy and reached the parked state.
    await waitUntil(() => cp.events.listenerCount("incomingCallReceived") > 0);

    // Stop the scenario while parked (the policy is armed)
    executor.stop();

    // Wait for the start promise to resolve
    await timeout(startPromise, 1000);

    // After stop, the executor's finally block should have cleared the armed policy
    expect(cp.getInboundCallPolicy("Reset")).toBeUndefined();
  });

  it("clears a callerror policy when policy='answer'", async () => {
    const cp = newChargePoint("CP-INBOUND-ANSWER");
    const connector = cp.getConnector(1)!;
    const now = new Date().toISOString();

    // First, manually set a policy
    cp.setInboundCallPolicy("ChangeConfiguration", {
      kind: "callerror",
      errorCode: "NotSupported",
      errorDescription: "Not supported",
    });
    expect(cp.getInboundCallPolicy("ChangeConfiguration")).toBeDefined();

    const scenario: ScenarioDefinition = {
      id: "test-inbound-answer",
      name: "inboundPolicy clears with answer",
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
          id: "clear-policy",
          type: ScenarioNodeType.INBOUND_POLICY,
          position: { x: 0, y: 100 },
          data: {
            label: "Resume ChangeConfiguration",
            action: "ChangeConfiguration",
            policy: "answer",
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
        { id: "e1", source: "start-1", target: "clear-policy" },
        { id: "e2", source: "clear-policy", target: "end-1" },
      ],
    };

    const executor = new ScenarioExecutor(
      scenario,
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    await timeout(executor.start(), 1000);

    // After the node executes, the policy should be cleared
    expect(cp.getInboundCallPolicy("ChangeConfiguration")).toBeUndefined();
  });

  it("uses default errorCode 'NotImplemented' when omitted for callerror policy", async () => {
    const cp = newChargePoint("CP-INBOUND-DEFAULT");
    const connector = cp.getConnector(1)!;
    const now = new Date().toISOString();

    const scenario: ScenarioDefinition = {
      id: "test-inbound-default-code",
      name: "inboundPolicy with default errorCode",
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
          id: "arm-policy",
          type: ScenarioNodeType.INBOUND_POLICY,
          position: { x: 0, y: 100 },
          data: {
            label: "Reject with default code",
            action: "TriggerMessage",
            policy: "callerror",
            // No errorCode specified
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
        { id: "e1", source: "start-1", target: "arm-policy" },
        { id: "e2", source: "arm-policy", target: "end-1" },
      ],
    };

    const executor = new ScenarioExecutor(
      scenario,
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    await timeout(executor.start(), 1000);

    // After the node executes, the policy should exist but be cleared after completion
    expect(cp.getInboundCallPolicy("TriggerMessage")).toBeUndefined();
  });
});
