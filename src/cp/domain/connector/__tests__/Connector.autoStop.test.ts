import { describe, it, expect, vi, afterEach } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../types/OcppTypes";
import type { Transaction } from "../Transaction";

function transaction(meterStart: number): Transaction {
  return {
    id: 7,
    connectorId: 1,
    tagId: "TAG-SOC",
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

describe("Connector stopAtTargetSoc auto-stop (overshoot — #105)", () => {
  it("clamps the meter to the target-SoC energy when a coarse tick overshoots", () => {
    vi.useFakeTimers();
    const connector = new Connector(1, new Logger(LogLevel.ERROR));
    connector.evSettings = {
      ...connector.evSettings,
      batteryCapacityKwh: 75,
      initialSoc: 20,
      targetSoc: 80,
    };
    // Enable the target-SoC stop but keep the curve disabled so beginTransaction
    // doesn't auto-start it — we drive a deliberately coarse increment instead.
    connector.autoMeterValueConfig = {
      enabled: false,
      intervalSeconds: 1,
      curvePoints: [{ time: 0, value: 0 }],
      autoCalculateInterval: false,
      stopAtTargetSoc: true,
    };
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));

    let autoStops = 0;
    connector.events.on("autoStopRequested", () => {
      autoStops += 1;
    });

    // 20%→80% on a 75 kWh battery = 45_000 Wh. A 28_125 Wh/tick increment lands
    // at 56_250 Wh (95% SoC) on the 2nd tick — past the 80% target.
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 28_125,
    });

    vi.advanceTimersByTime(1_000); // tick 1 -> 28_125 Wh (57.5%), below target
    expect(connector.meterValue).toBe(28_125);
    expect(autoStops).toBe(0);
    expect(connector.isAutoMeterValueActive()).toBe(true);

    vi.advanceTimersByTime(1_000); // tick 2 -> 56_250 Wh (95%) -> auto-stop
    // Clamped back to exactly the target SoC instead of stranding at 95%.
    expect(connector.meterValue).toBe(45_000);
    expect(connector.soc).toBe(80);
    expect(autoStops).toBe(1);
    expect(connector.isAutoMeterValueActive()).toBe(false);
  });

  it("stops exactly at the target without clamping when a tick lands on it", () => {
    vi.useFakeTimers();
    const connector = new Connector(1, new Logger(LogLevel.ERROR));
    connector.evSettings = {
      ...connector.evSettings,
      batteryCapacityKwh: 75,
      initialSoc: 20,
      targetSoc: 80,
    };
    connector.autoMeterValueConfig = {
      enabled: false,
      intervalSeconds: 1,
      curvePoints: [{ time: 0, value: 0 }],
      autoCalculateInterval: false,
      stopAtTargetSoc: true,
    };
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction(0));

    // 15_000 Wh/tick lands exactly on 45_000 Wh (80%) on the 3rd tick.
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 15_000,
    });

    vi.advanceTimersByTime(3_000);
    expect(connector.meterValue).toBe(45_000);
    expect(connector.soc).toBe(80);
    expect(connector.isAutoMeterValueActive()).toBe(false);
  });
});
