import { afterEach, describe, it, expect, vi } from "vitest";
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
import type { Transaction } from "../Transaction";
import { ChargingProfileStore } from "../../charge-point/ChargingProfileStore";

function makeConnector(): Connector {
  return new Connector(1, new Logger(LogLevel.ERROR));
}

function ampProfile(
  limitAmps: number,
  numberPhases?: number,
): ActiveChargingProfile {
  return {
    chargingProfileId: 301,
    connectorId: 1,
    stackLevel: 0,
    chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
    chargingProfileKind: ChargingProfileKindType.Relative,
    chargingRateUnit: ChargingRateUnitType.A,
    chargingSchedulePeriods: [
      {
        startPeriod: 0,
        limit: limitAmps,
        ...(numberPhases !== undefined ? { numberPhases } : {}),
      },
    ],
  };
}

function transaction(): Transaction {
  return {
    id: 301,
    connectorId: 1,
    tagId: "TAG-AMP",
    meterStart: 0,
    meterStop: null,
    startTime: new Date(Date.now() - 60_000),
    stopTime: null,
    meterSent: false,
  };
}

/** Charge, with a big enough EV ceiling that only the profile can bind. */
function armCharging(connector: Connector): void {
  connector.evSettings = {
    ...connector.evSettings,
    maxChargingPowerKw: 350,
  };
  connector.socMeterSyncEnabled = false;
  connector.soc = 50;
  connector.status = OCPPStatus.Charging;
  connector.beginTransaction(transaction());
}

function reportedCurrentA(connector: Connector): number {
  const samples = buildSampledValues(
    connector,
    ["Current.Import"],
    "Sample.Periodic",
  );
  const aggregate = samples.find((s) => s.phase === undefined);
  return Number(aggregate!.value);
}

describe("an amp-based charging profile is not violated by the report (#301)", () => {
  it("reports exactly the limit for 3-phase AC with a non-unity power factor", () => {
    // The reported finding: 10 A × 230 V × 3 = 6900 W in, then
    // 6900 / (230 × 3 × 0.5) = 20 A out — double the CSMS's limit.
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 3,
      powerFactor: 0.5,
    };
    armCharging(connector);
    connector.addChargingProfile(ampProfile(10));

    expect(connector.currentScheduleLimitWatts()).toBeCloseTo(
      10 * 230 * 3 * 0.5,
      6,
    );
    expect(reportedCurrentA(connector)).toBeCloseTo(10, 6);
  });

  it("reports exactly the limit for single-phase AC at a non-default voltage", () => {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 1,
      voltageV: 240,
      powerFactor: 0.95,
    };
    armCharging(connector);
    connector.addChargingProfile(ampProfile(32, 1));

    expect(reportedCurrentA(connector)).toBeCloseTo(32, 6);
  });

  it("reports exactly the limit for DC, where numberPhases is meaningless", () => {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "DC",
      voltageV: 400,
    };
    armCharging(connector);
    // numberPhases=3 on a DC profile must not multiply the cap by three.
    connector.addChargingProfile(ampProfile(200, 3));

    expect(connector.currentScheduleLimitWatts()).toBeCloseTo(200 * 400, 6);
    expect(reportedCurrentA(connector)).toBeCloseTo(200, 6);
  });

  it("does not exceed the limit when the profile names more phases than the connector has", () => {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 1,
    };
    armCharging(connector);
    connector.addChargingProfile(ampProfile(16, 3));

    // A single-phase connector cannot draw 16 A on each of three phases.
    expect(connector.currentScheduleLimitWatts()).toBeCloseTo(16 * 230, 6);
    expect(reportedCurrentA(connector)).toBeCloseTo(16, 6);
  });

  it("reports the limit exactly when the profile restricts a 3-phase connector to one phase", () => {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 3,
    };
    armCharging(connector);
    connector.addChargingProfile(ampProfile(16, 1));

    // The CSMS restricted delivery to one phase, so the cap drops to 16 A on
    // that phase — and the current derivation divides by the phases in use,
    // not by the three the connector is wired for. Reporting 16/3 here was
    // the sample contradicting the line it describes: 3680 W flowing down one
    // conductor is 16 A on it, not 5.3 (#301).
    expect(connector.currentScheduleLimitWatts()).toBeCloseTo(16 * 230, 6);
    expect(reportedCurrentA(connector)).toBeCloseTo(16, 6);
  });

  it("leaves the conversion untouched for a connector that declares no electrical model", () => {
    // The pre-#301 path: no currentType/phases/voltageV/powerFactor anywhere
    // in evSettings, so the resolver keeps OCPP §7.21's numberPhases default
    // of 3 against a 230 V reference. This is the behaviour every scenario
    // written before the electrical model had, and it must not move.
    const connector = makeConnector();
    armCharging(connector);
    connector.addChargingProfile(ampProfile(16));

    expect(connector.currentScheduleLimitWatts()).toBe(16 * 230 * 3);
  });

  it("uses the model as soon as a single electrical field is declared", () => {
    const connector = makeConnector();
    connector.evSettings = { ...connector.evSettings, phases: 3 };
    armCharging(connector);
    connector.addChargingProfile(ampProfile(16));

    expect(connector.currentScheduleLimitWatts()).toBe(16 * 230 * 3);
    expect(reportedCurrentA(connector)).toBeCloseTo(16, 6);
  });
});

