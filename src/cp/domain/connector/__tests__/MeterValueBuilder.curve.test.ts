import { describe, expect, it } from "vitest";

import { buildSampledValues } from "../MeterValueBuilder";
import type { Connector } from "../Connector";
import type { EVSettings } from "../EVSettings";

/**
 * The slice of `Connector` the sample builder actually reads. A stub rather
 * than a real connector: this is about the arithmetic, and a real one would
 * drag in a charge point, a transport and a database to assert a number.
 */
function connectorStub(options: {
  soc?: number | null;
  status?: string;
  evSettings?: Partial<EVSettings>;
  scheduleLimitW?: number;
  meterValue?: number;
}): Connector {
  return {
    status: options.status ?? "Charging",
    soc: options.soc ?? null,
    meterValue: options.meterValue ?? 0,
    evSettings: {
      modelName: "Test EV",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 100,
      initialSoc: 20,
      targetSoc: 80,
      ...options.evSettings,
    },
    currentScheduleLimitWatts: () => options.scheduleLimitW ?? Infinity,
  } as unknown as Connector;
}

function valueOf(
  connector: Connector,
  measurand: string,
  phase?: string,
): number | undefined {
  const samples = buildSampledValues(connector, [measurand], "Sample.Periodic");
  const sample = samples.find((s) =>
    phase === undefined ? s.phase === undefined : s.phase === phase,
  );
  return sample ? Number(sample.value) : undefined;
}

const TAPER: EVSettings["chargingCurve"] = [
  { socPercent: 0, powerFraction: 1 },
  { socPercent: 80, powerFraction: 0.5 },
  { socPercent: 100, powerFraction: 0.1 },
];

describe("MeterValueBuilder with a charging curve (#301)", () => {
  it("tapers power as the battery fills", () => {
    const at = (soc: number) =>
      valueOf(
        connectorStub({ soc, evSettings: { chargingCurve: TAPER } }),
        "Power.Active.Import",
      );
    expect(at(0)).toBe(100_000);
    expect(at(80)).toBe(50_000);
    expect(at(100)).toBe(10_000);
  });

  it("leaves a curve-less connector flat, as before", () => {
    // Every charge point that predates this must report the same numbers.
    const flat = connectorStub({ soc: 90 });
    expect(valueOf(flat, "Power.Active.Import")).toBe(100_000);
  });

  it("lets an active charging profile win over the curve", () => {
    // `min(curve, profile)`: a curve lowers demand and never raises it, so a
    // SetChargingProfile the CSMS set can never be exceeded.
    const capped = connectorStub({
      soc: 0,
      evSettings: { chargingCurve: TAPER },
      scheduleLimitW: 7_000,
    });
    expect(valueOf(capped, "Power.Active.Import")).toBe(7_000);
  });

  it("still tapers below a profile that is higher than the curve", () => {
    const tapered = connectorStub({
      soc: 100,
      evSettings: { chargingCurve: TAPER },
      scheduleLimitW: 50_000,
    });
    expect(valueOf(tapered, "Power.Active.Import")).toBe(10_000);
  });

  it("reports nothing while not charging", () => {
    const idle = connectorStub({
      soc: 0,
      status: "Available",
      evSettings: { chargingCurve: TAPER },
    });
    expect(valueOf(idle, "Power.Active.Import")).toBe(0);
  });
});

describe("MeterValueBuilder electrical derivation (#301)", () => {
  it("derives DC current from P / V", () => {
    const dc = connectorStub({
      soc: 0,
      evSettings: {
        maxChargingPowerKw: 150,
        currentType: "DC",
        voltageV: 400,
      },
    });
    expect(valueOf(dc, "Current.Import")).toBeCloseTo(375, 0);
    expect(valueOf(dc, "Voltage")).toBe(400);
  });

  it("divides AC current across phases", () => {
    const ac = connectorStub({
      soc: 0,
      evSettings: {
        maxChargingPowerKw: 22,
        currentType: "AC",
        phases: 3,
        voltageV: 230,
      },
    });
    expect(valueOf(ac, "Current.Import")).toBeCloseTo(22_000 / (230 * 3), 0);
  });

  it("emits per-phase current that sums to the aggregate", () => {
    const ac = connectorStub({
      soc: 0,
      evSettings: {
        maxChargingPowerKw: 22,
        currentType: "AC",
        phases: 3,
        voltageV: 230,
      },
    });
    const samples = buildSampledValues(
      ac,
      ["Current.Import"],
      "Sample.Periodic",
    );
    const phases = samples.filter((s) => s.phase !== undefined);
    expect(phases.map((s) => s.phase)).toEqual(["L1", "L2", "L3"]);
    // Each phase carries the same current; the aggregate is that current, not
    // three times it — this is a per-phase reading, not a sum of three legs.
    const aggregate = Number(
      samples.find((s) => s.phase === undefined)?.value ?? "0",
    );
    for (const p of phases) {
      expect(Number(p.value)).toBeCloseTo(aggregate, 1);
    }
  });

  it("does not split the energy register across phases", () => {
    // A meter has one register; three would be inventing counters.
    const ac = connectorStub({
      soc: 0,
      meterValue: 1234,
      evSettings: { currentType: "AC", phases: 3 },
    });
    const samples = buildSampledValues(
      ac,
      ["Energy.Active.Import.Register"],
      "Sample.Periodic",
    );
    expect(samples.filter((s) => s.phase !== undefined)).toHaveLength(0);
  });

  it("emits no per-phase samples on a single-phase connector", () => {
    const single = connectorStub({
      soc: 0,
      evSettings: { currentType: "AC", phases: 1 },
    });
    const samples = buildSampledValues(
      single,
      ["Current.Import"],
      "Sample.Periodic",
    );
    expect(samples.filter((s) => s.phase !== undefined)).toHaveLength(0);
  });

  it("emits no per-phase samples on DC, which has none", () => {
    const dc = connectorStub({
      soc: 0,
      evSettings: { currentType: "DC", phases: 3, voltageV: 400 },
    });
    const samples = buildSampledValues(
      dc,
      ["Current.Import"],
      "Sample.Periodic",
    );
    expect(samples.filter((s) => s.phase !== undefined)).toHaveLength(0);
  });
});
