import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Connector } from "../Connector";
import type { ActiveChargingProfile } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import {
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
  OCPPStatus,
} from "../../types/OcppTypes";
import { buildSampledValues } from "../MeterValueBuilder";
import type { EVSettings } from "../EVSettings";
import {
  chargerTermOf,
  resolveOperatingPoint,
  vehicleTermOf,
  type OperatingPointInputs,
} from "../OperatingPoint";

const CURVE = [
  { socPercent: 0, powerFraction: 1 },
  { socPercent: 100, powerFraction: 0.2 },
];

function profile(limitW: number, numberPhases?: number): ActiveChargingProfile {
  return {
    chargingProfileId: 327,
    connectorId: 1,
    stackLevel: 0,
    chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
    chargingProfileKind: ChargingProfileKindType.Relative,
    chargingRateUnit: ChargingRateUnitType.W,
    chargingSchedulePeriods: [
      {
        startPeriod: 0,
        limit: limitW,
        ...(numberPhases !== undefined ? { numberPhases } : {}),
      },
    ],
  };
}

function charging(
  evSettings: Partial<EVSettings>,
  limit?: ActiveChargingProfile,
): Connector {
  const connector = new Connector(1, new Logger(LogLevel.ERROR));
  connector.evSettings = {
    ...connector.evSettings,
    maxChargingPowerKw: 22,
    chargingCurve: CURVE,
    ...evSettings,
  };
  connector.socMeterSyncEnabled = false;
  connector.soc = 50;
  connector.status = OCPPStatus.Charging;
  connector.beginTransaction({
    id: 327,
    connectorId: 1,
    tagId: "T",
    meterStart: 0,
    meterStop: null,
    startTime: new Date(Date.now() - 60_000),
    stopTime: null,
    meterSent: false,
  });
  if (limit) connector.chargingProfile = limit;
  return connector;
}

const CASES: Array<[string, Partial<EVSettings>, number | undefined]> = [
  ["DC", { currentType: "DC", voltageV: 400, maxChargingPowerKw: 100 }, 50_000],
  ["single-phase AC", { currentType: "AC", phases: 1, voltageV: 230 }, 3_000],
  [
    "three-phase AC",
    { currentType: "AC", phases: 3, voltageV: 230, powerFactor: 0.9 },
    undefined,
  ],
];