describe("the resolved phase count reaches the per-phase samples (#301)", () => {
  // End to end through a real Connector: the profile period's `numberPhases`
  // has to travel out of `ChargingScheduleResolver` and into the sampling
  // loop, or the message claims consumption on phases the CSMS excluded while
  // the watt cap says those phases are unavailable.
  function threePhaseConnector(): Connector {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 3,
    };
    armCharging(connector);
    return connector;
  }

  function phasedSamples(connector: Connector): (string | undefined)[] {
    return buildSampledValues(
      connector,
      ["Power.Active.Import"],
      "Sample.Periodic",
    )
      .filter((s) => s.phase !== undefined)
      .map((s) => s.phase);
  }

  it("suppresses per-phase samples under a single-phase profile", () => {
    const connector = threePhaseConnector();
    connector.addChargingProfile(ampProfile(16, 1));
    expect(connector.activePhaseCount()).toBe(1);
    expect(phasedSamples(connector)).toEqual([]);
  });

  it("suppresses them under a two-phase profile", () => {
    const connector = threePhaseConnector();
    connector.addChargingProfile(ampProfile(16, 2));
    expect(connector.activePhaseCount()).toBe(2);
    expect(phasedSamples(connector)).toEqual([]);
  });

  it("keeps all three under a three-phase profile, and with no profile at all", () => {
    const withProfile = threePhaseConnector();
    withProfile.addChargingProfile(ampProfile(16, 3));
    expect(withProfile.activePhaseCount()).toBe(3);
    expect(phasedSamples(withProfile)).toEqual(["L1", "L2", "L3"]);

    const bare = threePhaseConnector();
    expect(bare.activePhaseCount()).toBe(3);
    expect(phasedSamples(bare)).toEqual(["L1", "L2", "L3"]);
  });

  it("is always one phase on DC, whatever the profile says", () => {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "DC",
      voltageV: 400,
    };
    armCharging(connector);
    connector.addChargingProfile(ampProfile(200, 3));
    expect(connector.activePhaseCount()).toBe(1);
    expect(phasedSamples(connector)).toEqual([]);
  });
});

describe("the phase restriction composes across both profiles (#301)", () => {
  /**
   * The watt cap and the phase restriction are independent constraints. A Tx
   * profile can restrict the connector to one phase while a three-phase
   * `ChargePointMaxProfile` supplies the lower wattage; reading the phase
   * count off whichever profile won on watts dropped the Tx restriction and
   * put L1/L2/L3 back on the wire while it was still in force.
   */
  function stationMaxProfile(
    limitWatts: number,
    numberPhases?: number,
  ): ActiveChargingProfile {
    return {
      chargingProfileId: 302,
      connectorId: 0,
      stackLevel: 0,
      chargingProfilePurpose: ChargingProfilePurposeType.ChargePointMaxProfile,
      chargingProfileKind: ChargingProfileKindType.Relative,
      chargingRateUnit: ChargingRateUnitType.W,
      chargingSchedulePeriods: [
        {
          startPeriod: 0,
          limit: limitWatts,
          ...(numberPhases !== undefined ? { numberPhases } : {}),
        },
      ],
    };
  }

  function connectorWithStationProfile(
    stationProfile: ActiveChargingProfile | null,
  ): Connector {
    const store = new ChargingProfileStore();
    if (stationProfile) store.add(stationProfile);
    const connector = new Connector(1, new Logger(LogLevel.ERROR), () => store);
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 3,
    };
    armCharging(connector);
    return connector;
  }

  function phasedSamples(connector: Connector): (string | undefined)[] {
    return buildSampledValues(
      connector,
      ["Power.Active.Import"],
      "Sample.Periodic",
    )
      .filter((s) => s.phase !== undefined)
      .map((s) => s.phase);
  }

  it("keeps a Tx single-phase restriction when the station profile wins on watts", () => {
    // Tx: 32 A on one phase = 7360 W. Station max: 3000 W on three phases —
    // the tighter wattage, so it is what `resolveEffectiveLimitWatts` returns,
    // and its metadata used to be the only phase count anyone saw.
    const connector = connectorWithStationProfile(stationMaxProfile(3000, 3));
    connector.addChargingProfile(ampProfile(32, 1));

    expect(connector.currentScheduleLimitWatts()).toBe(3000);
    expect(connector.activePhaseCount()).toBe(1);
    expect(phasedSamples(connector)).toEqual([]);
  });

  it("keeps a station single-phase restriction when the Tx profile wins on watts", () => {
    const connector = connectorWithStationProfile(stationMaxProfile(50_000, 1));
    connector.addChargingProfile(ampProfile(10, 3));

    // The Tx side is the tighter wattage here; the station side still names
    // the tighter phase count.
    expect(connector.currentScheduleLimitWatts()).toBeLessThan(50_000);
    expect(connector.activePhaseCount()).toBe(1);
    expect(phasedSamples(connector)).toEqual([]);
  });

  it("takes the tighter of two restrictions", () => {
    const connector = connectorWithStationProfile(stationMaxProfile(50_000, 2));
    connector.addChargingProfile(ampProfile(10, 3));
    expect(connector.activePhaseCount()).toBe(2);
  });

  it("still emits three phases when neither profile restricts them", () => {
    const connector = connectorWithStationProfile(stationMaxProfile(50_000));
    connector.addChargingProfile(ampProfile(10, 3));
    expect(connector.activePhaseCount()).toBe(3);
    expect(phasedSamples(connector)).toEqual(["L1", "L2", "L3"]);
  });
});

