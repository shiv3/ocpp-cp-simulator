import { describe, it, expect, vi, afterEach } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../types/OcppTypes";
import { buildSampledValues } from "../MeterValueBuilder";
import type { Transaction } from "../Transaction";
import {
  defaultEVSettings,
  setUserDefaultEVSettings,
  type EVSettings,
} from "../EVSettings";

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

describe("a malformed chargingCurve is discarded at every boundary (#301)", () => {
  // `src/protocol/methods.ts` validates no `evSettings` field, and scenario
  // schema validation is advisory, so these shapes reach the domain.
  const malformed = { chargingCurve: [null] } as unknown as Partial<EVSettings>;

  it("does not throw when the evSettings setter is handed a bad curve", () => {
    const connector = makeConnector();
    expect(() => {
      connector.evSettings = {
        ...connector.evSettings,
        ...malformed,
      } as EVSettings;
    }).not.toThrow();
    expect(connector.evSettings.chargingCurve).toEqual([]);
  });

  it("does not throw when the curve is not an array at all", () => {
    const connector = makeConnector();
    expect(() => {
      connector.evSettings = {
        ...connector.evSettings,
        ...({ chargingCurve: {} } as unknown as Partial<EVSettings>),
      } as EVSettings;
    }).not.toThrow();
    expect(connector.evSettings.chargingCurve).toEqual([]);
  });

  it("also survives applyEvSettingsOverride, the scenario/RPC path", () => {
    const connector = makeConnector();
    expect(() => connector.applyEvSettingsOverride(malformed)).not.toThrow();
    expect(connector.evSettings.chargingCurve).toEqual([]);
  });

  it("survives a bad curve restored into the user default, which bypasses the setter", () => {
    // `getDefaultEVSettings()` is read straight into a fresh Connector's field
    // initializer, so the `evSettings` setter's guard never runs on it. A
    // curve restored from localStorage has to be normalized on write.
    try {
      setUserDefaultEVSettings({
        ...defaultEVSettings,
        ...malformed,
      } as EVSettings);
      const connector = makeConnector();
      expect(connector.evSettings.chargingCurve).toEqual([]);
      connector.socMeterSyncEnabled = false;
      connector.soc = 50;
      connector.status = OCPPStatus.Charging;
      connector.beginTransaction(transaction(0));
      // The first meter tick evaluates the curve; a raw `[null]` throws here.
      expect(() =>
        connector.startManualMeterStrategy({
          kind: "increment",
          intervalSeconds: 1,
          incrementValue: 100,
        }),
      ).not.toThrow();
      expect(() =>
        buildSampledValues(
          connector,
          ["Power.Active.Import"],
          "Sample.Periodic",
        ),
      ).not.toThrow();
      connector.stopAutoMeterValue();
    } finally {
      setUserDefaultEVSettings(null);
    }
  });
});

describe("the curve trajectory is offset by the register it starts from (#301)", () => {
  /**
   * `Energy.Active.Import.Register` is cumulative for the life of the
   * connector — OCPP never resets it, and `StartTransaction` records
   * `meterStart` as whatever it already reads — while the bezier curve
   * describes energy delivered in one session, starting at zero. Every
   * session after the first therefore has a non-zero starting register, and a
   * curve read as an absolute value would run the register backwards
   * (uncapped) or freeze it until the curve caught up, forever once the
   * register passed the curve's maximum (capped).
   *
   * Both tests run a real first transaction so the register is non-zero
   * before the curve strategy starts; one that only ever starts at 0 passes
   * with the bug present.
   */
  function runFirstTransaction(connector: Connector): number {
    connector.socMeterSyncEnabled = false;
    connector.soc = 50;
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 10_000,
    });
    vi.advanceTimersByTime(5_000);
    connector.stopAutoMeterValue();
    connector.stopTransaction();
    return connector.meterValue;
  }

  it("keeps advancing on a second, capped session that starts from 50 kWh", () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    const startWh = runFirstTransaction(connector);
    expect(startWh).toBe(50_000);

    // Now a tapering curve: 10 kW ceiling × 0.1 = 1000 W, i.e. 0.28 Wh a
    // tick — under the 0.5 Wh the register can represent, so the carry and
    // the baseline have to work together.
    connector.evSettings = {
      ...connector.evSettings,
      maxChargingPowerKw: 10,
      chargingCurve: [
        { socPercent: 0, powerFraction: 0.1 },
        { socPercent: 100, powerFraction: 0.1 },
      ],
    };
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(startWh));
    connector.startManualMeterStrategy({
      kind: "curve",
      config: {
        enabled: true,
        curvePoints: [
          { time: 0, value: 0 },
          { time: 3600, value: 50 },
        ],
        intervalSeconds: 1,
        autoCalculateInterval: false,
      },
    });

    vi.advanceTimersByTime(36_000);
    expect(connector.meterValue).toBe(startWh + 10);
    vi.advanceTimersByTime(36_000);
    expect(connector.meterValue).toBe(startWh + 20);
  });

  it("never runs the register backwards on a second, uncapped session", () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    const startWh = runFirstTransaction(connector);

    // No curve and no charging profile: the cap is Infinity, so this is the
    // trajectory-following branch. It used to assign the curve's absolute
    // value, putting the register below `meterStart`.
    const seen: number[] = [];
    connector.events.on("meterValueChange", ({ meterValue }) =>
      seen.push(meterValue),
    );
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(startWh));
    connector.startManualMeterStrategy({
      kind: "curve",
      config: {
        enabled: true,
        curvePoints: [
          { time: 0, value: 0 },
          { time: 3600, value: 50 },
        ],
        intervalSeconds: 1,
        autoCalculateInterval: false,
      },
    });

    vi.advanceTimersByTime(10_000);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBeGreaterThanOrEqual(startWh);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
    expect(connector.meterValue).toBeGreaterThan(startWh);
  });
});