describe("one operating point feeds the register and the report (#327)", () => {
  for (const [name, settings, limitW] of CASES) {
    it(`${name}: the register cap, Power.Active.Import and Current.Import agree for one tick`, () => {
      const connector = charging(
        settings,
        limitW === undefined ? undefined : profile(limitW),
      );
      const point = connector.operatingPoint();
      // The register accumulates against this cap; with a curve it is the
      // accepted power, so one tick's delta is exactly what is reported.
      expect(point.accumulationCapW).toBe(point.acceptedW);
      const deltaWh = (point.accumulationCapW * 60) / 3600;

      const samples = buildSampledValues(
        connector,
        ["Power.Active.Import", "Current.Import"],
        "Sample.Periodic",
      );
      const power = Number(
        samples.find((s) => s.measurand === "Power.Active.Import" && !s.phase)!
          .value,
      );
      const current = Number(
        samples.find((s) => s.measurand === "Current.Import" && !s.phase)!
          .value,
      );
      expect(power).toBeCloseTo(point.acceptedW, 0);
      expect((power * 60) / 3600).toBeCloseTo(deltaWh, 0);
      expect(current).toBeCloseTo(point.currentA, 1);
    });
  }

  it("a sample build is a pure read; the sender announces one crossing", () => {
    const connector = charging(
      { currentType: "AC", phases: 3, voltageV: 230 },
      profile(0),
    );
    const resolve = vi.spyOn(connector, "operatingPoint");
    const events: unknown[] = [];
    connector.events.on("scheduleLimitChange", (e) => events.push(e));
    buildSampledValues(
      connector,
      ["Power.Active.Import", "Power.Offered", "Current.Import"],
      "Sample.Periodic",
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
    connector.announceScheduleCrossingNow();
    connector.announceScheduleCrossingNow();
    expect(events).toHaveLength(1);
  });

  it("reading the operating point never announces", () => {
    const connector = charging(
      { currentType: "AC", phases: 3, voltageV: 230 },
      profile(0),
    );
    const events: unknown[] = [];
    connector.events.on("scheduleLimitChange", (e) => events.push(e));
    connector.operatingPoint();
    connector.operatingPoint();
    expect(events).toHaveLength(0);
  });

  it("the register tick announces a crossing and gets the register bound", () => {
    const connector = charging(
      { currentType: "AC", phases: 3, voltageV: 230 },
      profile(0),
    );
    const events: unknown[] = [];
    connector.events.on("scheduleLimitChange", (e) => events.push(e));
    const scheduler = (
      connector as unknown as {
        meterScheduler: {
          callbacks: { getScheduleLimitWatts: () => number };
        };
      }
    ).meterScheduler;
    const getCap = scheduler.callbacks.getScheduleLimitWatts;
    expect(getCap()).toBe(0);
    expect(getCap()).toBe(0);
    expect(events).toEqual([{ paused: true, watts: 0 }]);
  });
});

/** A fault term for a charging connector, suspended or not. */
function faultOf(energyOfferSuspended: boolean) {
  return { offering: true, energyOfferSuspended };
}

/** Inputs for a charging connector with no vehicle, schedule or fault. */
function bareInputs(
  overrides: Partial<OperatingPointInputs> = {},
): OperatingPointInputs {
  return {
    at: 0,
    charging: true,
    soc: null,
    schedule: { scheduleLimitW: Infinity, activePhases: 1 },
    vehicle: vehicleTermOf(undefined),
    session: { initialSoc: undefined },
    charger: chargerTermOf(undefined),
    meter: {},
    fault: faultOf(false),
    ...overrides,
  };
}

describe("accumulationCapW invariants (#327)", () => {
  const withCurve = (extra: Partial<EVSettings> = {}) =>
    vehicleTermOf({
      ...new Connector(1, new Logger(LogLevel.ERROR)).evSettings,
      maxChargingPowerKw: 22,
      chargingCurve: CURVE,
      ...extra,
    });

  it("charging with a curve: the register bound is the accepted power", () => {
    for (const scheduleLimitW of [Infinity, 3_000, 0]) {
      const point = resolveOperatingPoint(
        bareInputs({
          soc: 80,
          vehicle: withCurve(),
          schedule: { scheduleLimitW, activePhases: 1 },
        }),
      );
      expect(point.accumulationCapW).toBe(point.acceptedW);
    }
  });

  it("no curve: the register bound is the schedule limit (no charger cap), whatever the vehicle max", () => {
    for (const maxChargingPowerKw of [0, 22]) {
      for (const scheduleLimitW of [Infinity, 3_000]) {
        const point = resolveOperatingPoint(
          bareInputs({
            vehicle: withCurve({
              maxChargingPowerKw,
              chargingCurve: undefined,
            }),
            schedule: { scheduleLimitW, activePhases: 1 },
          }),
        );
        expect(point.accumulationCapW).toBe(scheduleLimitW);
      }
    }
  });

  it("a suspended energy offer bounds the register at 0, in either shape", () => {
    for (const vehicle of [withCurve(), vehicleTermOf(undefined)]) {
      expect(
        resolveOperatingPoint(bareInputs({ vehicle, fault: faultOf(true) }))
          .accumulationCapW,
      ).toBe(0);
    }
  });

  it("any other status bounds the register like the charging case", () => {
    const vehicle = withCurve();
    const schedule = { scheduleLimitW: 3_000, activePhases: 1 };
    expect(
      resolveOperatingPoint(
        bareInputs({ soc: 50, vehicle, schedule, charging: false }),
      ).accumulationCapW,
    ).toBe(
      resolveOperatingPoint(
        bareInputs({ soc: 50, vehicle, schedule, charging: true }),
      ).accumulationCapW,
    );
  });
});

describe("the operating point is a pure function of its named terms (#327)", () => {
  it("is deterministic and reproduces the pre-refactor bare-connector values", () => {
    const inputs = bareInputs();
    expect(resolveOperatingPoint(inputs)).toEqual(
      resolveOperatingPoint(inputs),
    );
    // No electrical model, no curve, no profile: the register is uncapped and
    // the report is 0, as before the refactor.
    const bare = resolveOperatingPoint(inputs);
    expect(bare.accumulationCapW).toBe(Infinity);
    expect(bare.acceptedW).toBe(0);
    expect(bare.limitedBy).toBe("none");
    expect(
      resolveOperatingPoint(bareInputs({ fault: faultOf(true) }))
        .accumulationCapW,
    ).toBe(0);
  });

  it("cannot be called without a vehicle term (checked by tsc, not run)", () => {
    // Never invoked: the assertions are the `@ts-expect-error` lines, which
    // `bun run typecheck` fails on if the vehicle term ever becomes optional.
    const typeLevelOnly = (): void => {
      const { vehicle: _omitted, ...withoutVehicle } = bareInputs();
      // @ts-expect-error the vehicle term is required, not optional
      resolveOperatingPoint(withoutVehicle);
      resolveOperatingPoint({
        ...withoutVehicle,
        // @ts-expect-error and it is not nullable either
        vehicle: undefined,
      });
    };
    expect(typeLevelOnly).toBeTypeOf("function");
  });

  it("names what binds the offer", () => {
    const vehicle = vehicleTermOf({
      ...new Connector(1, new Logger(LogLevel.ERROR)).evSettings,
      maxChargingPowerKw: 22,
      chargingCurve: undefined,
    });
    const at = (scheduleLimitW: number, energyOfferSuspended = false) =>
      resolveOperatingPoint(
        bareInputs({
          vehicle,
          schedule: { scheduleLimitW, activePhases: 1 },
          fault: faultOf(energyOfferSuspended),
        }),
      ).limitedBy;
    expect(at(Infinity)).toBe("vehicle");
    expect(at(3_000)).toBe("schedule");
    expect(at(0)).toBe("schedule");
    expect(at(3_000, true)).toBe("suspended");
  });
});

describe("the resolution is protocol-agnostic (#327)", () => {
  it("OperatingPoint.ts imports nothing from transport or ocpp", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(dir, "..", "OperatingPoint.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(
        /infrastructure\/transport|\/ocpp\/|^\.\/Connector"?$/,
      );
    }
    expect(readdirSync(join(dir, "..")).includes("OperatingPoint.ts")).toBe(
      true,
    );
  });

  it("MeterValueBuilder.ts re-derives nothing", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      join(dir, "..", "MeterValueBuilder.ts"),
      "utf8",
    );
    for (const banned of [
      "effectiveChargingPowerW",
      "resolveSocForCurve",
      "currentAmpsFor",
      "scheduleConstraints",
      "currentScheduleLimitWatts",
    ]) {
      expect(source).not.toContain(banned);
    }
  });

  it("the opening SoC is read from the session intent in one place", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(dir, "..", "Connector.ts"), "utf8");
    expect(source).not.toMatch(/_evSettings\.(initialSoc|targetSoc)/);
    const intent = readFileSync(join(dir, "..", "SessionIntent.ts"), "utf8");
    const imports = [...intent.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec).not.toMatch(/infrastructure\/transport|\/ocpp\//);
    }
  });
});