describe("an amp limit converts on the joint phase count, not its own (#301)", () => {
  /**
   * The watt cap and the phase restriction are independent constraints, but
   * the A → W conversion depends on both, so it cannot run until both are
   * known. Converting each profile on its own `numberPhases` first and only
   * then taking the tighter wattage let a limit be exceeded on the phase
   * actually in use.
   */
  function stationMax(
    limitWatts: number,
    numberPhases?: number,
  ): ActiveChargingProfile {
    return {
      chargingProfileId: 303,
      connectorId: 0,
      stackLevel: 0,
      chargingProfilePurpose: ChargingProfilePurposeType.ChargePointMaxProfile,
      chargingProfileKind: ChargingProfileKindType.Relative,
      chargingRateUnit: ChargingRateUnitType.W,
      chargingSchedulePeriods: [
        {
          startPeriod: 0,
          limit: limitWatts,
          ...(numberPhases !== undefined ? { numberPhases } : {}),
        },
      ],
    };
  }

  function threePhase(station: ActiveChargingProfile | null): Connector {
    const store = new ChargingProfileStore();
    if (station) store.add(station);
    const connector = new Connector(1, new Logger(LogLevel.ERROR), () => store);
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 3,
    };
    armCharging(connector);
    return connector;
  }

  it("holds a 10 A three-phase Tx limit when a station profile restricts to one phase", () => {
    // The reported case: 10 A x 230 V x 3 = 6900 W beside a 3000 W station
    // cap on one phase. 3000 W won, delivery was on that one phase, and
    // 3000 / 230 is about 13 A — over the 10 A still in force.
    const connector = threePhase(stationMax(3000, 1));
    connector.addChargingProfile(ampProfile(10, 3));

    expect(connector.activePhaseCount()).toBe(1);
    const watts = connector.currentScheduleLimitWatts();
    expect(watts).toBeCloseTo(10 * 230, 6);
    // What the one active phase actually carries must not exceed the limit.
    expect(watts / (230 * connector.activePhaseCount())).toBeCloseTo(10, 6);
  });

  it("holds the limit with a non-unity power factor too", () => {
    const store = new ChargingProfileStore();
    store.add(stationMax(3000, 1));
    const connector = new Connector(1, new Logger(LogLevel.ERROR), () => store);
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 3,
      powerFactor: 0.9,
    };
    armCharging(connector);
    connector.addChargingProfile(ampProfile(10, 3));

    const watts = connector.currentScheduleLimitWatts();
    expect(watts).toBeCloseTo(10 * 230 * 0.9, 6);
    expect(watts / (230 * 1 * 0.9)).toBeCloseTo(10, 6);
  });

  it("is unchanged when both profiles agree on three phases", () => {
    const connector = threePhase(stationMax(50_000, 3));
    connector.addChargingProfile(ampProfile(10, 3));
    expect(connector.currentScheduleLimitWatts()).toBeCloseTo(10 * 230 * 3, 6);
    expect(connector.activePhaseCount()).toBe(3);
  });

  it("is unchanged when no profile names a phase count", () => {
    const connector = threePhase(stationMax(50_000));
    connector.addChargingProfile(ampProfile(10));
    expect(connector.currentScheduleLimitWatts()).toBeCloseTo(10 * 230 * 3, 6);
  });

  it("applies to a connector with no electrical model as well", () => {
    // The legacy conversion narrows too. It can only ever lower the cap, and
    // leaving it converting on phases another profile has excluded would keep
    // the violation alive for the connectors that say least about their
    // electrics.
    const store = new ChargingProfileStore();
    store.add(stationMax(3000, 1));
    const connector = new Connector(1, new Logger(LogLevel.ERROR), () => store);
    armCharging(connector);
    connector.addChargingProfile(ampProfile(10, 3));
    expect(connector.currentScheduleLimitWatts()).toBe(10 * 230);
  });
});

