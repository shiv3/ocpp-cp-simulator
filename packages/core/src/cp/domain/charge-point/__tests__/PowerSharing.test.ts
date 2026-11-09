import { describe, expect, it } from "vitest";
import {
  connectorShareW,
  currentLimitToWatts,
  powerSharingProblem,
  stationBudgetW,
  type ShareParticipant,
} from "../PowerSharing";
import {
  chargerTermOf,
  resolveOperatingPoint,
  vehicleTermOf,
} from "../../connector/OperatingPoint";
import { chargerCapabilitiesProblem } from "../ChargerCapabilities";

const two = (
  a: boolean,
  b: boolean,
  capA = Infinity,
  capB = Infinity,
): ShareParticipant[] => [
  { connectorId: 1, capW: capA, active: a },
  { connectorId: 2, capW: capB, active: b },
];

describe("connectorShareW (#608)", () => {
  it("equal: the budget is split between all connectors, active or not", () => {
    expect(connectorShareW(22_000, "equal", two(true, false), 1)).toBe(11_000);
    expect(connectorShareW(22_000, "equal", two(true, true), 2)).toBe(11_000);
  });

  it("active: split between the connectors with a transaction", () => {
    expect(connectorShareW(22_000, "active", two(true, false), 1)).toBe(22_000);
    expect(connectorShareW(22_000, "active", two(true, true), 1)).toBe(11_000);
  });

  it("active: an idle connector sees the share it would get on joining", () => {
    expect(connectorShareW(22_000, "active", two(true, false), 2)).toBe(11_000);
  });

  it("a part above a connector's own cap goes to the others", () => {
    const parts = two(true, true, 5_000, Infinity);
    expect(connectorShareW(22_000, "active", parts, 1)).toBe(5_000);
    expect(connectorShareW(22_000, "active", parts, 2)).toBe(17_000);
  });

  it("no declared budget means no share", () => {
    expect(connectorShareW(Infinity, "equal", two(true, true), 1)).toBe(
      Infinity,
    );
  });

  it("shares never add up to more than the budget", () => {
    const parts: ShareParticipant[] = [1, 2, 3].map((id) => ({
      connectorId: id,
      capW: [3_000, 9_000, Infinity][id - 1],
      active: true,
    }));
    const sum = [1, 2, 3].reduce(
      (acc, id) => acc + connectorShareW(20_000, "equal", parts, id),
      0,
    );
    expect(sum).toBeCloseTo(20_000);
  });
});

describe("station budget (#608)", () => {
  const limit = { key: "VendorMaxCurrent", valueA: 32, phases: 3 as const };
  it("a current limit converts with voltage and phases", () => {
    expect(currentLimitToWatts(limit, 32)).toBe(32 * 230 * 3);
  });
  it("the lower of the total and the current limit applies", () => {
    expect(
      stationBudgetW({ totalPowerW: 11_000, currentLimit: limit }, 32),
    ).toBe(11_000);
    expect(
      stationBudgetW({ totalPowerW: 30_000, currentLimit: limit }, 16),
    ).toBe(16 * 690);
  });
  it("nothing declared is no budget", () => {
    expect(stationBudgetW(undefined, undefined)).toBe(Infinity);
  });
});

describe("station term and efficiency in the operating point (#608)", () => {
  const ev = {
    modelName: "t",
    batteryCapacityKwh: 60,
    maxChargingPowerKw: 100,
    initialSoc: 20,
    targetSoc: 80,
    currentType: "DC" as const,
    voltageV: 400,
  };
  const resolve = (
    station: { stationShareW?: number; conversionEfficiency?: number },
    cap?: number,
    type: "AC" | "DC" = "DC",
  ) =>
    resolveOperatingPoint({
      at: 0,
      charging: true,
      soc: 50,
      schedule: { scheduleLimitW: Infinity, activePhases: 1 },
      vehicle: vehicleTermOf({ ...ev, currentType: type }),
      session: { initialSoc: 20 },
      charger: chargerTermOf(cap, station),
      fault: { offering: true, energyOfferSuspended: false },
      meter: {},
    });

  it("the share narrows the connector cap and is reported as the charger limit", () => {
    const p = resolve({ stationShareW: 40_000 }, 60_000);
    expect(p.chargerCapW).toBe(40_000);
    expect(p.acceptedW).toBe(40_000);
    expect(p.limitedBy).toBe("charger");
  });
  it("the connector's own cap wins when lower than the share", () => {
    expect(resolve({ stationShareW: 40_000 }, 30_000).acceptedW).toBe(30_000);
  });
  it("without the settings the point is unchanged", () => {
    const p = resolve({});
    expect(p.chargerCapW).toBe(Infinity);
    expect(p.inputW).toBe(p.acceptedW);
    expect(p.conversionEfficiency).toBe(1);
  });
  it("efficiency raises the AC input, not the vehicle side", () => {
    const p = resolve({ conversionEfficiency: 0.95 }, 50_000);
    expect(p.acceptedW).toBe(50_000);
    expect(p.inputW).toBeCloseTo(50_000 / 0.95);
  });
  it("efficiency does not apply to an AC vehicle", () => {
    const p = resolve({ conversionEfficiency: 0.95 }, 7_000, "AC");
    expect(p.inputW).toBe(p.acceptedW);
  });
});

describe("configuration problems (#608)", () => {
  it("accepts a valid sharing block and efficiency", () => {
    expect(
      chargerCapabilitiesProblem({
        connectors: [
          { connectorId: 1, maxDeliveryPowerW: 50_000, dcEfficiency: 0.95 },
        ],
        powerSharing: { totalPowerW: 50_000, strategy: "active" },
      }),
    ).toBeNull();
  });
  it("names what is wrong", () => {
    expect(powerSharingProblem({})).toMatch(/totalPowerW or currentLimit/);
    expect(powerSharingProblem({ totalPowerW: 1, strategy: "fair" })).toMatch(
      /strategy/,
    );
    expect(
      powerSharingProblem({ currentLimit: { key: "", valueA: 1 } }),
    ).toMatch(/key/);
    expect(
      chargerCapabilitiesProblem({
        connectors: [
          { connectorId: 1, maxDeliveryPowerW: 1, dcEfficiency: 1.2 },
        ],
      }),
    ).toMatch(/dcEfficiency/);
  });
});