describe("a fractional maxValue still stops the auto-meter (#301)", () => {
  /**
   * The published register is an integer watt-hour, so a `maxValue` that sits
   * below the next half-watt-hour boundary is never reached by the published
   * value: 10.4 rounds to 10, every later tick caps at 10.4 and rounds to 10
   * again, and a stop condition read off the published number never fires.
   * The condition is judged on the delivered energy instead.
   */
  it("stops at a maxValue of 10.4 Wh instead of ticking forever", () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    connector.socMeterSyncEnabled = false;
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));
    const ticks: number[] = [];
    connector.events.on("meterValueChange", ({ meterValue }) =>
      ticks.push(meterValue),
    );
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 4,
      maxValue: 10.4,
    });

    // 4, 8, then clamped to 10.4 — published as 10 — and the scheduler stops
    // on that same tick, because the cap was reached in delivered energy even
    // though the published integer never reaches it.
    vi.advanceTimersByTime(60_000);
    expect(connector.isAutoMeterValueActive()).toBe(false);
    expect(connector.meterValue).toBe(10);
    expect(ticks).toEqual([4, 8, 10]);
  });

  it("still stops on an integral maxValue", () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    connector.socMeterSyncEnabled = false;
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 4,
      maxValue: 10,
    });

    vi.advanceTimersByTime(60_000);
    expect(connector.isAutoMeterValueActive()).toBe(false);
    expect(connector.meterValue).toBe(10);
  });
});

