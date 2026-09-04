import { describe, expect, it } from "vitest";

import { buildSampledValues } from "../MeterValueBuilder";
import type { Connector } from "../Connector";
import type { EVSettings } from "../EVSettings";
import { resolveActivePhases } from "../ChargingCurve";

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
  transactionInitialSoc?: number;
  /** The active profile period's `numberPhases`, when one restricts us. */
  limitNumberPhases?: number;
}): Connector {
  return {
    status: options.status ?? "Charging",
    soc: options.soc ?? null,
    meterValue: options.meterValue ?? 0,
    transaction:
      options.transactionInitialSoc !== undefined
        ? { initialSoc: options.transactionInitialSoc }
        : null,
    evSettings: {
      modelName: "Test EV",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 100,
      initialSoc: 20,
      targetSoc: 80,
      ...options.evSettings,
    },
    currentScheduleLimitWatts: () => options.scheduleLimitW ?? Infinity,
    // Mirrors `Connector.activePhaseCount()`: the wiring, narrowed by the
    // active profile's `numberPhases`.
    activePhaseCount: () =>
      resolveActivePhases(
        {
          currentType: options.evSettings?.currentType,
          phases: options.evSettings?.phases,
        },
        options.limitNumberPhases,
      ),
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

  it("evaluates at the transaction's initialSoc, not 0%, before the first synced SoC (#301)", () => {
    // `soc: null` is the normal state for a Transaction.Begin sample, and
    // for the whole session when SoC sync is disabled. Evaluating the curve
    // at 0 would taper power for a battery that is actually nearly full.
    const nullSoc = connectorStub({
      soc: null,
      transactionInitialSoc: 100,
      evSettings: { chargingCurve: TAPER },
    });
    expect(valueOf(nullSoc, "Power.Active.Import")).toBe(10_000);
  });

  it("falls back to the EV settings' initialSoc when there is no transaction value", () => {
    const nullSoc = connectorStub({
      soc: null,
      evSettings: { chargingCurve: TAPER, initialSoc: 80 },
    });
    expect(valueOf(nullSoc, "Power.Active.Import")).toBe(50_000);
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

describe("Power.Offered / Current.Offered (#301)", () => {
  it("offers the full EVSE ceiling even when the curve tapers acceptance", () => {
    // A 100 kW charger still *offers* 100 kW to a nearly-full battery that
    // the curve says only accepts 10% of it — the curve describes the
    // battery, not the EVSE.
    const nearlyFull = connectorStub({
      soc: 100,
      evSettings: { chargingCurve: TAPER },
    });
    expect(valueOf(nearlyFull, "Power.Active.Import")).toBe(10_000);
    expect(valueOf(nearlyFull, "Power.Offered")).toBe(100_000);
  });

  it("still caps the offer at an active charging profile", () => {
    // The profile is the EVSE's own limit (set by the CSMS), unlike the
    // curve, which is a battery-acceptance concern.
    const capped = connectorStub({
      soc: 100,
      evSettings: { chargingCurve: TAPER },
      scheduleLimitW: 50_000,
    });
    expect(valueOf(capped, "Power.Offered")).toBe(50_000);
  });

  it("matches Power.Active.Import when there is no curve", () => {
    const flat = connectorStub({ soc: 50 });
    expect(valueOf(flat, "Power.Offered")).toBe(
      valueOf(flat, "Power.Active.Import"),
    );
  });

  it("derives Current.Offered from the offered power, not the accepted one", () => {
    const dc = connectorStub({
      soc: 100,
      evSettings: {
        chargingCurve: TAPER,
        maxChargingPowerKw: 100,
        currentType: "DC",
        voltageV: 400,
      },
    });
    // Offered: 100_000 W / 400 V = 250 A. Accepted (Current.Import): 10_000 W
    // / 400 V = 25 A. They must differ, or Offered is just aliasing Import.
    expect(valueOf(dc, "Current.Offered")).toBeCloseTo(250, 0);
    expect(valueOf(dc, "Current.Import")).toBeCloseTo(25, 0);
  });
});

describe("Power.Factor (#301)", () => {
  it("reports the configured value on AC", () => {
    const ac = connectorStub({
      soc: 0,
      evSettings: { currentType: "AC", powerFactor: 0.98 },
    });
    expect(valueOf(ac, "Power.Factor")).toBeCloseTo(0.98);
  });

  it("is consistent with the current it implies in the same sample set", () => {
    // 0.875 is deliberately a value two-decimal rounding would mangle (to
    // 0.88): the sample must name the number the current was actually derived
    // from, not a prettier one. Reporting `toFixed(2)` here while
    // `currentAmpsFor` used the full value made one MeterValue contradict
    // itself (#301).
    const ac = connectorStub({
      soc: 0,
      evSettings: {
        maxChargingPowerKw: 22,
        currentType: "AC",
        voltageV: 230,
        powerFactor: 0.875,
      },
    });
    const samples = buildSampledValues(
      ac,
      ["Current.Import", "Power.Factor"],
      "Sample.Periodic",
    );
    const currentA = Number(
      samples.find((s) => s.measurand === "Current.Import")?.value,
    );
    const pf = Number(
      samples.find((s) => s.measurand === "Power.Factor")?.value,
    );
    expect(pf).toBe(0.875);
    expect(currentA).toBeCloseTo(22_000 / (230 * pf), 1);
  });

  it("reports a value finer than two decimals verbatim", () => {
    // The reviewer's case: `Power.Factor = 0.00` next to a `Current.Import`
    // derived from 0.004. Rounding the derivation to match instead would
    // divide by zero, so the sample is the thing that has to stop rounding.
    const ac = connectorStub({
      soc: 0,
      evSettings: {
        maxChargingPowerKw: 22,
        currentType: "AC",
        voltageV: 230,
        powerFactor: 0.004,
      },
    });
    const samples = buildSampledValues(
      ac,
      ["Current.Import", "Power.Factor"],
      "Sample.Periodic",
    );
    const pf = samples.find((s) => s.measurand === "Power.Factor")!.value;
    expect(pf).toBe("0.004");
    const currentA = Number(
      samples.find((s) => s.measurand === "Current.Import")!.value,
    );
    expect(currentA).toBeCloseTo(22_000 / (230 * Number(pf)), 1);
  });

  it("reports the unity fallback it actually used for an out-of-contract value", () => {
    // `powerFactor: 0` is rejected by schema/scenario.schema.json and by both
    // browser panels, so it can only arrive through raw RPC. The domain falls
    // back to unity rather than dividing by zero — and the sample says so, so
    // the substitution is visible on the wire instead of silent (#301).
    const ac = connectorStub({
      soc: 0,
      evSettings: {
        maxChargingPowerKw: 22,
        currentType: "AC",
        voltageV: 230,
        powerFactor: 0,
      },
    });
    const samples = buildSampledValues(
      ac,
      ["Current.Import", "Power.Factor"],
      "Sample.Periodic",
    );
    const pf = Number(
      samples.find((s) => s.measurand === "Power.Factor")?.value,
    );
    expect(pf).toBe(1);
    const currentA = Number(
      samples.find((s) => s.measurand === "Current.Import")?.value,
    );
    expect(Number.isFinite(currentA)).toBe(true);
    expect(currentA).toBeCloseTo(22_000 / 230, 1);
  });

  it("is always 1 on DC, regardless of a configured value", () => {
    // DC has no reactive component — reporting the configured AC-style value
    // here would make Power.Factor disagree with the P/V current derivation.
    const dc = connectorStub({
      soc: 0,
      evSettings: { currentType: "DC", voltageV: 400, powerFactor: 0.5 },
    });
    expect(valueOf(dc, "Power.Factor")).toBe(1);
  });

  it("defaults to unity when unconfigured", () => {
    const flat = connectorStub({ soc: 0 });
    expect(valueOf(flat, "Power.Factor")).toBe(1);
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

describe("the Voltage sample names the volts that produced the current (#301)", () => {
  // Same defect the `Power.Factor` fix addressed: two numbers in one
  // MeterValue that cannot both be true. `currentAmpsFor` falls back to 230 V
  // for a non-positive or non-finite `voltageV`, so the sample must say 230.
  const at = (voltageV: number) =>
    connectorStub({
      soc: 50,
      evSettings: { maxChargingPowerKw: 23, currentType: "AC", voltageV },
    });

  it("reports 230 when voltageV is zero, and derives the current from it", () => {
    const connector = at(0);
    expect(valueOf(connector, "Voltage")).toBe(230);
    // 23 kW / 230 V / 1 phase / cos φ 1 = 100 A.
    expect(valueOf(connector, "Current.Import")).toBeCloseTo(100, 1);
  });

  it("reports 230 for a negative or non-finite voltageV", () => {
    expect(valueOf(at(-400), "Voltage")).toBe(230);
    expect(valueOf(at(NaN), "Voltage")).toBe(230);
  });

  it("still reports a configured positive voltage verbatim", () => {
    const connector = connectorStub({
      soc: 50,
      evSettings: {
        maxChargingPowerKw: 40,
        currentType: "DC",
        voltageV: 400,
      },
    });
    expect(valueOf(connector, "Voltage")).toBe(400);
    expect(valueOf(connector, "Current.Import")).toBeCloseTo(100, 1);
  });
});

describe("per-phase samples honour the profile's phase restriction (#301)", () => {
  /**
   * The resolver lowers the watt cap using `min(connector phases, the
   * period's numberPhases)`. The sampling side has to read the same count, or
   * a 3-phase connector under a single-phase profile reports consumption on
   * two phases the CSMS said it may not use.
   */
  const threePhase = (limitNumberPhases?: number) =>
    connectorStub({
      soc: 50,
      evSettings: {
        maxChargingPowerKw: 22,
        currentType: "AC",
        phases: 3,
      },
      limitNumberPhases,
    });

  const phased = (connector: Connector, measurand: string) =>
    buildSampledValues(connector, [measurand], "Sample.Periodic").filter(
      (s) => s.phase !== undefined,
    );

  it("emits no per-phase sample when the profile restricts to one phase", () => {
    const connector = threePhase(1);
    expect(phased(connector, "Current.Import")).toHaveLength(0);
    expect(phased(connector, "Power.Active.Import")).toHaveLength(0);
  });

  it("emits no per-phase sample when the profile restricts to two phases", () => {
    // OCPP's `numberPhases` says how many, never which, so naming L1 and L2
    // would invent an allocation the profile never expressed.
    expect(phased(threePhase(2), "Power.Active.Import")).toHaveLength(0);
  });

  it("still emits all three when the profile names three, or names none", () => {
    for (const limit of [undefined, 3]) {
      const connector = threePhase(limit);
      expect(
        phased(connector, "Power.Active.Import").map((s) => s.phase),
      ).toEqual(["L1", "L2", "L3"]);
    }
  });

  it("keeps the emitted phases summing to the whole-connector power", () => {
    const connector = threePhase(3);
    const samples = buildSampledValues(
      connector,
      ["Power.Active.Import"],
      "Sample.Periodic",
    );
    const aggregate = Number(
      samples.find((s) => s.phase === undefined)?.value ?? "0",
    );
    const sum = samples
      .filter((s) => s.phase !== undefined)
      .reduce((acc, s) => acc + Number(s.value), 0);
    expect(aggregate).toBeGreaterThan(0);
    // Each sample is reported as a whole watt, so the three legs can differ
    // from the aggregate by at most one watt each.
    expect(Math.abs(sum - aggregate)).toBeLessThanOrEqual(3);
  });

  it("keeps the aggregate itself unchanged when phases are restricted", () => {
    // The restriction suppresses the per-phase detail; it does not alter the
    // whole-connector number, which the schedule cap already governs.
    expect(valueOf(threePhase(1), "Power.Active.Import")).toBe(
      valueOf(threePhase(3), "Power.Active.Import"),
    );
  });
});

describe("a connector with no electrical fields is byte-identical to pre-v1.2 (#301)", () => {
  /**
   * The contract sentence this PR states: settings without any of
   * `chargingCurve`, `currentType`, `phases`, `voltageV` or `powerFactor`
   * produce the same MeterValues as before the charging curve existed. That
   * is a promise about the *strings* on the wire, not the parsed numbers — a
   * raw-payload or snapshot consumer compares text — so it is pinned here once
   * across every measurand rather than one at a time. `Power.Factor` is how
   * this was found: it had silently moved from "1.0" to "1".
   *
   * The expected values are the pre-#301 builder's output for this connector:
   * 22 kW at the default 230 V, one phase, unity cos φ.
   */
  const legacyConnector = () =>
    connectorStub({
      soc: 42,
      meterValue: 1234,
      evSettings: { maxChargingPowerKw: 22 },
    });

  const ALL_MEASURANDS = [
    "Energy.Active.Import.Register",
    "Voltage",
    "Current.Import",
    "Current.Offered",
    "Power.Active.Import",
    "Power.Offered",
    "Power.Factor",
    "SoC",
    "Temperature",
    "Frequency",
    "Energy.Active.Import.Interval",
    "Energy.Reactive.Import.Register",
    "Current.Export",
    "Power.Active.Export",
    "RPM",
    "Some.Vendor.Measurand",
  ];

  it("emits exactly the pre-v1.2 string for every measurand", () => {
    const samples = buildSampledValues(
      legacyConnector(),
      ALL_MEASURANDS,
      "Sample.Periodic",
    );
    const byMeasurand = Object.fromEntries(
      samples.map((s) => [s.measurand, s.value]),
    );
    expect(byMeasurand).toEqual({
      "Energy.Active.Import.Register": "1234",
      Voltage: "230",
      // 22000 W / 230 V, single phase, unity cos φ.
      "Current.Import": "95.7",
      "Current.Offered": "95.7",
      "Power.Active.Import": "22000",
      "Power.Offered": "22000",
      // The literal the pre-v1.2 builder hardcoded, not "1".
      "Power.Factor": "1.0",
      SoC: "42.0",
      Temperature: "25",
      Frequency: "50",
      "Energy.Active.Import.Interval": "0",
      "Energy.Reactive.Import.Register": "0",
      "Current.Export": "0",
      "Power.Active.Export": "0",
      RPM: "0",
      "Some.Vendor.Measurand": "0",
    });
  });

  it("emits no per-phase sample, as before v1.2", () => {
    const samples = buildSampledValues(
      legacyConnector(),
      ALL_MEASURANDS,
      "Sample.Periodic",
    );
    expect(samples.filter((s) => s.phase !== undefined)).toHaveLength(0);
  });

  it("still reports a configured power factor exactly, not as 1.0", () => {
    const configured = connectorStub({
      soc: 42,
      evSettings: {
        maxChargingPowerKw: 22,
        currentType: "AC",
        powerFactor: 0.004,
      },
    });
    const sample = buildSampledValues(
      configured,
      ["Power.Factor"],
      "Sample.Periodic",
    )[0]!;
    expect(sample.value).toBe("0.004");
  });

  it("reports an explicitly configured unity power factor as 1.0 too", () => {
    // Same string either way: the wire form of unity does not depend on how
    // the connector arrived at it.
    const configured = connectorStub({
      soc: 42,
      evSettings: { maxChargingPowerKw: 22, currentType: "AC", powerFactor: 1 },
    });
    expect(
      buildSampledValues(configured, ["Power.Factor"], "Sample.Periodic")[0]!
        .value,
    ).toBe("1.0");
  });
});
