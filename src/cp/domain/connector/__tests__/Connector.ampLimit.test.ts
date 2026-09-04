import { describe, it, expect } from "vitest";
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
        ...(numberPhases ? { numberPhases } : {}),
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

  it("stays under the limit when the profile restricts a 3-phase connector to one phase", () => {
    const connector = makeConnector();
    connector.evSettings = {
      ...connector.evSettings,
      currentType: "AC",
      phases: 3,
    };
    armCharging(connector);
    connector.addChargingProfile(ampProfile(16, 1));

    // The CSMS restricted delivery to one phase, so the cap drops to
    // 16 A on one phase; the meter still reports a 3-phase aggregate, which
    // is therefore a third of the per-phase limit — under it, never over.
    expect(connector.currentScheduleLimitWatts()).toBeCloseTo(16 * 230, 6);
    const reported = reportedCurrentA(connector);
    // `Current.Import` is reported to one decimal.
    expect(reported).toBeCloseTo(16 / 3, 1);
    expect(reported).toBeLessThanOrEqual(16);
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
          ...(numberPhases ? { numberPhases } : {}),
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
          ...(numberPhases ? { numberPhases } : {}),
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
