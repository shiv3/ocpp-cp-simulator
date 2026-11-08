import { describe, it, expect, vi, afterEach } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../types/OcppTypes";
import {
  applySampledValueOverrides,
  buildSampledValues,
  type SampledValue,
} from "../MeterValueBuilder";
import {
  mainMeterProblem,
  meterRealismProblem,
  rampFactor,
  seededUnit,
  type MeterRealism,
} from "../MeterRealism";
import { chargerCapabilitiesProblem } from "../../charge-point/ChargerCapabilities";
import { chargerCapabilitiesSchema } from "@ocpp-cp-simulator/contracts/chargerCapabilities";
import { MainMeter } from "../../charge-point/MainMeter";
import type { Transaction } from "../Transaction";
import type { EVSettings } from "../EVSettings";

afterEach(() => {
  vi.useRealTimers();
});

function chargingConnector(
  meter: MeterRealism | undefined,
  ev: Partial<EVSettings> = {},
  id = 1,
): Connector {
  const connector = new Connector(id, new Logger(LogLevel.ERROR));
  connector.evSettings = {
    ...connector.evSettings,
    maxChargingPowerKw: 11,
    ...ev,
  };
  connector.setMeterRealism(meter);
  connector.socMeterSyncEnabled = false;
  connector.soc = 20;
  connector.status = OCPPStatus.Charging;
  const tx: Transaction = {
    id: 1,
    connectorId: id,
    tagId: "TAG",
    meterStart: 0,
    meterStop: null,
    startTime: new Date(),
    stopTime: null,
    meterSent: false,
  };
  connector.beginTransaction(tx);
  return connector;
}

function sample(
  samples: SampledValue[],
  measurand: string,
  phase?: string,
): SampledValue | undefined {
  return samples.find((s) => s.measurand === measurand && s.phase === phase);
}

const POWER = ["Power.Active.Import"];

describe("seeded fluctuation (#614)", () => {
  const meter: MeterRealism = {
    seed: 42,
    fluctuation: { voltagePct: 3, currentPct: 2, powerPct: 5 },
  };

  it("keeps the default constant and byte-identical without a config", () => {
    vi.useFakeTimers();
    const connector = chargingConnector(undefined);
    const a = buildSampledValues(connector, ["Voltage", ...POWER], "Other");
    vi.advanceTimersByTime(7_000);
    const b = buildSampledValues(connector, ["Voltage", ...POWER], "Other");
    expect(b).toEqual(a);
    expect(sample(a, "Voltage")?.value).toBe("230");
    expect(sample(a, "Power.Active.Import")?.value).toBe("11000");
  });

  it("gives the same series for the same seed and a different one for another", () => {
    vi.useFakeTimers();
    const run = (m: MeterRealism) => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const connector = chargingConnector(m);
      const series: string[] = [];
      for (let i = 0; i < 20; i++) {
        const s = buildSampledValues(
          connector,
          ["Voltage", "Current.Import", ...POWER],
          "Other",
        );
        series.push(s.map((x) => x.value).join("/"));
        vi.advanceTimersByTime(1_000);
      }
      return series;
    };
    const first = run(meter);
    expect(run(meter)).toEqual(first);
    expect(run({ ...meter, seed: 43 })).not.toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(10);
  });

  it("stays inside the configured band and never above the bound", () => {
    vi.useFakeTimers();
    const connector = chargingConnector(meter);
    for (let i = 0; i < 100; i++) {
      const s = buildSampledValues(connector, ["Voltage", ...POWER], "Other");
      const v = Number(sample(s, "Voltage")?.value);
      expect(v).toBeGreaterThanOrEqual(230 * 0.97 - 0.1);
      expect(v).toBeLessThanOrEqual(230 * 1.03 + 0.1);
      const p = Number(sample(s, "Power.Active.Import")?.value);
      expect(p).toBeLessThanOrEqual(11_000);
      expect(p).toBeGreaterThanOrEqual(11_000 * 0.95 - 1);
      vi.advanceTimersByTime(1_000);
    }
  });

  it("draws uniformly in [-1, 1) and purely", () => {
    for (let i = 0; i < 200; i++) {
      const u = seededUnit(7, i, 1);
      expect(u).toBeGreaterThanOrEqual(-1);
      expect(u).toBeLessThan(1);
      expect(seededUnit(7, i, 1)).toBe(u);
    }
  });
});