describe("the charger cap is one more term of the resolution (#327)", () => {
  const CAP_CASES: Array<[string, Partial<EVSettings>, number]> = [
    [
      "DC",
      { currentType: "DC", voltageV: 400, maxChargingPowerKw: 100 },
      30_000,
    ],
    [
      "single-phase AC",
      { currentType: "AC", phases: 1, voltageV: 230, maxChargingPowerKw: 22 },
      3_000,
    ],
    [
      "three-phase AC",
      {
        currentType: "AC",
        phases: 3,
        voltageV: 230,
        powerFactor: 0.9,
        maxChargingPowerKw: 22,
      },
      6_000,
    ],
  ];

  for (const [name, settings, capW] of CAP_CASES) {
    it(`${name}: a binding cap narrows the register, Power.Active.Import, Power.Offered and Current.Import together`, () => {
      for (const curve of [CURVE, undefined]) {
        const connector = charging({ ...settings, chargingCurve: curve });
        connector.setMaxDeliveryPowerW(capW);
        const point = connector.operatingPoint();
        expect(point.chargerCapW).toBe(capW);
        expect(point.boundW).toBe(capW);
        // The register's bound and the reported power are the same number.
        expect(point.accumulationCapW).toBeLessThanOrEqual(capW);
        expect(point.acceptedW).toBeLessThanOrEqual(capW);
        expect(point.offeredW).toBe(capW);
        expect(point.limitedBy).toBe("charger");
        if (curve) expect(point.accumulationCapW).toBe(point.acceptedW);
        else expect(point.accumulationCapW).toBe(capW);

        const samples = buildSampledValues(
          connector,
          ["Power.Active.Import", "Power.Offered", "Current.Import"],
          "Sample.Periodic",
        );
        const value = (measurand: string) =>
          Number(
            samples.find((s) => s.measurand === measurand && !s.phase)!.value,
          );
        expect(value("Power.Active.Import")).toBeLessThanOrEqual(capW);
        expect(value("Power.Active.Import")).toBeCloseTo(point.acceptedW, 0);
        expect(value("Power.Offered")).toBe(capW);
        // Bounded by the same cap, in amperes (rounded down, never over).
        expect(value("Current.Import")).toBeLessThanOrEqual(point.limitA);
        expect(Math.abs(value("Current.Import") - point.currentA)).toBeLessThan(
          0.1,
        );
      }
    });
  }

  it("a connector without a cap resolves exactly as before", () => {
    const withCap = (watts: number | undefined) => {
      const connector = charging({ currentType: "AC", phases: 3 });
      connector.setMaxDeliveryPowerW(watts);
      return connector.operatingPoint();
    };
    const none = withCap(undefined);
    expect(none.chargerCapW).toBe(Infinity);
    expect(none.boundW).toBe(none.scheduleLimitW);
    // A cap above everything else does not bind.
    const loose = withCap(1_000_000);
    expect({ ...loose, at: 0, chargerCapW: 0, boundW: 0, limitA: 0 }).toEqual({
      ...none,
      at: 0,
      chargerCapW: 0,
      boundW: 0,
      limitA: 0,
    });
  });

  it("the schedule binds when it is tighter, and a tie is attributed to the schedule", () => {
    const connector = charging(
      { currentType: "DC", voltageV: 400, maxChargingPowerKw: 100 },
      profile(5_000),
    );
    connector.setMaxDeliveryPowerW(20_000);
    expect(connector.operatingPoint().limitedBy).toBe("schedule");
    expect(connector.operatingPoint().boundW).toBe(5_000);
    connector.setMaxDeliveryPowerW(5_000);
    expect(connector.operatingPoint().limitedBy).toBe("schedule");
  });

  it("a cap is the register bound with no curve, even with no vehicle ceiling", () => {
    const point = resolveOperatingPoint(
      bareInputs({ charger: chargerTermOf(7_000) }),
    );
    expect(point.accumulationCapW).toBe(7_000);
    expect(point.acceptedW).toBe(7_000);
    expect(point.limitedBy).toBe("charger");
  });

  it("offeredW follows a running transaction not suspended by the EVSE", () => {
    const vehicle = vehicleTermOf({
      ...new Connector(1, new Logger(LogLevel.ERROR)).evSettings,
      maxChargingPowerKw: 22,
      chargingCurve: undefined,
    });
    const offered = (offering: boolean, charging: boolean) =>
      resolveOperatingPoint(
        bareInputs({
          vehicle,
          charging,
          fault: { offering, energyOfferSuspended: !charging && offering },
        }),
      ).offeredW;
    expect(offered(true, true)).toBe(22_000); // Charging
    expect(offered(true, false)).toBe(22_000); // SuspendedEV: offered, not taken
    expect(offered(false, false)).toBe(0); // SuspendedEVSE, Preparing, Finishing...
  });

  it("Connector: SuspendedEV offers, SuspendedEVSE and Preparing do not", () => {
    const connector = charging({ currentType: "DC", maxChargingPowerKw: 50 });
    expect(connector.operatingPoint().offeredW).toBe(50_000);
    connector.status = OCPPStatus.SuspendedEV;
    const suspendedEv = connector.operatingPoint();
    expect(suspendedEv.offeredW).toBe(50_000);
    expect(suspendedEv.acceptedW).toBe(0);
    connector.status = OCPPStatus.SuspendedEVSE;
    expect(connector.operatingPoint().offeredW).toBe(0);
    connector.status = OCPPStatus.Preparing;
    expect(connector.operatingPoint().offeredW).toBe(0);
  });
});
