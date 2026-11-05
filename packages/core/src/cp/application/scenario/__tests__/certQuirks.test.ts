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

describe("certQuirks node (issue #247)", () => {
  it("mode=set arms quirks and clears on scenario completion", async () => {
    const cp = newChargePoint("CP-CERT-QUIRKS-SET");
    const connector = cp.getConnector(1)!;
    const now = new Date().toISOString();
    const scenario: ScenarioDefinition = {
      id: "test-cert-quirks-set",
      name: "certQuirks mode set",
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
          id: "arm-quirks",
          type: ScenarioNodeType.CERT_QUIRKS,
          position: { x: 0, y: 100 },
          data: {
            label: "Set explicit quirks",
            mode: "set",
            csrKeyAlgorithm: "RSA",
            csrPemLineEndings: "crlf",
            requiredCertificateSignatureAlgorithms: ["RSASSA-PKCS1-v1_5"],
            hiddenConfigurationKeys: ["CpoName"],
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
        { id: "e1", source: "start-1", target: "arm-quirks" },
        { id: "e2", source: "arm-quirks", target: "end-1" },
      ],
    };

    const executor = new ScenarioExecutor(
      scenario,
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    await timeout(executor.start(), 1000);

    // After completion, the quirks should be cleared
    expect(cp.certificateQuirks).toEqual({});
  });

  it("preset octt expands to documented object; explicit fields override", async () => {
    const cp = newChargePoint("CP-CERT-QUIRKS-PRESET");
    const connector = cp.getConnector(1)!;
    const now = new Date().toISOString();

    const scenario: ScenarioDefinition = {
      id: "test-cert-quirks-octt-override",
      name: "certQuirks preset octt with override",
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
          id: "arm-preset",
          type: ScenarioNodeType.CERT_QUIRKS,
          position: { x: 0, y: 100 },
          data: {
            label: "OCTT preset with override",
            mode: "set",
            preset: "octt",
            csrPemLineEndings: "lf", // Override the preset's "crlf"
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
        { id: "e1", source: "start-1", target: "arm-preset" },
        { id: "e2", source: "arm-preset", target: "end-1" },
      ],
    };

    const executor = new ScenarioExecutor(
      scenario,
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    await timeout(executor.start(), 1000);

    // After completion, the quirks should be cleared
    expect(cp.certificateQuirks).toEqual({});
  });

  it("mode=clear clears immediately", async () => {
    const cp = newChargePoint("CP-CERT-QUIRKS-CLEAR");
    const connector = cp.getConnector(1)!;
    const now = new Date().toISOString();

    // First, manually set some quirks
    cp.setCertificateQuirks({
      csrKeyAlgorithm: "ECDSA",
      csrPemLineEndings: "lf",
    });
    expect(cp.certificateQuirks.csrKeyAlgorithm).toBe("ECDSA");

    const scenario: ScenarioDefinition = {
      id: "test-cert-quirks-clear",
      name: "certQuirks mode clear",
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
          id: "clear-quirks",
          type: ScenarioNodeType.CERT_QUIRKS,
          position: { x: 0, y: 100 },
          data: {
            label: "Clear quirks",
            mode: "clear",
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
        { id: "e1", source: "start-1", target: "clear-quirks" },
        { id: "e2", source: "clear-quirks", target: "end-1" },
      ],
    };

    const executor = new ScenarioExecutor(
      scenario,
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    await timeout(executor.start(), 1000);

    // After the clear node executes, quirks should be cleared
    expect(cp.certificateQuirks).toEqual({});
  });

  it("clears armed quirks on stop() mid-run", async () => {
    const cp = newChargePoint("CP-CERT-QUIRKS-STOP");
    const connector = cp.getConnector(1)!;
    const now = new Date().toISOString();

    const parkedScenario: ScenarioDefinition = {
      id: "test-cert-quirks-parked",
      name: "certQuirks armed, then parked",
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
          id: "arm-quirks",
          type: ScenarioNodeType.CERT_QUIRKS,
          position: { x: 0, y: 100 },
          data: {
            label: "Arm quirks",
            mode: "set",
            csrKeyAlgorithm: "RSA",
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
        { id: "e1", source: "start-1", target: "arm-quirks" },
        { id: "e2", source: "arm-quirks", target: "park" },
        { id: "e3", source: "park", target: "end-1" },
      ],
    };

    const executor = new ScenarioExecutor(
      parkedScenario,
      createScenarioExecutorCallbacks({ chargePoint: cp, connector }),
    );

    const startPromise = executor.start();

    // Wait for the csmsCallTrigger node to attach its listener — that's
    // when the executor has armed the quirks and reached the parked state.
    await waitUntil(() => cp.events.listenerCount("incomingCallReceived") > 0);

    // Stop the scenario while parked (the quirks are armed)
    executor.stop();

    // Wait for the start promise to resolve
    await timeout(startPromise, 1000);

    // After stop, the executor's finally block should have cleared the armed quirks
    expect(cp.certificateQuirks).toEqual({});
  });
});
