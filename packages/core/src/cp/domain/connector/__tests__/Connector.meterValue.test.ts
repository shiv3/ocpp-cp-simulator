import { describe, it, expect } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import type { Transaction } from "../Transaction";

function makeConnector(): Connector {
  return new Connector(1, new Logger(LogLevel.ERROR));
}

function transaction(meterStart: number): Transaction {
  return {
    id: 101,
    connectorId: 1,
    tagId: "TAG-SOC",
    meterStart,
    meterStop: null,
    startTime: new Date("2026-06-28T00:00:00.000Z"),
    stopTime: null,
    meterSent: false,
  };
}

describe("Connector meterValue rounding", () => {
  it("rounds a fractional meter value to an integer watt-hour", () => {
    // OCPP 1.6 register meter values (StopTransaction.meterStop, MeterValues
    // Energy.*.Register) are integer Wh. The auto-meter curve interpolates in
    // kWh and can produce a fractional Wh (e.g. 26.008333 kWh -> 26008.333 Wh).
    // A fractional meterStop is rejected by a strict CSMS with a
    // FormationViolation and silently strands the transaction in "Charging".
    const connector = makeConnector();

    connector.meterValue = 26008.333333333343;
    expect(connector.meterValue).toBe(26008);
    expect(Number.isInteger(connector.meterValue)).toBe(true);

    connector.meterValue = 73.33333333333331;
    expect(connector.meterValue).toBe(73);
    expect(Number.isInteger(connector.meterValue)).toBe(true);
  });

  it("leaves integer meter values unchanged", () => {
    const connector = makeConnector();
    connector.meterValue = 5000;
    expect(connector.meterValue).toBe(5000);
  });

  it("W2-e derives synced SoC from energy delivered since transaction start", () => {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      batteryCapacityKwh: 40,
      initialSoc: 20,
      targetSoc: 80,
    };
    connector.meterValue = 10_000;
    connector.beginTransaction(transaction(10_000));

    connector.meterValue = 10_000;
    expect(connector.soc).toBe(20);

    connector.meterValue = 12_000;
    expect(connector.soc).toBe(25);
  });
});
