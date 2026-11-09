import { describe, expect, it } from "vitest";
import {
  chargerTermOf,
  resolveOperatingPoint,
  vehicleTermOf,
  type OperatingPointInputs,
} from "../OperatingPoint";
import type { EVSettings } from "../EVSettings";

/**
 * #835: the vehicle's demand is a term of the one operating point resolution,
 * next to the vehicle ceiling and the curve (#327). It caps what the battery
 * accepts, never what the CSMS or the charger allow, and never the offer.
 */

const EV: EVSettings = {
  modelName: "t",
  batteryCapacityKwh: 60,
  maxChargingPowerKw: 11,
  initialSoc: 20,
  targetSoc: 80,
  currentType: "AC",
  phases: 3,
  voltageV: 230,
};

function point(
  opts: {
    demandW?: number;
    scheduleW?: number;
    chargerW?: number;
    ev?: Partial<EVSettings>;
    soc?: number;
  } = {},
) {
  const inputs: OperatingPointInputs = {
    at: 0,
    charging: true,
    soc: opts.soc ?? 50,
    schedule: { scheduleLimitW: opts.scheduleW ?? Infinity, activePhases: 3 },
    vehicle: vehicleTermOf({ ...EV, ...opts.ev }),
    session: { initialSoc: 20 },
    charger: chargerTermOf(opts.chargerW),
    fault: { offering: true, energyOfferSuspended: false },
    meter: {},
    ...(opts.demandW !== undefined && {
      demand: { requestedW: opts.demandW },
    }),
  };
  return resolveOperatingPoint(inputs);
}

describe("vehicle demand in the operating point (#835)", () => {
  it("without a demand the point is what it was", () => {
    const p = point();
    expect(p.acceptedW).toBe(11_000);
    expect(p.demandW).toBe(Infinity);
    expect(p.limitedBy).toBe("vehicle");
  });

  it("EV demand below the CSMS allocation: the vehicle sets the power", () => {
    const p = point({ demandW: 3_000, scheduleW: 5_000, chargerW: 11_000 });
    expect(p.acceptedW).toBe(3_000);
    expect(p.accumulationCapW).toBe(3_000);
    expect(p.limitedBy).toBe("vehicle");
    // The offer is the EVSE's: the vehicle asking for less does not shrink it.
    expect(p.offeredW).toBe(5_000);
  });

  it("CSMS allocation below the EV demand: the schedule sets the power", () => {
    const p = point({ demandW: 7_400, scheduleW: 5_000, chargerW: 11_000 });
    expect(p.acceptedW).toBe(5_000);
    expect(p.limitedBy).toBe("schedule");
  });

  it("demand cannot exceed the charger cap or the vehicle ceiling", () => {
    expect(point({ demandW: 50_000, chargerW: 7_000 }).acceptedW).toBe(7_000);
    expect(point({ demandW: 50_000 }).acceptedW).toBe(11_000);
  });

  it("demand 0 accepts nothing but keeps the offer", () => {
    const p = point({ demandW: 0, scheduleW: 5_000 });
    expect(p.acceptedW).toBe(0);
    expect(p.accumulationCapW).toBe(0);
    expect(p.currentA).toBe(0);
    expect(p.offeredW).toBe(5_000);
  });

  it("is applied after the curve, not as a smaller ceiling", () => {
    const curve = [
      { socPercent: 0, powerFraction: 1 },
      { socPercent: 100, powerFraction: 0.5 },
    ];
    // At 100% the battery takes half of 11 kW = 5.5 kW. A 4 kW demand is
    // below it; a 9 kW demand is above it and the curve still binds.
    expect(
      point({ soc: 100, ev: { chargingCurve: curve }, demandW: 4_000 })
        .acceptedW,
    ).toBe(4_000);
    expect(
      point({ soc: 100, ev: { chargingCurve: curve }, demandW: 9_000 })
        .acceptedW,
    ).toBe(5_500);
  });

  it("is a finite request even for a vehicle with no known ceiling", () => {
    const p = point({ ev: { maxChargingPowerKw: 0 }, demandW: 2_000 });
    expect(p.acceptedW).toBe(2_000);
    expect(p.accumulationCapW).toBe(2_000);
  });

  it("a curve-less point keeps its register bound without a demand", () => {
    const p = point({ scheduleW: 4_000 });
    expect(p.accumulationCapW).toBe(p.boundW);
  });
});

describe("vehicleBehavior in the EV settings (#835)", () => {
  it("refuses a behavior that cannot run, changing nothing", async () => {
    const { Connector } = await import("../Connector");
    const { Logger, LogLevel } = await import("../../../shared/Logger");
    const connector = new Connector(1, new Logger(LogLevel.ERROR));
    expect(() =>
      connector.applyEvSettingsOverride({
        vehicleBehavior: { preset: "nope" } as never,
      }),
    ).toThrow(/vehicleBehavior: unknown vehicleBehavior preset nope/);
    expect(connector.evSettings.vehicleBehavior).toBeUndefined();
    connector.applyEvSettingsOverride({
      vehicleBehavior: { preset: "overnight" },
    });
    expect(connector.vehicleBehavior?.policy.type).toBe("scheduled-window");
    connector.applyEvSettingsOverride({ vehicleBehavior: null });
    expect(connector.vehicleBehavior).toBeNull();
  });
});
