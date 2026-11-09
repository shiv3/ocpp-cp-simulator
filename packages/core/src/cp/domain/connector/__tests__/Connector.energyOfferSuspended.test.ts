import { afterEach, describe, expect, it, vi } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../types/OcppTypes";
import type { Transaction } from "../Transaction";

/**
 * #488 — with `StopTransactionOnEVSideDisconnect=false` an EV-side disconnect
 * keeps the transaction but stops the energy offer (2.0.1 E10). The meter
 * scheduler keeps sampling, so periodic MeterValues still go out during the
 * suspended transaction, but the energy register no longer rises.
 */

function transaction(id: number): Transaction {
  return {
    id,
    connectorId: 1,
    tagId: "TAG-488",
    meterStart: 0,
    meterStop: null,
    startTime: new Date("2026-10-29T00:00:00.000Z"),
    stopTime: null,
    meterSent: false,
  };
}

function chargingConnector(): { connector: Connector; sends: () => number } {
  const connector = new Connector(1, new Logger(LogLevel.ERROR));
  let sent = 0;
  connector.setOnMeterValueSend(() => {
    sent += 1;
  });
  connector.status = OCPPStatus.Charging;
  connector.beginTransaction(transaction(7));
  connector.startManualMeterStrategy({
    kind: "increment",
    intervalSeconds: 1,
    incrementValue: 100,
  });
  return { connector, sends: () => sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Connector energy offer suspended by an EV-side disconnect (#488)", () => {
  it("freezes the register while the scheduler keeps sending MeterValues", () => {
    vi.useFakeTimers();
    const { connector, sends } = chargingConnector();
    vi.advanceTimersByTime(1_000);
    expect(connector.meterValue).toBe(100);

    connector.suspendEnergyOffer();
    connector.status = OCPPStatus.SuspendedEV;
    const sentBefore = sends();

    vi.advanceTimersByTime(2_000);

    expect(connector.meterValue).toBe(100);
    expect(connector.energyOfferSuspended).toBe(true);
    expect(connector.isAutoMeterValueActive()).toBe(true);
    expect(sends()).toBe(sentBefore + 2);
  });

  it("releases the freeze once the connector leaves SuspendedEV", () => {
    vi.useFakeTimers();
    const { connector } = chargingConnector();
    connector.suspendEnergyOffer();
    connector.status = OCPPStatus.SuspendedEV;
    vi.advanceTimersByTime(1_000);
    expect(connector.meterValue).toBe(0);

    connector.status = OCPPStatus.Charging;
    vi.advanceTimersByTime(1_000);

    expect(connector.energyOfferSuspended).toBe(false);
    expect(connector.meterValue).toBe(100);
  });

  it("is cleared by the next transaction", () => {
    const connector = new Connector(1, new Logger(LogLevel.ERROR));
    connector.status = OCPPStatus.SuspendedEV;
    connector.suspendEnergyOffer();

    connector.beginTransaction(transaction(8));

    expect(connector.energyOfferSuspended).toBe(false);
  });
});

describe("Connector energy held after a non-Accepted id (E05.FR.02/03)", () => {
  it("freezes the register at once without an allowance and survives a status change", () => {
    vi.useFakeTimers();
    const { connector } = chargingConnector();
    vi.advanceTimersByTime(1_000);
    expect(connector.meterValue).toBe(100);

    expect(connector.holdEnergyForInvalidId(0)).toBe(true);
    connector.status = OCPPStatus.SuspendedEVSE;
    vi.advanceTimersByTime(3_000);

    expect(connector.meterValue).toBe(100);
    expect(connector.energyHeld).toBe(true);
  });

  it("delivers MaxEnergyOnInvalidId first, then holds and says so", () => {
    vi.useFakeTimers();
    const { connector } = chargingConnector();
    const exhausted = vi.fn();
    connector.events.on("invalidIdEnergyExhausted", exhausted);
    vi.advanceTimersByTime(1_000);

    expect(connector.holdEnergyForInvalidId(250)).toBe(false);
    vi.advanceTimersByTime(10_000);

    expect(connector.meterValue).toBe(350);
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(connector.energyHeld).toBe(true);
  });

  it("is cleared by the next transaction", () => {
    const { connector } = chargingConnector();
    connector.holdEnergyForInvalidId(0);
    connector.beginTransaction(transaction(9));
    expect(connector.energyHeld).toBe(false);
  });
});