describe("the reported current divides by the phases in use (#301)", () => {
  // The third instance in this PR of one half of the pipeline reading the
  // resolved phase count while the other read the connector's wiring. Here
  // the watt cap was converted on the active count and the current derived
  // back on the wiring, so the sample contradicted the line it describes.
  function threePhase(): Connector {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 3,
    };
    armCharging(connector);
    return connector;
  }

  function reportedOffered(connector: Connector): number {
    const samples = buildSampledValues(
      connector,
      ["Current.Offered"],
      "Sample.Periodic",
    );
    return Number(samples.find((s) => s.phase === undefined)!.value);
  }

  it("reports 10 A, not 3.3 A, under a 10 A single-phase profile", () => {
    const connector = threePhase();
    connector.addChargingProfile(ampProfile(10, 1));
    expect(connector.activePhaseCount()).toBe(1);
    expect(connector.currentScheduleLimitWatts()).toBeCloseTo(10 * 230, 6);
    expect(reportedCurrentA(connector)).toBeCloseTo(10, 6);
  });

  it("applies the same count to Current.Offered", () => {
    const connector = threePhase();
    connector.addChargingProfile(ampProfile(10, 1));
    // Both currents in one message must describe the same conductors.
    expect(reportedOffered(connector)).toBeCloseTo(
      reportedCurrentA(connector),
      6,
    );
    expect(reportedOffered(connector)).toBeCloseTo(10, 6);
  });

  it("is unchanged on three phases, where the wiring and the active count agree", () => {
    const connector = threePhase();
    connector.addChargingProfile(ampProfile(10, 3));
    expect(reportedCurrentA(connector)).toBeCloseTo(10, 6);
  });

  it("is unchanged with no profile at all", () => {
    const connector = threePhase();
    // 350 kW ceiling, 230 V, three phases, unity cos φ.
    expect(reportedCurrentA(connector)).toBeCloseTo(350_000 / (230 * 3), 1);
  });
});

describe("a numberPhases of 0 is not a restriction (#301)", () => {
  /**
   * A station cannot deliver on zero phases, but the bundled OCPP schemas ask
   * only for an integer and the profile handlers do not reject zero, so a
   * conforming-looking CSMS can send one. Taken literally it divides by zero:
   * the active count becomes 0 and a positive W-based limit reports
   * `Current.Import` as `Infinity`, or `null` once serialised on 2.x.
   */
  function wattProfile(
    limitWatts: number,
    numberPhases?: number,
  ): ActiveChargingProfile {
    return {
      chargingProfileId: 304,
      connectorId: 1,
      stackLevel: 0,
      chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
      chargingProfileKind: ChargingProfileKindType.Relative,
      chargingRateUnit: ChargingRateUnitType.W,
      chargingSchedulePeriods: [
        {
          startPeriod: 0,
          limit: limitWatts,
          ...(numberPhases !== undefined ? { numberPhases } : {}),
        },
      ],
    };
  }

  function threePhase(): Connector {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 3,
    };
    armCharging(connector);
    return connector;
  }

  it("reports a finite current for a W profile carrying numberPhases 0", () => {
    const connector = threePhase();
    connector.addChargingProfile(wattProfile(6900, 0));

    expect(connector.activePhaseCount()).toBe(3);
    const reported = reportedCurrentA(connector);
    expect(Number.isFinite(reported)).toBe(true);
    expect(reported).toBeCloseTo(6900 / (230 * 3), 1);
  });

  it("puts no Infinity on the wire for any measurand", () => {
    const connector = threePhase();
    connector.addChargingProfile(wattProfile(6900, 0));
    const samples = buildSampledValues(
      connector,
      [
        "Current.Import",
        "Current.Offered",
        "Power.Active.Import",
        "Power.Offered",
        "Voltage",
      ],
      "Sample.Periodic",
    );
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.value).not.toContain("Infinity");
      expect(Number.isFinite(Number(sample.value))).toBe(true);
    }
  });

  it("does not cap an amp profile at zero watts because of numberPhases 0", () => {
    // Previously the joint count of 0 multiplied the conversion by zero, which
    // paused the session — a phase count is not how OCPP expresses a pause.
    const connector = threePhase();
    connector.addChargingProfile(ampProfile(16, 0));
    expect(connector.currentScheduleLimitWatts()).toBe(16 * 230 * 3);
  });

  it("does not cap at zero on a connector with no electrical model either", () => {
    const connector = makeConnector();
    armCharging(connector);
    connector.addChargingProfile(ampProfile(16, 0));
    expect(connector.currentScheduleLimitWatts()).toBe(16 * 230 * 3);
  });

  it("still honours a legal numberPhases of 2", () => {
    const connector = threePhase();
    connector.addChargingProfile(ampProfile(16, 2));
    expect(connector.activePhaseCount()).toBe(2);
    expect(connector.currentScheduleLimitWatts()).toBe(16 * 230 * 2);
  });
});

