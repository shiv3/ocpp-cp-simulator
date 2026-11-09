import { describe, expect, it } from "vitest";
import { VehicleBehaviorEngine } from "../VehicleBehaviorEngine";
import {
  evaluateVehicleBehavior,
  inDailyWindow,
  startVehicleSession,
} from "../evaluate";
import {
  resolveVehicleBehaviorConfig,
  vehicleBehaviorConfigProblem,
} from "../config";
import { VEHICLE_BEHAVIOR_PRESETS } from "../presets";
import type { VehicleBehaviorSpec, VehicleProfile } from "../contracts";

const MIN = 60_000;
const profile: VehicleProfile = {
  maxPowerW: 11_000,
  batteryCapacityWh: 60_000,
};
const T0 = Date.UTC(2026, 0, 1, 18, 0, 0);
const at = (spec: VehicleBehaviorSpec, ms: number, soc = 20, wh = 0) =>
  evaluateVehicleBehavior(
    spec,
    profile,
    startVehicleSession(T0),
    { soc, deliveredWh: wh },
    T0 + ms,
  );

describe("immediate", () => {
  const spec: VehicleBehaviorSpec = { policy: { type: "immediate" } };
  it("asks for the vehicle ceiling from the plug-in", () => {
    const s = at(spec, 0);
    expect(s.phase).toBe("charging");
    expect(s.demand).toMatchObject({
      requestedPowerW: 11_000,
      readyToCharge: true,
    });
  });
  it("reports the objective but keeps asking", () => {
    const s = at({ ...spec, intent: { targetSoc: 80 } }, MIN, 90);
    expect(s.objective.status).toBe("met");
    expect(s.demand.readyToCharge).toBe(true);
  });
  it("has no limit of its own for a profile without a ceiling", () => {
    const s = evaluateVehicleBehavior(
      spec,
      {},
      startVehicleSession(T0),
      { soc: null, deliveredWh: 0 },
      T0,
    );
    expect(s.demand.requestedPowerW).toBe(Infinity);
  });
});

describe("delayed", () => {
  const spec: VehicleBehaviorSpec = {
    policy: { type: "delayed", delayMs: 4 * 60 * MIN },
  };
  it("connects and waits, then asks (the 18:00 / 22:00 example)", () => {
    expect(at(spec, 0)).toMatchObject({
      phase: "waiting",
      demand: {
        readyToCharge: false,
        requestedPowerW: 0,
        reason: "delayed-start",
      },
    });
    expect(at(spec, 4 * 60 * MIN - 1).phase).toBe("waiting");
    expect(at(spec, 4 * 60 * MIN).phase).toBe("charging");
  });
});

describe("target-soc", () => {
  const spec: VehicleBehaviorSpec = {
    policy: { type: "target-soc" },
    intent: { targetSoc: 80 },
  };
  it("stops the demand at the target without asking to end the session", () => {
    const s = at(spec, 10 * MIN, 80);
    expect(s.phase).toBe("complete");
    expect(s.demand).toMatchObject({
      readyToCharge: false,
      requestedPowerW: 0,
      stopRequested: false,
    });
  });
  it("asks to end the session only with stopWhenDone", () => {
    expect(
      at({ ...spec, stopWhenDone: true }, MIN, 85).demand.stopRequested,
    ).toBe(true);
  });
  it("completes on requested energy too", () => {
    const s = at(
      { policy: { type: "target-soc" }, intent: { requestedEnergyWh: 5000 } },
      MIN,
      30,
      5000,
    );
    expect(s.phase).toBe("complete");
    expect(s.objective).toMatchObject({ status: "met", remainingWh: 0 });
  });
});

describe("departure", () => {
  const spec: VehicleBehaviorSpec = {
    policy: { type: "target-soc" },
    intent: { targetSoc: 80, departureAt: T0 + 13 * 60 * MIN },
  };
  it("target reached before departure", () => {
    expect(at(spec, 5 * 60 * MIN, 80).objective.status).toBe("met");
  });
  it("target not reached before departure exposes the unmet objective", () => {
    const s = at(spec, 13 * 60 * MIN, 62);
    expect(s.phase).toBe("departed");
    expect(s.objective).toMatchObject({ status: "unmet", remainingSoc: 18 });
    expect(s.demand.readyToCharge).toBe(false);
  });
  it("is pending before the departure time", () => {
    expect(at(spec, 12 * 60 * MIN, 62).objective.status).toBe("pending");
  });
});

describe("manual-suspend", () => {
  const spec: VehicleBehaviorSpec = {
    policy: {
      type: "manual-suspend",
      pauses: [{ afterMs: 5 * MIN, durationMs: 2 * MIN }],
    },
  };
  it("pauses and resumes on its own", () => {
    expect(at(spec, 4 * MIN).demand.readyToCharge).toBe(true);
    const paused = at(spec, 5 * MIN);
    expect(paused.phase).toBe("suspended");
    expect(paused.demand.readyToCharge).toBe(false);
    expect(at(spec, 7 * MIN).phase).toBe("charging");
  });
});