describe("a new transaction opens on its own SoC, not the last one's (#301)", () => {
  /**
   * `stopTransaction` deliberately leaves `socPercent` in place, so a
   * connector that finished at 95% still reads 95% when the next car plugs
   * in. The curve was then evaluated against that leftover for the first
   * scheduler interval of the new session — the interval that sets the
   * opening power — until the first meter tick reset it.
   */
  function taperAbove90(connector: Connector): void {
    connector.evSettings = {
      ...connector.evSettings,
      // A small battery against a large ceiling, so a handful of seconds of
      // simulated charging really does carry it past the curve's cliff.
      batteryCapacityKwh: 1,
      maxChargingPowerKw: 100,
      initialSoc: 20,
      targetSoc: 100,
      chargingCurve: [
        { socPercent: 0, powerFraction: 1 },
        { socPercent: 90, powerFraction: 1 },
        { socPercent: 90, powerFraction: 0 },
        { socPercent: 100, powerFraction: 0 },
      ],
    };
  }

  function reportedPowerW(connector: Connector): number {
    const samples = buildSampledValues(
      connector,
      ["Power.Active.Import"],
      "Sample.Periodic",
    );
    return Number(
      samples.find((s) => s.measurand === "Power.Active.Import")?.value ?? "0",
    );
  }

  it("does not taper the second session at the first session's SoC", () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    taperAbove90(connector);
    connector.status = OCPPStatus.Charging;

    // First session runs the battery up past the curve's cliff.
    connector.beginTransaction(transaction(0));
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 20_000,
    });
    vi.advanceTimersByTime(40_000);
    connector.stopAutoMeterValue();
    const endWh = connector.meterValue;
    connector.stopTransaction();
    expect(connector.soc).toBeGreaterThan(90);
    expect(reportedPowerW(connector)).toBe(0);

    // Second session on the same connector, no explicit initialSoc — the
    // normal UI and CLI path. The battery is a fresh one at 20%, so the very
    // first sample must be full power, not the previous car's taper.
    connector.beginTransaction(transaction(endWh));
    expect(connector.soc).toBe(20);
    expect(reportedPowerW(connector)).toBe(100_000);
  });

  it("keeps an explicit SoC set before the transaction starts", () => {
    // A value typed in the side panel, or handed to startTransaction as
    // initialSoc (which the ChargePoint writes through this same setter), is
    // a statement about the car plugged in now — not a leftover.
    const connector = makeConnector();
    taperAbove90(connector);
    connector.status = OCPPStatus.Charging;
    connector.soc = 95;
    connector.beginTransaction(transaction(0));
    expect(connector.soc).toBe(95);
    expect(reportedPowerW(connector)).toBe(0);
  });

  it("prefers the transaction's own initialSoc over the EV settings' one", () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    taperAbove90(connector);
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 20_000,
    });
    vi.advanceTimersByTime(40_000);
    connector.stopAutoMeterValue();
    connector.stopTransaction();

    connector.beginTransaction(transaction(connector.meterValue, 95));
    expect(connector.soc).toBe(95);
    expect(reportedPowerW(connector)).toBe(0);
  });

  it("resets the leftover even with meter/SoC sync off, where nothing else would", () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    taperAbove90(connector);
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 20_000,
    });
    vi.advanceTimersByTime(40_000);
    connector.stopAutoMeterValue();
    const endWh = connector.meterValue;
    connector.stopTransaction();
    expect(connector.soc).toBeGreaterThan(90);

    // With sync off the meter never corrects SoC, so a leftover would drive
    // the whole session, not just its first interval.
    connector.socMeterSyncEnabled = false;
    connector.beginTransaction(transaction(endWh));
    expect(connector.soc).toBe(20);
    expect(reportedPowerW(connector)).toBe(100_000);
  });
});

describe("the derived-SoC marker survives a restart (#301)", () => {
  /**
   * The marker distinguishing "synchronised during this transaction" from
   * "left over from the last one" lives on the connector, so it has to be
   * carried in the runtime snapshot too. Without it a restored meter-derived
   * SoC came back looking explicit, and the next transaction on that
   * connector opened on the previous battery's charge — the same defect,
   * reachable through persistence.
   */
  function chargedConnector(): Connector {
    vi.useFakeTimers();
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      batteryCapacityKwh: 1,
      maxChargingPowerKw: 100,
      initialSoc: 20,
      targetSoc: 100,
    };
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 20_000,
    });
    vi.advanceTimersByTime(40_000);
    connector.stopAutoMeterValue();
    return connector;
  }

  it("round-trips through snapshotRuntime and restoreRuntimeSnapshot", () => {
    const connector = chargedConnector();
    expect(connector.soc).toBeGreaterThan(20);
    const snapshot = connector.snapshotRuntime();
    expect(snapshot.socIsMeterDerived).toBe(true);

    const restored = makeConnector();
    restored.evSettings = { ...connector.evSettings };
    restored.restoreRuntimeSnapshot(snapshot);
    expect(restored.soc).toBe(snapshot.socPercent);

    // The restored transaction ends, then a new one starts with no explicit
    // SoC — the leftover must not become this session's opening charge.
    restored.stopTransaction();
    restored.beginTransaction(transaction(snapshot.meterValueWh));
    expect(restored.soc).toBe(20);
  });

  it("marks an explicitly set SoC as not meter-derived in the snapshot", () => {
    const connector = makeConnector();
    connector.soc = 62;
    const snapshot = connector.snapshotRuntime();
    expect(snapshot.socIsMeterDerived).toBe(false);

    const restored = makeConnector();
    restored.restoreRuntimeSnapshot(snapshot);
    restored.beginTransaction(transaction(0));
    expect(restored.soc).toBe(62);
  });

  it("treats a snapshot without the field as not meter-derived", () => {
    // Rows written before the v11 migration: absence means `false`, which is
    // what those daemon builds behaved as.
    const connector = makeConnector();
    const legacy = { ...connector.snapshotRuntime(), socPercent: 77 } as Omit<
      ReturnType<Connector["snapshotRuntime"]>,
      "socIsMeterDerived"
    > & { socIsMeterDerived?: boolean };
    delete legacy.socIsMeterDerived;
    connector.restoreRuntimeSnapshot(legacy);
    connector.beginTransaction(transaction(0));
    expect(connector.soc).toBe(77);
  });
});

