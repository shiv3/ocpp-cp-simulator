import { describe, it, expect, vi, afterEach } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../types/OcppTypes";
import type { Transaction } from "../Transaction";
import { defaultAutoMeterValueConfig } from "../MeterValueCurve";

function makeConnector(): Connector {
  return new Connector(1, new Logger(LogLevel.ERROR));
}

function transaction(meterStart: number): Transaction {
  return {
    id: 332,
    connectorId: 1,
    tagId: "TAG-332",
    meterStart,
    meterStop: null,
    startTime: new Date("2026-09-06T00:00:00.000Z"),
    stopTime: null,
    meterSent: false,
  };
}

/**
 * Drive a session off `curvePoints` with **no charging profile in force** and
 * collect the register after every tick.
 *
 * The "no profile" part is the whole point (#332). `MeterValueScheduler`'s
 * monotonicity clamp, `Math.max(delivered, rawNext)`, lives inside its
 * `cap !== Infinity` branch, so it runs only while a profile (or an EV
 * charging curve with a configured `maxChargingPowerKw`) caps the tick. A
 * version of this test written with a profile active would pass with or
 * without the fix; the helper asserts the cap really is `Infinity` so the
 * precondition is checked rather than assumed.
 */
function registerSequence(
  curvePoints: { time: number; value: number }[],
  meterStart: number,
  ticks: number,
): number[] {
  const connector = makeConnector();
  connector.socMeterSyncEnabled = false;
  connector.status = OCPPStatus.Charging;
  connector.meterValue = meterStart;
  connector.beginTransaction(transaction(meterStart));

  expect(connector.currentScheduleLimitWatts()).toBe(Infinity);

  const seen: number[] = [connector.meterValue];
  connector.autoMeterValueConfig = {
    ...defaultAutoMeterValueConfig,
    enabled: true,
    intervalSeconds: 1,
    autoCalculateInterval: false,
    curvePoints,
  };
  for (let i = 0; i < ticks; i++) {
    vi.advanceTimersByTime(1_000);
    seen.push(connector.meterValue);
  }
  connector.stopTransaction();
  return seen;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the energy register never runs backwards on a curve (#332)", () => {
  it("holds the register instead of rewinding it on the issue's 0 → -1 kWh curve", () => {
    vi.useFakeTimers();
    // Reported sequence before the fix, at 5000 Wh with no profile:
    // [5000, 4833, 4667, 4500, 4333, 4167, 4000].
    const seen = registerSequence(
      [
        { time: 0, value: 0 },
        { time: 6, value: -1 },
      ],
      5000,
      6,
    );
    expect(seen).toEqual([5000, 5000, 5000, 5000, 5000, 5000, 5000]);
  });

  it("never decreases across a session for a descending multi-point curve", () => {
    vi.useFakeTimers();
    // Four control points, so the scheduler samples the bezier rather than a
    // straight line — the path a real editor-authored curve takes.
    const seen = registerSequence(
      [
        { time: 0, value: 0 },
        { time: 10, value: 2 },
        { time: 20, value: 0.5 },
        { time: 30, value: 1 },
      ],
      5000,
      30,
    );
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    // meterStop >= meterStart for every accepted curve.
    expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(5000);
    // And it still delivers: the curve rises before it descends.
    expect(seen[seen.length - 1]).toBeGreaterThan(5000);
  });

  it("leaves an ascending curve's trajectory untouched", () => {
    vi.useFakeTimers();
    const seen = registerSequence(
      [
        { time: 0, value: 0 },
        { time: 10, value: 1 },
      ],
      5000,
      10,
    );
    // 1 kWh delivered linearly over 10 s = 100 Wh per second.
    expect(seen).toEqual([
      5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700, 5800, 5900, 6000,
    ]);
  });

  it("warns once per corrected point, naming the connector and the point", () => {
    // The operator's only signal that the curve they configured is not the
    // one running. `makeConnector` logs at ERROR, which swallows `warn`, so
    // this case builds its own logger — a diagnostic asserted through a
    // silenced logger would pass with no diagnostic at all.
    const logger = new Logger(LogLevel.WARN);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const connector = new Connector(1, logger);
    connector.autoMeterValueConfig = {
      ...defaultAutoMeterValueConfig,
      enabled: true,
      curvePoints: [
        { time: 0, value: 0 },
        { time: 60, value: 5 },
        { time: 120, value: 3 },
      ],
    };
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0];
    expect(message).toContain("[Connector 1]");
    expect(message).toContain("auto-meter curve");
    expect(message).toContain("curvePoints[2]");
    expect(message).toContain("time 120s");
  });

  it("says nothing about a curve that is already within contract", () => {
    const logger = new Logger(LogLevel.WARN);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const connector = new Connector(1, logger);
    connector.autoMeterValueConfig = {
      ...defaultAutoMeterValueConfig,
      enabled: true,
      curvePoints: [
        { time: 0, value: 0 },
        { time: 60, value: 5 },
      ],
    };
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a non-array curvePoints through the setter, as it did before #332", () => {
    // The regression this guards: `set_auto_meter_config` validates no field
    // of the config, so `curvePoints: ""` reaches the setter. Before #332 the
    // scheduler read it as an empty curve and the register held; the first
    // cut of the normalizer threw a TypeError out of the setter instead,
    // taking the RPC — and the connector's configuration — with it.
    vi.useFakeTimers();
    const connector = makeConnector();
    connector.socMeterSyncEnabled = false;
    connector.status = OCPPStatus.Charging;
    connector.meterValue = 5000;
    connector.beginTransaction(transaction(5000));

    expect(() => {
      connector.autoMeterValueConfig = {
        ...defaultAutoMeterValueConfig,
        enabled: true,
        intervalSeconds: 1,
        curvePoints: "" as unknown as { time: number; value: number }[],
      };
    }).not.toThrow();

    expect(connector.autoMeterValueConfig.curvePoints).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(connector.meterValue).toBe(5000);
    connector.stopTransaction();
  });

  it("stores and re-emits the normalized curve, not the one that was rejected", () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    const emitted: unknown[] = [];
    connector.events.on("autoMeterValueChange", ({ config }) =>
      emitted.push(config.curvePoints),
    );
    connector.autoMeterValueConfig = {
      ...defaultAutoMeterValueConfig,
      enabled: true,
      curvePoints: [
        { time: 0, value: 0 },
        { time: 60, value: -1 },
      ],
    };
    expect(connector.autoMeterValueConfig.curvePoints).toEqual([
      { time: 0, value: 0 },
      { time: 60, value: 0 },
    ]);
    expect(emitted).toEqual([
      [
        { time: 0, value: 0 },
        { time: 60, value: 0 },
      ],
    ]);
  });
});
