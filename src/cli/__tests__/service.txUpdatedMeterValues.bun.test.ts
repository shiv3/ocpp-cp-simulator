import { describe, expect, it, spyOn } from "bun:test";

import { CLIChargePointService } from "../service";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { testCpInit } from "./testCpInit";

/**
 * #347: the `txUpdatedMeterValues` option reaches the charge point, shows in
 * the status snapshot, and the meter-value scheduler of every connector goes
 * through `sendScheduledMeterValue` — the one entry point that honours it.
 */
function chargePointOf(svc: CLIChargePointService): ChargePoint {
  return (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
}

/** Fires the connector's scheduler callback, as a scheduler tick does. */
function schedulerTick(cp: ChargePoint, connectorId: number): void {
  const connector = cp.getConnector(connectorId) as unknown as {
    onMeterSend: ((id: number) => void) | null;
  };
  expect(connector.onMeterSend).toBeFunction();
  connector.onMeterSend!(connectorId);
}

describe("CLIChargePointService txUpdatedMeterValues (#347)", () => {
  it("is off unless asked for", () => {
    const svc = new CLIChargePointService(
      testCpInit({ cpId: "CP347-default", ocppVersion: "OCPP-2.0.1" }),
    );
    expect(chargePointOf(svc).txUpdatedMeterValues).toBe(false);
    expect(svc.getStatus().config?.txUpdatedMeterValues).toBeUndefined();
  });

  it("turns it on and routes scheduler ticks through sendScheduledMeterValue", () => {
    const svc = new CLIChargePointService(
      testCpInit({
        cpId: "CP347-on",
        ocppVersion: "OCPP-2.0.1",
        connectors: 2,
        txUpdatedMeterValues: true,
      }),
    );
    const cp = chargePointOf(svc);
    expect(cp.txUpdatedMeterValues).toBe(true);
    expect(svc.getStatus().config?.txUpdatedMeterValues).toBe(true);

    const scheduled = spyOn(cp, "sendScheduledMeterValue").mockImplementation(
      () => undefined,
    );
    const plain = spyOn(cp, "sendMeterValue").mockImplementation(
      () => undefined,
    );
    schedulerTick(cp, 2);
    expect(scheduled).toHaveBeenCalledWith(2);
    expect(plain).not.toHaveBeenCalled();
  });
});