describe("an explicit SoC belongs to one session only (#301)", () => {
  /**
   * Round 8 distinguished "derived during this transaction" from "left over".
   * An explicit SoC from a *previous* transaction is left over too, and the
   * marker did not say so: `ChargePoint.startTransaction` writes `initialSoc`
   * through the `soc` setter, so with no meter-derived update afterwards —
   * auto-metering off, or SoC sync disabled — the next transaction kept the
   * previous one's value for its whole session.
   *
   * The two are told apart by whether a transaction was active when the value
   * was written. Set while idle it is a statement about the car plugged in
   * now and belongs to the session about to start; set while a session is
   * running it belongs to that session, and `beginTransaction` claims a
   * pending value so it cannot be claimed twice.
   */
  function cliffAt90(connector: Connector): void {
    connector.evSettings = {
      ...connector.evSettings,
      batteryCapacityKwh: 1,
      maxChargingPowerKw: 100,
      initialSoc: 20,
      targetSoc: 100,
      chargingCurve: [
        { socPercent: 0, powerFraction: 1 },
        { socPercent: 90, powerFraction: 1 },
        { socPercent: 90, powerFraction: 0 },
        { socPercent: 100, powerFraction: 0 },
      ],
    };
    connector.socMeterSyncEnabled = false;
    connector.status = OCPPStatus.Charging;
  }

  function reportedPowerW(connector: Connector): number {
    return Number(
      buildSampledValues(
        connector,
        ["Power.Active.Import"],
        "Sample.Periodic",
      ).find((s) => s.measurand === "Power.Active.Import")?.value ?? "0",
    );
  }

  it("does not carry a transaction's initialSoc into the next transaction", () => {
    const connector = makeConnector();
    cliffAt90(connector);

    // Exactly what ChargePoint.startTransaction does: write the SoC, then
    // begin. No meter tick follows, because sync is off.
    connector.soc = 95;
    connector.beginTransaction(transaction(0, 95));
    expect(connector.soc).toBe(95);
    expect(reportedPowerW(connector)).toBe(0);
    connector.stopTransaction();

    // A different car, no initialSoc of its own.
    connector.beginTransaction(transaction(0));
    expect(connector.soc).toBe(20);
    expect(reportedPowerW(connector)).toBe(100_000);
  });

  it("keeps an SoC set while the connector was idle", () => {
    // The real use this must not break: type a value in the side panel, then
    // press Start.
    const connector = makeConnector();
    cliffAt90(connector);
    connector.soc = 95;
    connector.beginTransaction(transaction(0));
    expect(connector.soc).toBe(95);
    expect(reportedPowerW(connector)).toBe(0);
  });

  it("does not carry an SoC set mid-session into the next one", () => {
    const connector = makeConnector();
    cliffAt90(connector);
    connector.beginTransaction(transaction(0));
    // Set while this session is running: it describes this session's car.
    connector.soc = 95;
    expect(reportedPowerW(connector)).toBe(0);
    connector.stopTransaction();

    connector.beginTransaction(transaction(0));
    expect(connector.soc).toBe(20);
  });

  it("claims a pending SoC once, so a third transaction still resets", () => {
    const connector = makeConnector();
    cliffAt90(connector);
    connector.soc = 95;
    connector.beginTransaction(transaction(0));
    expect(connector.soc).toBe(95);
    connector.stopTransaction();
    connector.beginTransaction(transaction(0));
    expect(connector.soc).toBe(20);
    connector.stopTransaction();
    connector.beginTransaction(transaction(0));
    expect(connector.soc).toBe(20);
  });

  it("restores an explicit SoC as the restored transaction's, not the next one's", () => {
    // After a restart, an explicit SoC alongside an active transaction belongs
    // to that transaction — so the transaction after it must not inherit it.
    const source = makeConnector();
    cliffAt90(source);
    source.soc = 95;
    source.beginTransaction(transaction(0, 95));
    const snapshot = source.snapshotRuntime();
    expect(snapshot.socIsMeterDerived).toBe(false);
    expect(snapshot.transaction).not.toBeNull();

    const restored = makeConnector();
    cliffAt90(restored);
    restored.restoreRuntimeSnapshot(snapshot);
    expect(restored.soc).toBe(95);

    restored.stopTransaction();
    restored.beginTransaction(transaction(0));
    expect(restored.soc).toBe(20);
  });
});
