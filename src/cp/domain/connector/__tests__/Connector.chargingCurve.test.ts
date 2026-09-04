import { describe, it, expect, vi, afterEach } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../types/OcppTypes";
import { buildSampledValues } from "../MeterValueBuilder";
import type { Transaction } from "../Transaction";

function makeConnector(): Connector {
  return new Connector(1, new Logger(LogLevel.ERROR));
}

function transaction(meterStart: number): Transaction {
  return {
    id: 301,
    connectorId: 1,
    tagId: "TAG-CURVE",
    meterStart,
    meterStop: null,
    startTime: new Date("2026-06-28T00:00:00.000Z"),
    stopTime: null,
    meterSent: false,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("charging curve controls accumulation, not just the report (#301, finding 1)", () => {
  it("freezes the energy register when the curve says the battery accepts nothing", () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      maxChargingPowerKw: 100,
      chargingCurve: [
        { socPercent: 0, powerFraction: 1 },
        { socPercent: 50, powerFraction: 0 },
        { socPercent: 100, powerFraction: 0 },
      ],
    };
    // Pin SoC exactly at the curve's zero-acceptance point and stop the
    // meter->SoC feedback loop from moving it as ticks land, so the test
    // isolates the curve's effect on accumulation.
    connector.socMeterSyncEnabled = false;
    connector.soc = 50;
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));

    // A large per-tick increment that would clearly move the register if the
    // curve weren't honoured.
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 10_000,
    });

    vi.advanceTimersByTime(5_000);

    expect(connector.meterValue).toBe(0);
    const samples = buildSampledValues(
      connector,
      ["Power.Active.Import", "Energy.Active.Import.Register"],
      "Sample.Periodic",
    );
    expect(
      samples.find((s) => s.measurand === "Power.Active.Import")?.value,
    ).toBe("0");
    expect(
      samples.find((s) => s.measurand === "Energy.Active.Import.Register")
        ?.value,
    ).toBe("0");
  });

  it("does not throttle below the EV ceiling when the curve is full acceptance", () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      maxChargingPowerKw: 100,
      chargingCurve: [
        { socPercent: 0, powerFraction: 1 },
        { socPercent: 100, powerFraction: 1 },
      ],
    };
    connector.socMeterSyncEnabled = false;
    connector.soc = 0;
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));

    // 100 kW ceiling = ~27.78 Wh/s; a 25 Wh/s scenario stays under it, so a
    // fully-accepting curve must let it straight through.
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 25,
    });

    vi.advanceTimersByTime(2_000);
    expect(connector.meterValue).toBe(50);
  });
});

describe("evSettings normalizes the curve at the setter boundary (#301, finding 2)", () => {
  it("sorts an out-of-order curve on write", () => {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      chargingCurve: [
        { socPercent: 80, powerFraction: 0.4 },
        { socPercent: 0, powerFraction: 1 },
        { socPercent: 100, powerFraction: 0.1 },
      ],
    };
    expect(
      connector.evSettings.chargingCurve?.map((p) => p.socPercent),
    ).toEqual([0, 80, 100]);
  });

  it("interpolates correctly below the first out-of-order point, not just returns it", () => {
    // The exact failure mode described in the finding: points ordered
    // 80, 0, 100 returning the 80% fraction for every SoC below 80.
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      maxChargingPowerKw: 150,
      chargingCurve: [
        { socPercent: 80, powerFraction: 0.4 },
        { socPercent: 0, powerFraction: 1 },
        { socPercent: 100, powerFraction: 0.1 },
      ],
    };
    connector.socMeterSyncEnabled = false;
    connector.soc = 40; // halfway from 0 (1.0) to 80 (0.4) => fraction 0.7
    connector.status = OCPPStatus.Charging;

    const samples = buildSampledValues(
      connector,
      ["Power.Active.Import"],
      "Sample.Periodic",
    );
    expect(Number(samples[0]!.value)).toBeCloseTo(150_000 * 0.7, 0);
  });

  it("also normalizes through applyEvSettingsOverride", () => {
    const connector = makeConnector();
    connector.applyEvSettingsOverride({
      chargingCurve: [
        { socPercent: 100, powerFraction: 0.1 },
        { socPercent: 0, powerFraction: 1 },
      ],
    });
    expect(
      connector.evSettings.chargingCurve?.map((p) => p.socPercent),
    ).toEqual([0, 100]);
  });
});