describe("ramp-up (#614)", () => {
  it("shapes the factor", () => {
    expect(rampFactor({ shape: "linear", durationSeconds: 10 }, 0)).toBe(0);
    expect(
      rampFactor({ shape: "linear", durationSeconds: 10 }, 2_500),
    ).toBeCloseTo(0.25);
    expect(rampFactor({ shape: "linear", durationSeconds: 10 }, 99_000)).toBe(
      1,
    );
    const mid = rampFactor({ shape: "sigmoid", durationSeconds: 10 }, 5_000);
    expect(mid).toBeCloseTo(0.5, 5);
    expect(
      rampFactor({ shape: "sigmoid", durationSeconds: 10 }, 0),
    ).toBeCloseTo(0);
    expect(
      rampFactor({ shape: "sigmoid", durationSeconds: 10 }, 10_000),
    ).toBeCloseTo(1);
  });

  it("reaches the target after the duration, not at once", () => {
    vi.useFakeTimers();
    const connector = chargingConnector({
      rampUp: { shape: "linear", durationSeconds: 60 },
    });
    const at = (ms: number) => {
      vi.advanceTimersByTime(ms);
      return Number(
        sample(buildSampledValues(connector, POWER, "Other"), POWER[0])?.value,
      );
    };
    expect(at(0)).toBe(0);
    expect(at(30_000)).toBeCloseTo(5_500, -1);
    expect(at(30_000)).toBe(11_000);
  });

  it("keeps the energy register equal to the integral of the reported power", () => {
    vi.useFakeTimers();
    const connector = chargingConnector(
      {
        seed: 9,
        fluctuation: { powerPct: 4 },
        rampUp: { shape: "sigmoid", durationSeconds: 30 },
      },
      {
        // A curve ties the register to the accepted power.
        chargingCurve: [
          { socPercent: 0, powerFraction: 1 },
          { socPercent: 100, powerFraction: 1 },
        ],
      },
    );
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 1_000_000,
    });
    let integralWh = 0;
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(1_000);
      const p = Number(
        sample(buildSampledValues(connector, POWER, "Other"), POWER[0])?.value,
      );
      integralWh += p / 3600;
    }
    expect(Math.abs(connector.meterValue - integralWh)).toBeLessThan(2);
    expect(connector.meterValue).toBeGreaterThan(100);
  });

  it("scales a configured increment the same way", () => {
    vi.useFakeTimers();
    const connector = chargingConnector(
      { rampUp: { shape: "linear", durationSeconds: 10 } },
      { maxChargingPowerKw: 0 },
    );
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 100,
    });
    vi.advanceTimersByTime(20_000);
    // 100 Wh per tick at full power; the first ten ticks ramp 0.1 .. 1.0.
    expect(connector.meterValue).toBe(Math.round(100 * 5.5 + 100 * 10));
  });
});

describe("per-phase voltage and independent phases (#615)", () => {
  const three: Partial<EVSettings> = { phases: 3, currentType: "AC" };
  const measurands = ["Voltage", "Current.Import", "Power.Active.Import"];

  it("emits no line-to-neutral voltage by default", () => {
    const connector = chargingConnector(undefined, three);
    const s = buildSampledValues(connector, measurands, "Other");
    expect(s.filter((x) => x.measurand === "Voltage")).toHaveLength(1);
    // Default per-phase current/power legs stay as they were.
    expect(sample(s, "Current.Import", "L1")?.value).toBe(
      sample(s, "Current.Import")?.value,
    );
  });

  it("reports L-N and L-L voltages and independent legs that add up", () => {
    vi.useFakeTimers();
    const connector = chargingConnector(
      {
        seed: 5,
        phases: { voltageImbalancePct: 3, loadImbalancePct: 15 },
      },
      three,
    );
    const s = buildSampledValues(connector, measurands, "Other");
    const names = s
      .filter((x) => x.measurand === "Voltage")
      .map((x) => x.phase);
    expect(names).toEqual([
      undefined,
      "L1-N",
      "L2-N",
      "L3-N",
      "L1-L2",
      "L2-L3",
      "L3-L1",
    ]);
    const ln = ["L1-N", "L2-N", "L3-N"].map((p) =>
      Number(sample(s, "Voltage", p)?.value),
    );
    const l12 = Number(sample(s, "Voltage", "L1-L2")?.value);
    expect(l12).toBeCloseTo(
      Math.sqrt(ln[0] ** 2 + ln[1] ** 2 + ln[0] * ln[1]),
      0,
    );
    const powers = ["L1", "L2", "L3"].map((p) =>
      Number(sample(s, "Power.Active.Import", p)?.value),
    );
    expect(
      Math.abs(powers[0] + powers[1] + powers[2] - 11_000),
    ).toBeLessThanOrEqual(2);
    expect(new Set(powers).size).toBeGreaterThan(1);
    const currents = ["L1", "L2", "L3"].map((p) =>
      Number(sample(s, "Current.Import", p)?.value),
    );
    expect(new Set(currents).size).toBeGreaterThan(1);
  });

  it("omits line-to-line voltages on request and for a single phase", () => {
    const noLl = chargingConnector({ phases: { lineToLine: false } }, three);
    const s = buildSampledValues(noLl, ["Voltage"], "Other");
    expect(s.map((x) => x.phase)).toEqual([undefined, "L1-N", "L2-N", "L3-N"]);
    const single = chargingConnector({ phases: {} }, { phases: 1 });
    expect(buildSampledValues(single, ["Voltage"], "Other")).toHaveLength(1);
  });
});