describe("demand-steps", () => {
  const spec = VEHICLE_BEHAVIOR_PRESETS["demand-dip"];
  it("reduces and restores the demand without leaving the charging phase", () => {
    expect(at(spec, 4 * MIN).demand.requestedPowerW).toBe(11_000);
    const dipped = at(spec, 6 * MIN);
    expect(dipped.demand).toMatchObject({
      requestedPowerW: 3700,
      readyToCharge: true,
      reason: "demand-reduced",
    });
    expect(at(spec, 10 * MIN).demand.requestedPowerW).toBe(11_000);
  });
  it("a step above the vehicle ceiling cannot raise it", () => {
    const s = at(
      {
        policy: {
          type: "demand-steps",
          steps: [{ afterMs: 0, maxPowerW: 50_000 }],
        },
      },
      0,
    );
    expect(s.demand.requestedPowerW).toBe(11_000);
  });
  it("zero watts is a request for nothing, not a disconnect", () => {
    const s = at(
      {
        policy: { type: "demand-steps", steps: [{ afterMs: 0, maxPowerW: 0 }] },
      },
      0,
    );
    expect(s.demand).toMatchObject({ requestedPowerW: 0, readyToCharge: true });
  });
});

describe("scheduled-window", () => {
  const spec = VEHICLE_BEHAVIOR_PRESETS.overnight;
  it("wraps over midnight", () => {
    expect(inDailyWindow({ startMinute: 1320, endMinute: 420 }, 1380)).toBe(
      true,
    );
    expect(inDailyWindow({ startMinute: 1320, endMinute: 420 }, 60)).toBe(true);
    expect(inDailyWindow({ startMinute: 1320, endMinute: 420 }, 600)).toBe(
      false,
    );
  });
  it("connects at 18:00 and starts at 22:00", () => {
    expect(at(spec, 0).demand.reason).toBe("outside-window");
    expect(at(spec, 4 * 60 * MIN - 1).phase).toBe("waiting");
    expect(at(spec, 4 * 60 * MIN).phase).toBe("charging");
  });
  it("honours a UTC offset", () => {
    const tokyo: VehicleBehaviorSpec = {
      policy: {
        ...spec.policy,
        utcOffsetMinutes: 540,
      } as VehicleBehaviorSpec["policy"],
    };
    // 18:00 UTC is 03:00 in UTC+9: inside the 22:00-07:00 window.
    expect(at(tokyo, 0).phase).toBe("charging");
  });
});

describe("one profile, different policies", () => {
  it("gives different demands from the same profile and instant", () => {
    const a = at({ policy: { type: "immediate" } }, MIN);
    const b = at({ policy: { type: "delayed", delayMs: 10 * MIN } }, MIN);
    expect(a.demand.readyToCharge).toBe(true);
    expect(b.demand.readyToCharge).toBe(false);
  });
});

describe("determinism", () => {
  it("replays the same session to the same snapshots", () => {
    const spec = VEHICLE_BEHAVIOR_PRESETS["ev-pause-resume"];
    const run = () => {
      let now = T0;
      const engine = new VehicleBehaviorEngine(spec, profile, () => now);
      const out = [];
      for (let i = 0; i < 12; i++) {
        out.push(engine.evaluate({ soc: 20 + i, deliveredWh: i * 100 }));
        now += MIN;
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
  it("does not mutate the session state", () => {
    const engine = new VehicleBehaviorEngine(
      { policy: { type: "immediate" } },
      profile,
      () => T0,
    );
    const before = JSON.stringify(engine.sessionState);
    engine.evaluate({ soc: 1, deliveredWh: 0 });
    expect(JSON.stringify(engine.sessionState)).toBe(before);
  });
});

describe("config", () => {
  it("resolves a preset and lets the config override it", () => {
    const spec = resolveVehicleBehaviorConfig({
      preset: "target-soc",
      intent: { targetSoc: 70 },
      stopWhenDone: true,
    });
    expect(spec).toEqual({
      policy: { type: "target-soc" },
      intent: { targetSoc: 70 },
      stopWhenDone: true,
    });
    expect(resolveVehicleBehaviorConfig(null)).toBeNull();
    expect(resolveVehicleBehaviorConfig({})).toBeNull();
  });
  it("names the problem of a bad config", () => {
    expect(vehicleBehaviorConfigProblem({ preset: "nope" })).toMatch(/preset/);
    expect(vehicleBehaviorConfigProblem({})).toMatch(/preset or a policy/);
    expect(
      vehicleBehaviorConfigProblem({ policy: { type: "delayed" } }),
    ).toMatch(/delayMs/);
    expect(
      vehicleBehaviorConfigProblem({
        preset: "immediate",
        intent: { targetSoc: 120 },
      }),
    ).toMatch(/targetSoc/);
    expect(vehicleBehaviorConfigProblem({ preset: "overnight" })).toBeNull();
  });
});