describe("scheduleLimitChange is emitted per crossing, not per sample (#301)", () => {
  /**
   * `currentScheduleLimitWatts()` is side-effecting, and building one sample
   * set calls it twice — once for accepted power, once for offered. A
   * subscriber counting Charging/SuspendedEVSE transitions must see one event
   * per real crossing, not one per call.
   */
  function pausingProfile(limitWatts: number): ActiveChargingProfile {
    return {
      chargingProfileId: 305,
      connectorId: 1,
      stackLevel: 0,
      chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
      chargingProfileKind: ChargingProfileKindType.Relative,
      chargingRateUnit: ChargingRateUnitType.W,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: limitWatts }],
    };
  }

  function countingConnector(): {
    connector: Connector;
    events: { paused: boolean; watts: number }[];
  } {
    const connector = makeConnector();
    armCharging(connector);
    const events: { paused: boolean; watts: number }[] = [];
    connector.events.on("scheduleLimitChange", (e) => events.push(e));
    return { connector, events };
  }

  it("emits once for a whole sample build, not once per derivation", () => {
    const { connector, events } = countingConnector();
    connector.addChargingProfile(pausingProfile(6000));

    buildSampledValues(
      connector,
      ["Power.Active.Import", "Power.Offered", "Current.Import"],
      "Sample.Periodic",
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.paused).toBe(false);
  });

  it("stays at one event across repeated sample builds while nothing crosses", () => {
    const { connector, events } = countingConnector();
    connector.addChargingProfile(pausingProfile(6000));
    for (let i = 0; i < 5; i++) {
      buildSampledValues(
        connector,
        ["Power.Active.Import", "Power.Offered"],
        "Sample.Periodic",
      );
    }
    expect(events).toHaveLength(1);
  });

  it("still emits on a real crossing into and out of paused", () => {
    const { connector, events } = countingConnector();
    connector.addChargingProfile(pausingProfile(6000));
    buildSampledValues(connector, ["Power.Active.Import"], "Sample.Periodic");
    expect(events).toHaveLength(1);

    // limit 0 = paused: a genuine crossing, so exactly one more event.
    connector.addChargingProfile(pausingProfile(0));
    buildSampledValues(
      connector,
      ["Power.Active.Import", "Power.Offered"],
      "Sample.Periodic",
    );
    expect(events).toHaveLength(2);
    expect(events[1]!.paused).toBe(true);

    connector.addChargingProfile(pausingProfile(6000));
    buildSampledValues(
      connector,
      ["Power.Active.Import", "Power.Offered"],
      "Sample.Periodic",
    );
    expect(events).toHaveLength(3);
    expect(events[2]!.paused).toBe(false);
  });

  it("emits nothing at all while no profile is active", () => {
    const { connector, events } = countingConnector();
    buildSampledValues(
      connector,
      ["Power.Active.Import", "Power.Offered"],
      "Sample.Periodic",
    );
    expect(events).toHaveLength(0);
  });
});

