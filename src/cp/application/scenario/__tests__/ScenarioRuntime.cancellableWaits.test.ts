import { afterEach, describe, expect, it, vi } from "vitest";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { cancelIfCancellable } from "../cancellable";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";

function newChargePoint(): ChargePoint {
  const cp = new ChargePoint(
    "CP-cancellable-waits",
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

// #240: a retried wait is withdrawn and armed again, so the status and
// reservation waits must release their listener (and poll) when cancelled.
describe("ScenarioRuntime cancellable status / reservation waits (#240)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("withdraws the statusChange listener of a cancelled status wait", () => {
    const chargePoint = newChargePoint();
    const connector = chargePoint.getConnector(1)!;
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint,
      connector,
    });
    const baseline = connector.events.listenerCount("statusChange");

    const wait = callbacks.onWaitForStatus!(OCPPStatus.Charging);
    expect(connector.events.listenerCount("statusChange")).toBe(baseline + 1);

    cancelIfCancellable(wait);
    expect(connector.events.listenerCount("statusChange")).toBe(baseline);
  });

  it("withdraws the listener and the poll of a cancelled reservation wait", () => {
    vi.useFakeTimers();
    const chargePoint = newChargePoint();
    const connector = chargePoint.getConnector(1)!;
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint,
      connector,
    });
    const baseline = connector.events.listenerCount("statusChange");
    const timersBefore = vi.getTimerCount();

    const wait = callbacks.onWaitForReservation!();
    expect(connector.events.listenerCount("statusChange")).toBe(baseline + 1);
    expect(vi.getTimerCount()).toBe(timersBefore + 1);

    cancelIfCancellable(wait);
    expect(connector.events.listenerCount("statusChange")).toBe(baseline);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });
});
