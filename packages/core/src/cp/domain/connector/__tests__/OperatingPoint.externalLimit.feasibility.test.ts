import { describe, expect, it } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import {
  chargerTermOf,
  resolveOperatingPoint,
  vehicleTermOf,
  type OperatingPointInputs,
} from "../OperatingPoint";

/**
 * Feasibility evidence for #931 (docs/analyses/ems-lms-cosimulation-interop.md).
 * NOT a feature: no production code reads an "external limit" today. The test
 * shows that the existing resolver already composes an extra, independent
 * cap correctly if it is passed as one more term, and where it does not yet
 * say why (`limitedBy`). It uses `ChargerTerm.stationShareW` as a stand-in for
 * the proposed `ExternalTerm`.
 */
const EV_SETTINGS = new Connector(1, new Logger(LogLevel.ERROR)).evSettings;

function inputs(opts: {
  scheduleLimitW: number;
  externalW?: number;
  currentType?: "AC" | "DC";
  efficiency?: number;
  demandW?: number;
}): OperatingPointInputs {
  return {
    at: 0,
    charging: true,
    soc: 50,
    schedule: { scheduleLimitW: opts.scheduleLimitW, activePhases: 3 },
    vehicle: vehicleTermOf({
      ...EV_SETTINGS,
      maxChargingPowerKw: 22,
      currentType: opts.currentType ?? "AC",
      voltageV: 230,
      phases: 3,
      powerFactor: 1,
    }),
    session: { initialSoc: 50 },
    charger: chargerTermOf(undefined, {
      stationShareW: opts.externalW,
      conversionEfficiency: opts.efficiency,
    }),
    meter: {},
    fault: { offering: true, energyOfferSuspended: false },
    demand: { requestedW: opts.demandW ?? 11_000 },
  };
}

describe("an external cap as one more independent term (#931 feasibility)", () => {
  it("9 kW profile + 6 kW external + 11 kW demand: the tighter cap binds, nothing else is written", () => {
    const profileOnly = resolveOperatingPoint(
      inputs({ scheduleLimitW: 9_000 }),
    );
    expect(profileOnly.acceptedW).toBe(9_000);
    expect(profileOnly.limitedBy).toBe("schedule");

    const both = resolveOperatingPoint(
      inputs({ scheduleLimitW: 9_000, externalW: 6_000 }),
    );
    expect(both.acceptedW).toBe(6_000);
    expect(both.offeredW).toBe(6_000);
    expect(both.accumulationCapW).toBe(6_000);
    // The CSMS allocation is unchanged: the profile still resolves to 9 kW.
    expect(both.scheduleLimitW).toBe(9_000);
    // GAP: the reason is reported as "charger", because the stand-in shares
    // the hardware term. A real term needs its own reason, "external".
    expect(both.limitedBy).toBe("charger");
  });

  it("removing the external cap recovers the profile limit at once", () => {
    const capped = resolveOperatingPoint(
      inputs({ scheduleLimitW: 9_000, externalW: 6_000 }),
    );
    const cleared = resolveOperatingPoint(
      inputs({ scheduleLimitW: 9_000, externalW: undefined }),
    );
    expect(capped.acceptedW).toBe(6_000);
    expect(cleared.acceptedW).toBe(9_000);
  });

  it("an external cap above the profile and the demand changes nothing", () => {
    const point = resolveOperatingPoint(
      inputs({ scheduleLimitW: 9_000, externalW: 20_000 }),
    );
    expect(point.acceptedW).toBe(9_000);
    expect(point.limitedBy).toBe("schedule");
  });

  it("amperes convert with the point's own voltage and phases", () => {
    // 3 x 230 V, pf 1: 16 A per phase = 11 040 W; the point reports the same
    // current back (no second conversion path).
    const watts = 16 * 230 * 3;
    const point = resolveOperatingPoint(
      inputs({ scheduleLimitW: Infinity, externalW: watts, demandW: 20_000 }),
    );
    expect(point.acceptedW).toBe(watts);
    expect(point.currentA).toBeCloseTo(16, 6);
  });

  it("DC: a cap on the connector output differs from a cap on the grid input", () => {
    const eff = 0.95;
    const outputCapped = resolveOperatingPoint(
      inputs({
        scheduleLimitW: Infinity,
        externalW: 6_000,
        currentType: "DC",
        efficiency: eff,
      }),
    );
    expect(outputCapped.acceptedW).toBe(6_000);
    expect(outputCapped.inputW).toBeCloseTo(6_000 / eff, 6); // 6 316 W > 6 kW
    // A site EMS limits what it draws from the grid: convert before applying.
    const inputCapped = resolveOperatingPoint(
      inputs({
        scheduleLimitW: Infinity,
        externalW: 6_000 * eff,
        currentType: "DC",
        efficiency: eff,
      }),
    );
    expect(inputCapped.inputW).toBeCloseTo(6_000, 6);
  });
});