describe("printing a sample never carries it above the limit (#301)", () => {
  /**
   * The derivation is exact, but `Current.Import` is printed to one decimal
   * and `Power.Active.Import` to a whole watt, and rounding to nearest rounds
   * up. A binding 16.06 A limit derived 16.06 A and sent "16.1" — the station
   * reporting more than the CSMS allowed, which falsifies the guarantee that a
   * binding amp limit comes back as exactly that amperage, never above it.
   */
  function wattProfileAt(limitWatts: number): ActiveChargingProfile {
    return {
      chargingProfileId: 306,
      connectorId: 1,
      stackLevel: 0,
      chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
      chargingProfileKind: ChargingProfileKindType.Relative,
      chargingRateUnit: ChargingRateUnitType.W,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: limitWatts }],
    };
  }

  function singlePhase(): Connector {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 1,
    };
    armCharging(connector);
    return connector;
  }

  function valueOfMeasurand(connector: Connector, measurand: string): number {
    const samples = buildSampledValues(
      connector,
      [measurand],
      "Sample.Periodic",
    );
    return Number(samples.find((s) => s.phase === undefined)!.value);
  }

  it("rounds a 16.06 A limit down, not up", () => {
    const connector = singlePhase();
    connector.addChargingProfile(ampProfile(16.06, 1));
    expect(valueOfMeasurand(connector, "Current.Import")).toBe(16.0);
    expect(valueOfMeasurand(connector, "Current.Offered")).toBe(16.0);
  });

  it("never reports above the limit for any fractional amperage", () => {
    // The property, not one example: the printed value is a ceiling the CSMS
    // set, so it may fall short of the derivation but must never exceed it.
    for (const limit of [
      6.04, 10.06, 13.99, 16.06, 16.049, 20.999, 31.96, 32.05,
    ]) {
      const connector = singlePhase();
      connector.addChargingProfile(ampProfile(limit, 1));
      const reported = valueOfMeasurand(connector, "Current.Import");
      expect(reported).toBeLessThanOrEqual(limit);
      // And it stays within one printed digit of the limit, so bounding it has
      // not turned into silently reporting nothing.
      expect(reported).toBeGreaterThan(limit - 0.1);
    }
  });

  it("never reports above a fractional W limit either", () => {
    for (const limit of [6900.6, 3450.5, 11039.9, 22000.4]) {
      const connector = singlePhase();
      connector.addChargingProfile(wattProfileAt(limit));
      const power = valueOfMeasurand(connector, "Power.Active.Import");
      const offered = valueOfMeasurand(connector, "Power.Offered");
      expect(power).toBeLessThanOrEqual(limit);
      expect(offered).toBeLessThanOrEqual(limit);
      expect(power).toBeGreaterThan(limit - 1);
    }
  });

  it("keeps per-phase legs under their share of the limit", () => {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 3,
    };
    armCharging(connector);
    // 6901.5 / 3 = 2300.5, which rounds *up* to 2301 — so this only passes if
    // each leg is bounded by its own third of the cap, not by the whole.
    connector.addChargingProfile(wattProfileAt(6901.5));
    const legs = buildSampledValues(
      connector,
      ["Power.Active.Import"],
      "Sample.Periodic",
    ).filter((s) => s.phase !== undefined);
    expect(legs).toHaveLength(3);
    for (const leg of legs) {
      expect(Number(leg.value)).toBeLessThanOrEqual(6901.5 / 3);
    }
  });

  it("leaves an unbounded sample rounded to nearest, as before", () => {
    // No profile: the bound is Infinity and this is exactly `toFixed`, so the
    // pre-v1.2 strings are untouched. 350 kW / 230 V = 1521.739… → "1521.7".
    const connector = singlePhase();
    expect(valueOfMeasurand(connector, "Current.Import")).toBe(1521.7);
  });

  it("leaves a whole-number limit exact, not one digit short", () => {
    const connector = singlePhase();
    connector.addChargingProfile(ampProfile(16, 1));
    expect(valueOfMeasurand(connector, "Current.Import")).toBe(16.0);
  });
});

