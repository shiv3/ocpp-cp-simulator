import { describe, it, expect, vi, afterEach } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../types/OcppTypes";
import { buildSampledValues } from "../MeterValueBuilder";
import type { Transaction } from "../Transaction";

function makeConnector(): Connector {
  return new Connector(1, new Logger(LogLevel.ERROR));
}

function transaction(meterStart: number, initialSoc?: number): Transaction {
  return {
    id: 301,
    connectorId: 1,
    tagId: "TAG-CURVE",
    meterStart,
    meterStop: null,
    startTime: new Date("2026-06-28T00:00:00.000Z"),
    stopTime: null,
    meterSent: false,
    ...(initialSoc !== undefined ? { initialSoc } : {}),
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

  it("accumulates against the transaction's initialSoc, not 0%, before the first synced SoC (#301, finding 2)", () => {
    // `connector.soc` is null before the first synced meter tick — the
    // normal state right after Transaction.Begin — so accumulation must not
    // treat that as "battery at 0%" and taper (or not taper) for the wrong
    // reason.
    vi.useFakeTimers();
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      maxChargingPowerKw: 100,
      chargingCurve: [
        { socPercent: 0, powerFraction: 1 },
        { socPercent: 90, powerFraction: 0 },
        { socPercent: 100, powerFraction: 0 },
      ],
    };
    connector.socMeterSyncEnabled = false;
    connector.status = OCPPStatus.Charging;
    // Never synced — connector.soc stays null. Only the transaction's own
    // initialSoc (95%, past the curve's zero-acceptance point) says the
    // battery is nearly full.
    connector.beginTransaction(transaction(0, 95));

    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 10_000,
    });

    vi.advanceTimersByTime(5_000);

    expect(connector.meterValue).toBe(0);
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

describe("a tapering curve still advances the register (#301)", () => {
  /**
   * A curve-derived cap below 1800 W delivers under 0.5 Wh in a 1-second
   * tick. `Connector.applyMeterValue` rounds the register to an integer watt-
   * hour, so without carrying the remainder between ticks that energy is
   * destroyed rather than deferred and the meter — and the SoC derived from
   * it — never move again, while `Power.Active.Import` keeps reporting real
   * power. These tests watch the register over many ticks; a single-tick
   * assertion would pass with the bug present.
   */
  function taperingConnector(): Connector {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      // 10 kW ceiling × 0.1 acceptance at 50% = 1000 W, well under the
      // 1800 W where a 1-second tick still reaches 0.5 Wh.
      maxChargingPowerKw: 10,
      chargingCurve: [
        { socPercent: 0, powerFraction: 0.1 },
        { socPercent: 100, powerFraction: 0.1 },
      ],
    };
    connector.socMeterSyncEnabled = false;
    connector.soc = 50;
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));
    return connector;
  }

  it("advances under an increment strategy at 1000 W (0.28 Wh per tick)", () => {
    vi.useFakeTimers();
    const connector = taperingConnector();
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 10_000, // the curve, not the scenario, is the cap
    });

    // 1000 W for 36 s = 10 Wh, delivered 0.2778 Wh at a time.
    vi.advanceTimersByTime(36_000);
    expect(connector.meterValue).toBe(10);

    // Half as long, half the energy — it climbs steadily rather than
    // jumping once and sticking.
    vi.advanceTimersByTime(36_000);
    expect(connector.meterValue).toBe(20);

    // And the power the same tick reports is the power that produced it.
    const samples = buildSampledValues(
      connector,
      ["Power.Active.Import"],
      "Sample.Periodic",
    );
    expect(
      samples.find((s) => s.measurand === "Power.Active.Import")?.value,
    ).toBe("1000");
  });

  it("advances under a curve strategy whose per-tick delta the cap clamps below 0.5 Wh", () => {
    vi.useFakeTimers();
    const connector = taperingConnector();
    connector.startManualMeterStrategy({
      kind: "curve",
      config: {
        enabled: true,
        // 50 kWh over an hour — an ideal trajectory far above what the
        // battery accepts, so the curve-derived cap clamps every tick.
        curvePoints: [
          { time: 0, value: 0 },
          { time: 3600, value: 50 },
        ],
        intervalSeconds: 1,
        autoCalculateInterval: false,
      },
    });

    vi.advanceTimersByTime(36_000);
    expect(connector.meterValue).toBe(10);
    vi.advanceTimersByTime(36_000);
    expect(connector.meterValue).toBe(20);
  });

  it("advances for a sub-0.5 Wh increment with no curve or profile involved", () => {
    // Same rounding trap, reachable from a scenario alone: 0.3 Wh a second.
    vi.useFakeTimers();
    const connector = makeConnector();
    connector.socMeterSyncEnabled = false;
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 0.3,
    });

    vi.advanceTimersByTime(10_000);
    expect(connector.meterValue).toBe(3);
  });

  it("keeps the register integral, so meterStop never carries a fraction", () => {
    vi.useFakeTimers();
    const connector = taperingConnector();
    const seen: number[] = [];
    connector.events.on("meterValueChange", ({ meterValue }) =>
      seen.push(meterValue),
    );
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 10_000,
    });
    vi.advanceTimersByTime(10_000);

    expect(seen.length).toBeGreaterThan(0);
    for (const value of seen) expect(Number.isInteger(value)).toBe(true);
  });
});
