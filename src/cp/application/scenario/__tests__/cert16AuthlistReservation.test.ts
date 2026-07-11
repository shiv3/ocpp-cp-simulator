import { describe, expect, it } from "vitest";

import { ScenarioExecutor } from "../ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
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

describe("cert16 Authlist and Reservation certification scenarios", () => {
  it("TC_043_4 Send Local List — Full: parks on csmsCallTrigger, then completes when SendLocalList arrives", async () => {
    const template = getTemplateById("cert16-tc043-4-send-local-list-full");
    expect(template).toBeDefined();

    const cp = newChargePoint("CP-CERT-TC043-4");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const scenario = template!.createScenario("CP-CERT-TC043-4", 1);
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector: connector!,
    });
    const executor = new ScenarioExecutor(scenario, callbacks);
    const execution = executor.start();

    try {
      // Wait for the csmsCallTrigger node to attach its listener — the scenario
      // is parked waiting for the incoming SendLocalList call
      await waitUntil(
        () => cp.events.listenerCount("incomingCallReceived") > 0,
        3000,
      );

      // Simulate the CSMS issuing SendLocalList.req
      cp.notifyIncomingCall("SendLocalList", {
        listVersion: 1,
        updateType: "Full",
      });

      // Execution should complete after the SendLocalList is received
      await timeout(execution, 3000);
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });

  it("TC_048_4 Reserve Now — Rejected: arms override, parks on trigger, override clears after completion", async () => {
    const template = getTemplateById("cert16-tc048-4-reserve-now-rejected");
    expect(template).toBeDefined();

    const cp = newChargePoint("CP-CERT-TC048-4");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const scenario = template!.createScenario("CP-CERT-TC048-4", 1);
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
      expect(cp.hasResponseOverride("ReserveNow")).toBe(true);

      // Simulate the CSMS issuing ReserveNow.req — this will be rejected
      // by the armed override instead of proceeding normally
      cp.notifyIncomingCall("ReserveNow", {
        connectorId: 1,
        reservationId: 99,
        idTag: "TEST",
        expiryDate: new Date(Date.now() + 60000).toISOString(),
      });

      // Execution should complete after the ReserveNow is received
      // and rejected by the override
      await timeout(execution, 5000);

      // After completion, the override should be cleared (end-of-run cleanup per brief)
      // Scope note: armed-before-dispatch is asserted above via hasResponseOverride.
      // This pins end-of-run cleanup (the executor clears armed overrides in its
      // finally block whether or not a dispatch consumed them). The actual
      // override-intercepts-the-handler semantics (dispatch consumption) are
      // proven at the dispatch layer in handleCallOverride.test.ts; this
      // test's main value is that TC_048_4's node graph runs to completion.
      expect(cp.consumeResponseOverride("ReserveNow")).toBeNull();
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });

  it("TC_051 Cancel Reservation: waits for reservation, then cancels it and confirms Available status", async () => {
    const template = getTemplateById("cert16-tc051-cancel-reservation");
    expect(template).toBeDefined();

    const cp = newChargePoint("CP-CERT-TC051");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const scenario = template!.createScenario("CP-CERT-TC051", 1);
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector: connector!,
    });
    const executor = new ScenarioExecutor(scenario, callbacks);
    const execution = executor.start();

    try {
      // reservationTrigger polls for a reservation every 250ms. Create one
      // directly in the manager so the trigger finds it.
      const expiryDate = new Date(Date.now() + 120000); // 2 minutes from now
      cp.reservationManager.createReservation(
        1, // connectorId
        expiryDate,
        "TEST-RESERVED",
        undefined,
        42, // reservationId
      );

      // After creating the reservation, the connector status should be updated by
      // the core (or manually set by us here to simulate ReserveNow.Accepted).
      // The scenario doesn't enforce status; it just waits for the reservation
      // and then proceeds.

      // Wait for the csmsCallTrigger node to attach its listener — the scenario
      // has exited reservationTrigger (found the reservation) and is now parked
      // waiting for CancelReservation.req
      await waitUntil(
        () => cp.events.listenerCount("incomingCallReceived") > 0,
        3000,
      );

      // Simulate the CSMS issuing CancelReservation.req with the reservation ID
      // that we just created. In a real scenario with a message handler,
      // CancelReservationHandler would cancel the reservation and flip the
      // connector status back to Available. Here we simulate that by calling
      // the handler logic directly.
      cp.notifyIncomingCall("CancelReservation", { reservationId: 42 });

      // Cancel the reservation directly (what the handler would do)
      cp.reservationManager.cancelReservation(42);

      // Trigger the status change that the handler would do (what statusTrigger waits for)
      cp.updateConnectorStatus(1, OCPPStatus.Available);

      // Execution should complete after CancelReservation is received and
      // the statusTrigger detects the connector transitioning to Available
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