describe("the cap and the phase count come from one instant (#301)", () => {
  /**
   * Both constraints are read for every MeterValue and each used to resolve
   * against its own `new Date()`. A schedule period boundary falling between
   * the two calls took the cap from one period and the divisor from the next:
   * a 10 A three-phase period caps at 6900 W, is then divided as one phase,
   * and reports 30 A — one sample set describing two instants.
   */
  const START = new Date("2026-07-01T00:00:00.000Z");

  function twoPeriodProfile(): ActiveChargingProfile {
    return {
      chargingProfileId: 307,
      connectorId: 1,
      stackLevel: 0,
      chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
      chargingProfileKind: ChargingProfileKindType.Relative,
      chargingRateUnit: ChargingRateUnitType.A,
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 10, numberPhases: 3 },
        { startPeriod: 60, limit: 10, numberPhases: 1 },
      ],
    };
  }

  function connectorAtStart(): Connector {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      maxChargingPowerKw: 350,
      currentType: "AC",
      phases: 3,
    };
    connector.socMeterSyncEnabled = false;
    connector.soc = 50;
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction({
      id: 307,
      connectorId: 1,
      tagId: "TAG-CLOCK",
      meterStart: 0,
      meterStop: null,
      startTime: START,
      stopTime: null,
      meterSent: false,
    });
    connector.addChargingProfile(twoPeriodProfile());
    return connector;
  }

  /** Make each argument-less `new Date()` return the next value in turn, so a
   *  second resolve inside one sample build lands in the next period. */
  function stubClockSequence(offsetsSeconds: number[]): () => void {
    const RealDate = Date;
    let call = 0;
    class SequencedDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) {
          const i = Math.min(call++, offsetsSeconds.length - 1);
          super(START.getTime() + offsetsSeconds[i]! * 1000);
        } else {
          // @ts-expect-error forwarding the real Date overloads verbatim
          super(...args);
        }
      }
    }
    vi.stubGlobal("Date", SequencedDate);
    return () => vi.unstubAllGlobals();
  }

  afterEach(() => vi.unstubAllGlobals());

  it("does not mix a cap from one period with a divisor from the next", () => {
    const connector = connectorAtStart();
    // First reading inside period 0 (three phases), any second reading inside
    // period 1 (one phase). One resolve means the second never happens.
    const restore = stubClockSequence([10, 70]);
    try {
      const { watts, activePhases } = connector.scheduleConstraints();
      expect(watts).toBeCloseTo(10 * 230 * 3, 6);
      expect(activePhases).toBe(3);
      // The pair is coherent: dividing this cap by these phases is the limit.
      expect(watts / (230 * activePhases)).toBeCloseTo(10, 6);
    } finally {
      restore();
    }
  });

  it("reports the limit, not three times it, across the boundary", () => {
    const connector = connectorAtStart();
    const restore = stubClockSequence([10, 70]);
    try {
      const reported = reportedCurrentA(connector);
      expect(reported).toBeCloseTo(10, 1);
      expect(reported).toBeLessThanOrEqual(10);
    } finally {
      restore();
    }
  });

  it("resolves the later period coherently once the boundary has passed", () => {
    const connector = connectorAtStart();
    const restore = stubClockSequence([70, 130]);
    try {
      const { watts, activePhases } = connector.scheduleConstraints();
      expect(watts).toBeCloseTo(10 * 230, 6);
      expect(activePhases).toBe(1);
      expect(watts / (230 * activePhases)).toBeCloseTo(10, 6);
    } finally {
      restore();
    }
  });
});

describe("a pause crossing is not latched where nothing can act on it (#301)", () => {
  /**
   * The `scheduleLimitChange` listener toggles Charging ↔ SuspendedEVSE and
   * does nothing in any other state. A scenario's first MeterValue lands while
   * the connector is still `Preparing`, before StartTransaction is accepted —
   * so a `limit: 0` profile already in force latched its crossing there, the
   * listener could not act, and every later resolve found the latch set and
   * stayed silent. The connector then reported Charging with its meter paused.
   *
   * Being idempotent against repetition, which the latch is, is a different
   * property from being safe in a state where the edge cannot be used.
   */
  function pausedProfile(): ActiveChargingProfile {
    return {
      chargingProfileId: 308,
      connectorId: 1,
      stackLevel: 0,
      chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
      chargingProfileKind: ChargingProfileKindType.Relative,
      chargingRateUnit: ChargingRateUnitType.W,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 0 }],
    };
  }

  function preparingConnector(): {
    connector: Connector;
    events: { paused: boolean; watts: number }[];
  } {
    const connector = makeConnector();
    connector.evSettings = { ...connector.evSettings, maxChargingPowerKw: 350 };
    connector.status = OCPPStatus.Preparing;
    connector.beginTransaction(transaction());
    connector.addChargingProfile(pausedProfile());
    const events: { paused: boolean; watts: number }[] = [];
    connector.events.on("scheduleLimitChange", (e) => events.push(e));
    return { connector, events };
  }

  it("announces the pause once the connector reaches Charging, not before", () => {
    const { connector, events } = preparingConnector();

    // The scenario's usual MeterValue, sent while still Preparing.
    buildSampledValues(connector, ["Power.Active.Import"], "Sample.Periodic");
    expect(events).toHaveLength(0);

    // StartTransaction accepted.
    connector.status = OCPPStatus.Charging;
    buildSampledValues(connector, ["Power.Active.Import"], "Sample.Periodic");
    expect(events).toHaveLength(1);
    expect(events[0]!.paused).toBe(true);
  });

  it("does not re-announce on every later sample once Charging", () => {
    const { connector, events } = preparingConnector();
    connector.status = OCPPStatus.Charging;
    for (let i = 0; i < 4; i++) {
      buildSampledValues(connector, ["Power.Active.Import"], "Sample.Periodic");
    }
    expect(events).toHaveLength(1);
  });

  it("announces a resume from SuspendedEVSE", () => {
    // The other state the listener acts in, so a crossing seen there must
    // still be announced.
    const { connector, events } = preparingConnector();
    connector.status = OCPPStatus.SuspendedEVSE;
    buildSampledValues(connector, ["Power.Active.Import"], "Sample.Periodic");
    expect(events).toHaveLength(1);
    expect(events[0]!.paused).toBe(true);

    connector.setChargingProfiles([]);
    connector.addChargingProfile({
      ...pausedProfile(),
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 7000 }],
    });
    buildSampledValues(connector, ["Power.Active.Import"], "Sample.Periodic");
    expect(events).toHaveLength(2);
    expect(events[1]!.paused).toBe(false);
  });
});

