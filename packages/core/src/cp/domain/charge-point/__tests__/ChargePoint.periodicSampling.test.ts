import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChargePoint } from "../ChargePoint";
import { createChargePoint } from "../../../infrastructure/charge-point/createChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import type { Transaction } from "../../connector/Transaction";

/**
 * #839 (follow-up of #722): the periodic sampler of a 1.x transaction ends
 * with its connector, and follows MeterValueSampleInterval (1.6 §9.1.19:
 * "every MeterValueSampleInterval seconds", 0 = none).
 */
function station(): ChargePoint {
  const cp = createChargePoint(
    "CP-SAMPLER",
    DefaultBootNotification,
    1,
    "ws://csms.example/ocpp",
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

const samplers = (cp: ChargePoint) =>
  (cp as unknown as { _periodicSamplers: Map<number, unknown> })
    ._periodicSamplers;

function startTransaction(cp: ChargePoint): void {
  cp.getConnector(1)!.beginTransaction({
    id: 5,
    connectorId: 1,
    tagId: "TAG",
    meterStart: 0,
    meterStop: null,
    startTime: new Date(),
    stopTime: null,
    meterSent: false,
  } as Transaction);
}

afterEach(() => vi.useRealTimers());

describe("ChargePoint periodic sampling (#839)", () => {
  it("arms a sampler for a running transaction", () => {
    const cp = station();
    startTransaction(cp);
    expect(samplers(cp).size).toBe(1);
    cp.dispose();
  });

  it("removeConnector stops the sampler of that connector", () => {
    vi.useFakeTimers();
    const cp = station();
    startTransaction(cp);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const before = vi.getTimerCount();

    cp.removeConnector(1);

    expect(samplers(cp).size).toBe(0);
    expect(vi.getTimerCount()).toBeLessThan(before);
    cp.dispose();
  });

  it("removeConnector disposes the vehicle behavior driver of that connector", () => {
    vi.useFakeTimers();
    const cp = station();
    const drivers = (cp as unknown as { _vehicleDrivers: Map<number, unknown> })
      ._vehicleDrivers;
    expect(drivers.has(1)).toBe(true);
    const dispose = vi.spyOn(drivers.get(1) as { dispose(): void }, "dispose");

    cp.removeConnector(1);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(drivers.has(1)).toBe(false);
    cp.dispose();
  });

  it("a MeterValueSampleInterval of 0 stops the running sampler; a positive value re-arms it", () => {
    const cp = station();
    startTransaction(cp);
    expect(samplers(cp).size).toBe(1);

    cp.configuration.applyChange("MeterValueSampleInterval", "0");
    expect(samplers(cp).size).toBe(0);

    cp.configuration.applyChange("MeterValueSampleInterval", "30");
    expect(samplers(cp).size).toBe(1);
    cp.dispose();
  });
});
