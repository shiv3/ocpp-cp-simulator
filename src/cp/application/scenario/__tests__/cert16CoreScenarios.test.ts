import { describe, expect, it } from "vitest";

import { ScenarioExecutor } from "../ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { getTemplateById } from "../../../../utils/scenarioTemplates";

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

describe("cert16 Core certification scenarios with csmsCallTrigger and responseOverride", () => {
  it("TC_013 Hard Reset: parks on csmsCallTrigger, then completes when Reset arrives", async () => {
    const template = getTemplateById("cert16-tc013-hard-reset");
    expect(template).toBeDefined();

    const cp = newChargePoint("CP-CERT-TC013");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const scenario = template!.createScenario("CP-CERT-TC013", 1);
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector: connector!,
    });
    const executor = new ScenarioExecutor(scenario, callbacks);
    const execution = executor.start();

    try {
      // Wait for the csmsCallTrigger node to attach its listener — the scenario
      // is parked waiting for the incoming Reset call
      await waitUntil(
        () => cp.events.listenerCount("incomingCallReceived") > 0,
        3000,
      );

      // Simulate the CSMS issuing Reset.req
      cp.notifyIncomingCall("Reset", { type: "Hard" });

      // Execution should complete after the Reset is received
      await timeout(execution, 3000);
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });

  it("TC_026 Remote Start — Rejected: arms override, parks on trigger, override clears after completion", async () => {
    const template = getTemplateById("cert16-tc026-remote-start-rejected");
    expect(template).toBeDefined();

    const cp = newChargePoint("CP-CERT-TC026");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const scenario = template!.createScenario("CP-CERT-TC026", 1);
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector: connector!,
    });
    const executor = new ScenarioExecutor(scenario, callbacks);
    const execution = executor.start();

    try {
      // After the responseOverride node runs, it's armed. Then the csmsCallTrigger
      // parks. We wait for the trigger to be ready (listenerCount > 0 means both
      // responseOverride has armed and csmsCallTrigger is listening).
      await waitUntil(
        () => cp.events.listenerCount("incomingCallReceived") > 0,
        3000,
      );

      // Prove the responseOverride node actually armed before the trigger
      // dispatches — a non-vacuous check that the arm happened, not just
      // that the trigger is listening.
      expect(cp.hasResponseOverride("RemoteStartTransaction")).toBe(true);

      // Simulate the CSMS issuing RemoteStartTransaction.req — this will be rejected
      // by the armed override instead of proceeding normally
      cp.notifyIncomingCall("RemoteStartTransaction", {
        connectorId: 1,
        idTag: "TEST",
      });

      // Execution should complete after the RemoteStartTransaction is received
      // and rejected by the override (delay is 3s + overhead)
      await timeout(execution, 5000);

      // After completion, the override should be cleared (end-of-run cleanup per Task 1)
      // Scope note: armed-before-dispatch is asserted above via hasResponseOverride.
      // This pins end-of-run cleanup (the executor clears armed overrides in its
      // finally block whether or not a dispatch consumed them). The actual
      // override-intercepts-the-handler semantics (dispatch consumption) are
      // proven at the dispatch layer in handleCallOverride.test.ts; this
      // test's main value is that TC_026's node graph runs to completion.
      expect(cp.consumeResponseOverride("RemoteStartTransaction")).toBeNull();
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });
});
