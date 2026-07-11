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

describe("cert16 SmartCharging certification scenarios (TC_056–TC_067)", () => {
  it("TC_055 TriggerMessage: parks on csmsCallTrigger, receives TriggerMessage, completes with override cleared", async () => {
    const template = getTemplateById("cert16-tc054-trigger-message");
    expect(template).toBeDefined();

    const cp = newChargePoint("CP-CERT-TC055-TM");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const scenario = template!.createScenario("CP-CERT-TC055-TM", 1);
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector: connector!,
    });
    const executor = new ScenarioExecutor(scenario, callbacks);
    const execution = executor.start();

    try {
      // Wait for the csmsCallTrigger node to attach its listener — the scenario
      // is parked waiting for the incoming TriggerMessage call
      await waitUntil(
        () => cp.events.listenerCount("incomingCallReceived") > 0,
        3000,
      );

      // Simulate the CSMS issuing TriggerMessage.req
      cp.notifyIncomingCall("TriggerMessage", {
        requestedMessage: "Heartbeat",
      });

      // Execution should complete after the TriggerMessage is received
      await timeout(execution, 3000);

      // After completion, the override should be cleared (end-of-run cleanup).
      // Scope note: this only pins end-of-run cleanup (the executor clears
      // armed overrides in its finally block whether or not a dispatch
      // consumed them). The actual override-intercepts-the-handler semantics
      // are proven at the dispatch layer in handleCallOverride.test.ts; this
      // test's main value is that the scenario runs to completion.
      expect(cp.consumeResponseOverride("TriggerMessage")).toBeNull();
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });

  it("TC_066 Get Composite Schedule: parks on SetChargingProfile, then GetCompositeSchedule in sequence (two sequential parks)", async () => {
    const template = getTemplateById("cert16-tc066-get-composite-schedule");
    expect(template).toBeDefined();

    const cp = newChargePoint("CP-CERT-TC066-GCS");
    // TC_066 targets the charge point, not a connector, but we still need
    // to pass a connector to createScenarioExecutorCallbacks. We use the first connector.
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const scenario = template!.createScenario("CP-CERT-TC066-GCS", null);
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector: connector!,
    });
    const executor = new ScenarioExecutor(scenario, callbacks);
    const execution = executor.start();

    try {
      // Wait for the first csmsCallTrigger (SetChargingProfile) to be ready.
      // listenerCount > 0 indicates the node is listening for incomingCallReceived.
      await waitUntil(
        () => cp.events.listenerCount("incomingCallReceived") > 0,
        3000,
      );

      // Simulate the CSMS issuing SetChargingProfile.req with a ChargePointMaxProfile
      // on connectorId 0 (station-wide profile).
      cp.notifyIncomingCall("SetChargingProfile", {
        connectorId: 0,
        csChargingProfiles: {
          chargingProfileId: 100,
          stackLevel: 0,
          chargingProfilePurpose: "ChargePointMaxProfile",
          chargingProfileKind: "Absolute",
          chargingSchedule: {
            chargingRateUnit: "W",
            chargingSchedulePeriod: [
              {
                startPeriod: 0,
                limit: 32000,
              },
            ],
          },
        },
      });

      // The first csmsCallTrigger completes; the scenario advances to the second
      // csmsCallTrigger (GetCompositeSchedule). Between them, the listener detaches,
      // so listenerCount drops to 0 briefly, then returns to >0 when the second node
      // attaches.
      //
      // We use a generous timeout (1.5s) to capture the re-park: the listener count
      // goes to 0, then back to >0 as the second csmsCallTrigger node attaches.
      await waitUntil(
        () => cp.events.listenerCount("incomingCallReceived") > 0,
        1500,
      );

      // Simulate the CSMS issuing GetCompositeSchedule.req on connectorId 0.
      cp.notifyIncomingCall("GetCompositeSchedule", {
        connectorId: 0,
        duration: 600,
        chargingRateUnit: "W",
      });

      // Execution should complete after GetCompositeSchedule is received.
      await timeout(execution, 3000);
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });
});