describe("Interval and Export measurands (#615)", () => {
  const all = [
    "Energy.Active.Import.Register",
    "Energy.Active.Import.Interval",
    "Energy.Active.Export.Register",
    "Energy.Active.Export.Interval",
    "Power.Active.Export",
    "Current.Export",
  ];

  it("stays the historical zero without meter realism", () => {
    const connector = chargingConnector(undefined);
    for (const s of buildSampledValues(connector, all.slice(1), "Other")) {
      if (
        s.measurand === "Energy.Active.Import.Interval" ||
        s.measurand?.includes("Export")
      ) {
        expect(s).toEqual({
          value: "0",
          context: "Other",
          measurand: s.measurand,
        });
      }
    }
  });

  it("measures the import interval from the previous sample", () => {
    vi.useFakeTimers();
    const connector = chargingConnector({});
    connector.meterValue = 100;
    const first = buildSampledValues(connector, all, "Transaction.Begin");
    expect(sample(first, "Energy.Active.Import.Interval")?.value).toBe("100");
    expect(sample(first, "Energy.Active.Import.Interval")?.unit).toBe("Wh");
    connector.meterValue = 340;
    const second = buildSampledValues(connector, all, "Sample.Periodic");
    expect(sample(second, "Energy.Active.Import.Interval")?.value).toBe("240");
    const third = buildSampledValues(connector, all, "Sample.Periodic");
    expect(sample(third, "Energy.Active.Import.Interval")?.value).toBe("0");
  });

  it("exports while a discharge term is configured, and imports nothing", () => {
    vi.useFakeTimers();
    const connector = chargingConnector({ export: { powerW: 5_000 } });
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 1_000,
    });
    vi.advanceTimersByTime(3_600 * 1_000);
    const s = buildSampledValues(connector, [...all, ...POWER], "Other");
    expect(sample(s, "Power.Active.Export")?.value).toBe("5000");
    expect(sample(s, "Power.Active.Import")?.value).toBe("0");
    expect(
      Number(sample(s, "Energy.Active.Export.Register")?.value),
    ).toBeGreaterThan(4_900);
    expect(
      Number(sample(s, "Energy.Active.Export.Register")?.value),
    ).toBeLessThanOrEqual(5_000);
    expect(connector.meterValue).toBe(0);
    expect(Number(sample(s, "Current.Export")?.value)).toBeCloseTo(
      5_000 / 230,
      1,
    );
  });
});

describe("SampledValue overrides and units (#616)", () => {
  const base: SampledValue[] = [
    {
      value: "12345",
      context: "Sample.Periodic",
      measurand: "Energy.Active.Import.Register",
      unit: "Wh",
    },
    {
      value: "7400",
      context: "Sample.Periodic",
      measurand: "Power.Active.Import",
      unit: "W",
    },
    {
      value: "7400",
      context: "Sample.Periodic",
      measurand: "Power.Active.Import",
      unit: "W",
      phase: "L1",
    },
  ];

  it("converts inside a unit family and sets location, context and phase", () => {
    const out = applySampledValueOverrides(base, [
      {
        measurand: "Energy.Active.Import.Register",
        set: { unit: "kWh", location: "Outlet", context: "Sample.Clock" },
      },
      {
        measurand: "Power.Active.Import",
        phase: "L1",
        set: { unit: "kW", decimals: 2, phase: "L2" },
      },
    ]);
    expect(out[0]).toMatchObject({
      value: "12.345",
      unit: "kWh",
      location: "Outlet",
      context: "Sample.Clock",
    });
    expect(out[1]).toEqual(base[1]);
    expect(out[2]).toMatchObject({ value: "7.4", unit: "kW", phase: "L2" });
    expect(base[0].unit).toBe("Wh");
  });

  it("fixes a value and drops a sample", () => {
    const out = applySampledValueOverrides(base, [
      { measurand: "Power.Active.Import", phase: "L1", set: { omit: true } },
      { measurand: "Power.Active.Import", set: { value: "0" } },
    ]);
    expect(out.map((s) => s.value)).toEqual(["12345", "0"]);
  });

  it("applies a multiplier on OCPP 2.x only", () => {
    const rule = [
      { measurand: "Power.Active.Import", set: { multiplier: 3, unit: "W" } },
    ];
    const one6 = applySampledValueOverrides(base.slice(1, 2), rule);
    expect(one6[0]).toEqual(base[1]);
    const one2 = applySampledValueOverrides(base.slice(1, 2), rule, {
      unitMultiplier: true,
    });
    expect(one2[0]).toMatchObject({ value: "7.4", multiplier: 3 });
  });

  it("applies through the builder for a connector's config", () => {
    const connector = chargingConnector({
      sampledValues: [
        { measurand: "Power.Active.Import", set: { unit: "kW" } },
      ],
    });
    const s = buildSampledValues(connector, POWER, "Other");
    expect(s[0]).toMatchObject({ value: "11", unit: "kW" });
  });
});

