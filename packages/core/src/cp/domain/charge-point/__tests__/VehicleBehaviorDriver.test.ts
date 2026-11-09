import { describe, expect, it } from "vitest";
import { Connector } from "../../connector/Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import { VirtualClock } from "../../../shared/clock";
import { OCPPStatus } from "../../types/OcppTypes";
import { VehicleBehaviorDriver } from "../VehicleBehaviorDriver";

/**
 * #835 on a virtual clock: the vehicle's pauses, resumes and demand changes
 * are a function of the clock, so a session replays exactly.
 */

function rig() {
  const clock = new VirtualClock({ start: Date.UTC(2026, 0, 1, 18, 0, 0) });
  const connector = new Connector(
    1,
    new Logger(LogLevel.ERROR),
    undefined,
    clock,
  );
  connector.socMeterSyncEnabled = false;
  connector.evSettings = {
    ...connector.evSettings,
    maxChargingPowerKw: 11,
    currentType: "AC",
    phases: 3,
    voltageV: 230,
  };
  const calls: Array<[string, boolean | undefined]> = [];
  const driver = new VehicleBehaviorDriver(
    connector,
    clock,
    {
      setReady: (_id, ready) => calls.push(["ready", ready]),
      requestStop: () => calls.push(["stop", undefined]),
    },
    1,
  );
  const begin = () => {
    connector.markEvPluggedIn();
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction({
      id: 1,
      connectorId: 1,
      tagId: "T",
      meterStart: 0,
      meterStop: null,
      startTime: new Date(clock.now()),
      stopTime: null,
      meterSent: false,
    });
  };
  return { clock, connector, driver, calls, begin };
}

describe("VehicleBehaviorDriver (#835)", () => {
  it("runs no timer and makes no call without a behavior", async () => {
    const { clock, calls, begin } = rig();
    begin();
    await clock.advanceBy(10_000);
    expect(calls).toEqual([]);
  });

  it("pauses and resumes the EV on schedule, and the demand follows", async () => {
    const { clock, connector, calls, begin } = rig();
    begin();
    connector.applyEvSettingsOverride({
      vehicleBehavior: {
        policy: {
          type: "manual-suspend",
          pauses: [{ afterMs: 5_000, durationMs: 3_000 }],
        },
      },
    });
    await clock.advanceBy(1_000);
    expect(calls.at(-1)).toEqual(["ready", true]);
    expect(connector.operatingPoint().acceptedW).toBe(11_000);
    await clock.advanceBy(4_000);
    expect(calls.at(-1)).toEqual(["ready", false]);
    expect(connector.operatingPoint().acceptedW).toBe(0);
    await clock.advanceBy(3_000);
    expect(calls.at(-1)).toEqual(["ready", true]);
    expect(connector.operatingPoint().acceptedW).toBe(11_000);
  });

  it("a dip in the vehicle's demand lowers delivery but not the offer", async () => {
    const { clock, connector, begin } = rig();
    begin();
    connector.applyEvSettingsOverride({
      vehicleBehavior: { preset: "demand-dip" },
    });
    await clock.advanceBy(6 * 60_000);
    const p = connector.operatingPoint();
    expect(p.acceptedW).toBe(3_700);
    expect(p.offeredW).toBe(11_000);
    await clock.advanceBy(5 * 60_000);
    expect(connector.operatingPoint().acceptedW).toBe(11_000);
  });

  it("counts the delay from the plug-in, before any transaction", async () => {
    const { clock, connector, calls } = rig();
    connector.markEvPluggedIn();
    connector.applyEvSettingsOverride({
      vehicleBehavior: { policy: { type: "delayed", delayMs: 4_000 } },
    });
    await clock.advanceBy(2_000);
    expect(calls.at(-1)).toEqual(["ready", false]);
    await clock.advanceBy(3_000);
    expect(calls.at(-1)).toEqual(["ready", true]);
  });

  it("asks to stop only when the vehicle wants the session over", async () => {
    const quiet = rig();
    quiet.begin();
    quiet.connector.soc = 90;
    quiet.connector.applyEvSettingsOverride({
      vehicleBehavior: { preset: "target-soc", intent: { targetSoc: 80 } },
    });
    await quiet.clock.advanceBy(2_000);
    expect(quiet.calls.some(([k]) => k === "stop")).toBe(false);
    expect(quiet.connector.vehicleSnapshot()?.phase).toBe("complete");

    const done = rig();
    done.begin();
    done.connector.soc = 90;
    done.connector.applyEvSettingsOverride({
      vehicleBehavior: {
        preset: "target-soc",
        intent: { targetSoc: 80 },
        stopWhenDone: true,
      },
    });
    await done.clock.advanceBy(2_000);
    expect(done.calls.some(([k]) => k === "stop")).toBe(true);
  });

  it("stops its timer when the behavior is removed", async () => {
    const { clock, connector, calls, begin } = rig();
    begin();
    connector.applyEvSettingsOverride({
      vehicleBehavior: { preset: "immediate" },
    });
    await clock.advanceBy(1_500);
    const seen = calls.length;
    connector.applyEvSettingsOverride({ vehicleBehavior: null });
    await clock.advanceBy(5_000);
    expect(calls.length).toBe(seen);
  });

  it("replays: the same session gives the same demand at the same instants", async () => {
    const run = async () => {
      const { clock, connector, begin } = rig();
      begin();
      connector.applyEvSettingsOverride({
        vehicleBehavior: { preset: "ev-pause-resume" },
      });
      const seen: number[] = [];
      for (let i = 0; i < 10; i++) {
        await clock.advanceBy(60_000);
        seen.push(connector.operatingPoint().acceptedW);
      }
      return seen;
    };
    expect(await run()).toEqual(await run());
  });
});
