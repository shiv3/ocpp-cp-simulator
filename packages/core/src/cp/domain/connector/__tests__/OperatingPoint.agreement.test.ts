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
import { resolveOperatingPoint } from "../OperatingPoint";

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

  it("a sample build resolves the point once and announces one crossing", () => {
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
    expect(events).toHaveLength(1);
  });

  it("is a pure function of its inputs (no clock, no connector)", () => {
    const inputs = {
      charging: true,
      settings: undefined,
      soc: null,
      transactionInitialSoc: undefined,
      scheduleLimitW: Infinity,
      activePhases: 1,
      energyOfferSuspended: false,
    };
    expect(resolveOperatingPoint(inputs)).toEqual(
      resolveOperatingPoint(inputs),
    );
    // No electrical model, no curve, no profile: the register is uncapped and
    // the report is 0, as before the refactor.
    const bare = resolveOperatingPoint(inputs);
    expect(bare.accumulationCapW).toBe(Infinity);
    expect(bare.acceptedW).toBe(0);
    expect(
      resolveOperatingPoint({ ...inputs, energyOfferSuspended: true })
        .accumulationCapW,
    ).toBe(0);
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
});