describe("station main meter (#617)", () => {
  const clock = (state: { t: number }) => ({ now: () => state.t }) as never;

  it("aggregates the connectors into a cumulative register", () => {
    vi.useFakeTimers();
    const state = { t: Date.now() };
    const a = chargingConnector(undefined, {}, 1);
    const b = chargingConnector(undefined, {}, 2);
    const map = new Map([
      [1, a],
      [2, b],
    ]);
    const main = new MainMeter({ baseLoadW: 100 }, () => map, clock(state));
    a.meterValue = 1_000;
    b.meterValue = 500;
    state.t += 3_600_000;
    const s = main.sampledValues(
      [
        "Energy.Active.Import.Register",
        "Power.Active.Import",
        "Current.Offered",
        "SoC",
      ],
      "Sample.Clock",
    );
    // 1500 Wh at the connectors + one hour of 100 W base load.
    expect(sample(s, "Energy.Active.Import.Register")?.value).toBe("1600");
    expect(sample(s, "Power.Active.Import")?.value).toBe("22100");
    expect(s.map((x) => x.measurand)).not.toContain("SoC");
    expect(s[0].location).toBe("Inlet");
    // Cumulative, not reset by the next read.
    a.meterValue = 1_200;
    const again = main.sampledValues(
      ["Energy.Active.Import.Register"],
      "Other",
    );
    expect(again[0].value).toBe("1800");
  });

  it("does not count a register set backwards and reports export on V2X", () => {
    vi.useFakeTimers();
    const state = { t: Date.now() };
    const a = chargingConnector({ export: { powerW: 4_000 } }, {}, 1);
    const map = new Map([[1, a]]);
    const main = new MainMeter({}, () => map, clock(state));
    const s = main.sampledValues(
      ["Power.Active.Import", "Power.Active.Export"],
      "Other",
    );
    expect(sample(s, "Power.Active.Import")?.value).toBe("0");
    expect(sample(s, "Power.Active.Export")?.value).toBe("4000");
    a.meterValue = 10;
    expect(main.importRegisterWh).toBe(10);
    a.meterValue = 5;
    expect(main.importRegisterWh).toBe(10);
    a.meterValue = 8;
    expect(main.importRegisterWh).toBe(13);
  });

  it("validates its configuration", () => {
    expect(mainMeterProblem({ baseLoadW: 50, phases: 3 })).toBeNull();
    expect(mainMeterProblem({ phases: 2 })).toMatch(/phases/);
    expect(
      meterRealismProblem({ rampUp: { shape: "ease", durationSeconds: 5 } }),
    ).toMatch(/shape/);
    expect(meterRealismProblem({ fluctuation: { powerPct: 80 } })).toMatch(
      /0 to 50/,
    );
    expect(
      meterRealismProblem({
        seed: 1,
        rampUp: { shape: "linear", durationSeconds: 5 },
      }),
    ).toBeNull();
  });
});

describe("chargerCapabilities carries the meter config", () => {
  const caps = {
    connectors: [
      {
        connectorId: 1,
        maxDeliveryPowerW: 11_000,
        meter: {
          seed: 3,
          fluctuation: { voltagePct: 2 },
          rampUp: { shape: "sigmoid", durationSeconds: 20 },
          phases: { loadImbalancePct: 5 },
          export: { powerW: 3_000 },
          sampledValues: [
            { measurand: "Voltage", set: { unit: "V", omit: false } },
          ],
        },
      },
    ],
    mainMeter: { baseLoadW: 50, phases: 3 },
  };

  it("passes both validators", () => {
    expect(chargerCapabilitiesProblem(caps)).toBeNull();
    expect(chargerCapabilitiesSchema.safeParse(caps).success).toBe(true);
  });

  it("refuses the same mistakes in both", () => {
    const bad = {
      connectors: [
        {
          connectorId: 1,
          maxDeliveryPowerW: 1,
          meter: { rampUp: { shape: "ease", durationSeconds: 5 } },
        },
      ],
    };
    expect(chargerCapabilitiesProblem(bad)).toMatch(/shape/);
    expect(chargerCapabilitiesSchema.safeParse(bad).success).toBe(false);
    const badMain = { connectors: [], mainMeter: { phases: 2 } };
    expect(chargerCapabilitiesProblem(badMain)).toMatch(/phases/);
    expect(chargerCapabilitiesSchema.safeParse(badMain).success).toBe(false);
  });
});