describe("clearing a profile disarms the latch in any status (#301)", () => {
  /**
   * The status guard is right about *what* it suppresses and was wrong about
   * *where* it returned: not announcing outside Charging/SuspendedEVSE is
   * correct, not disarming is not. A `paused` latched by a previous
   * transaction survived the gap between sessions, and the first resolve of
   * the next one matched the stale value and stayed silent — the meter capped
   * at zero while the connector reported Charging.
   */
  function zeroLimitProfile(id = 309): ActiveChargingProfile {
    return {
      chargingProfileId: id,
      connectorId: 1,
      stackLevel: 0,
      chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
      chargingProfileKind: ChargingProfileKindType.Relative,
      chargingRateUnit: ChargingRateUnitType.W,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 0 }],
    };
  }

  function sample(connector: Connector): void {
    buildSampledValues(connector, ["Power.Active.Import"], "Sample.Periodic");
  }

  function armed(): {
    connector: Connector;
    events: { paused: boolean; watts: number }[];
  } {
    const connector = makeConnector();
    connector.evSettings = { ...connector.evSettings, maxChargingPowerKw: 350 };
    const events: { paused: boolean; watts: number }[] = [];
    connector.events.on("scheduleLimitChange", (e) => events.push(e));
    return { connector, events };
  }

  it("announces the next pause after an uncapped sample seen while Preparing", () => {
    const { connector, events } = armed();

    // A session that ends paused: the latch is left at `true`.
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction());
    connector.addChargingProfile(zeroLimitProfile());
    sample(connector);
    expect(events).toHaveLength(1);
    expect(events[0]!.paused).toBe(true);
    connector.stopTransaction();

    // Its profile is cleared, and the next transaction's first MeterValue
    // lands while the connector is still Preparing. Nothing is announced
    // there — but the latch has to be disarmed, or the stale `true` outlives
    // the session that set it.
    connector.setChargingProfiles([]);
    connector.status = OCPPStatus.Preparing;
    connector.beginTransaction(transaction());
    sample(connector);
    expect(events).toHaveLength(1);

    // A zero-limit profile arrives before StartTransaction is accepted, then
    // the connector reaches Charging. This pause must be announced.
    connector.addChargingProfile(zeroLimitProfile(310));
    connector.status = OCPPStatus.Charging;
    sample(connector);
    expect(events).toHaveLength(2);
    expect(events[1]!.paused).toBe(true);
  });

  it("disarms while Preparing even with no transaction attached", () => {
    // The same disarm, reached with the connector fully idle.
    const { connector, events } = armed();
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction());
    connector.addChargingProfile(zeroLimitProfile());
    sample(connector);
    expect(events).toHaveLength(1);

    connector.stopTransaction();
    connector.setChargingProfiles([]);
    connector.status = OCPPStatus.Available;
    sample(connector);

    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction());
    connector.addChargingProfile(zeroLimitProfile(311));
    sample(connector);
    expect(events).toHaveLength(2);
    expect(events[1]!.paused).toBe(true);
  });

  it("still does not announce the disarm itself", () => {
    // Clearing a profile is bookkeeping: it emits nothing, in any status.
    const { connector, events } = armed();
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction(transaction());
    connector.addChargingProfile(zeroLimitProfile());
    sample(connector);
    expect(events).toHaveLength(1);

    connector.setChargingProfiles([]);
    sample(connector);
    sample(connector);
    expect(events).toHaveLength(1);
  });
});
