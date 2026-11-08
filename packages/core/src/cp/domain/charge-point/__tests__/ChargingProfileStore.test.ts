import { describe, it, expect } from "vitest";
import { ChargingProfileStore } from "../ChargingProfileStore";
import type { ActiveChargingProfile } from "../../connector/Connector";
import {
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
} from "../../types/OcppTypes";

function profile(
  over: Partial<ActiveChargingProfile> = {},
): ActiveChargingProfile {
  return {
    chargingProfileId: 1,
    connectorId: 0,
    stackLevel: 0,
    chargingProfilePurpose: ChargingProfilePurposeType.ChargePointMaxProfile,
    chargingProfileKind: ChargingProfileKindType.Absolute,
    chargingRateUnit: ChargingRateUnitType.W,
    chargingSchedulePeriods: [{ startPeriod: 0, limit: 5000 }],
    ...over,
  };
}

describe("ChargingProfileStore", () => {
  it("starts empty", () => {
    const store = new ChargingProfileStore();
    expect(store.all()).toEqual([]);
    expect(
      store.getActive(ChargingProfilePurposeType.ChargePointMaxProfile),
    ).toBeNull();
  });

  it("replaces a profile with the same id (§5.16)", () => {
    const store = new ChargingProfileStore();
    store.add(profile({ chargingProfileId: 7, stackLevel: 1 }));
    store.add(
      profile({ chargingProfileId: 7, stackLevel: 5 }), // same id, new stack
    );
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].stackLevel).toBe(5);
  });

  it("returns the highest-stack profile for a purpose", () => {
    const store = new ChargingProfileStore();
    store.add(profile({ chargingProfileId: 1, stackLevel: 1 }));
    store.add(profile({ chargingProfileId: 2, stackLevel: 9 }));
    store.add(profile({ chargingProfileId: 3, stackLevel: 4 }));
    const active = store.getActive(
      ChargingProfilePurposeType.ChargePointMaxProfile,
    );
    expect(active?.chargingProfileId).toBe(2);
  });

  it("filters by purpose", () => {
    const store = new ChargingProfileStore();
    store.add(profile({ chargingProfileId: 1, stackLevel: 9 }));
    store.add(
      profile({
        chargingProfileId: 2,
        stackLevel: 5,
        chargingProfilePurpose: ChargingProfilePurposeType.TxDefaultProfile,
      }),
    );
    expect(
      store.getActive(ChargingProfilePurposeType.TxDefaultProfile)
        ?.chargingProfileId,
    ).toBe(2);
  });

  it("ignores profiles outside their validity window", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const store = new ChargingProfileStore();
    store.add(profile({ chargingProfileId: 1, validTo: past }));
    expect(
      store.getActive(ChargingProfilePurposeType.ChargePointMaxProfile),
    ).toBeNull();
  });

  it("treats validTo as exclusive: now == validTo is outside [validFrom, validTo) (K01.FR.37, #707)", () => {
    const validTo = "2026-08-01T00:00:00.000Z";
    const store = new ChargingProfileStore();
    store.add(profile({ chargingProfileId: 1, validTo }));
    const purpose = ChargingProfilePurposeType.ChargePointMaxProfile;
    expect(
      store.getActive(purpose, new Date("2026-07-31T23:59:59.999Z")),
    ).not.toBeNull();
    expect(store.getActive(purpose, new Date(validTo))).toBeNull();
  });

  describe("take", () => {
    it("removes by profileId", () => {
      const store = new ChargingProfileStore();
      store.add(profile({ chargingProfileId: 1 }));
      store.add(profile({ chargingProfileId: 2 }));
      expect(store.take({ profileId: 1 }).length).toBe(1);
      expect(store.all()).toHaveLength(1);
    });

    it("removes by purpose", () => {
      const store = new ChargingProfileStore();
      store.add(profile({ chargingProfileId: 1 }));
      store.add(
        profile({
          chargingProfileId: 2,
          chargingProfilePurpose: ChargingProfilePurposeType.TxDefaultProfile,
        }),
      );
      expect(
        store
          .take({ purpose: ChargingProfilePurposeType.TxDefaultProfile })
          .map((p) => p.chargingProfileId),
      ).toEqual([2]);
      expect(store.all()).toHaveLength(1);
    });

    it("clears all when called with no criteria", () => {
      const store = new ChargingProfileStore();
      store.add(profile({ chargingProfileId: 1 }));
      store.add(profile({ chargingProfileId: 2 }));
      expect(store.take({}).length).toBe(2);
      expect(store.all()).toEqual([]);
    });
  });
});

describe("ChargingProfileStore: schedule duration (1.6 errata 3.43)", () => {
  const now = new Date("2026-01-01T00:10:01Z");
  const upper = profile({
    chargingProfileId: 2,
    stackLevel: 2,
    startSchedule: "2026-01-01T00:00:00Z",
    duration: 600,
    chargingSchedulePeriods: [{ startPeriod: 0, limit: 1000 }],
  });

  it("falls back to the next lower stackLevel once the duration has elapsed", () => {
    const store = new ChargingProfileStore();
    store.add(profile({ chargingProfileId: 1, stackLevel: 1 }));
    store.add(upper);
    const purpose = ChargingProfilePurposeType.ChargePointMaxProfile;
    expect(
      store.getActive(purpose, new Date("2026-01-01T00:09:59Z"))
        ?.chargingProfileId,
    ).toBe(2);
    expect(store.getActive(purpose, now)?.chargingProfileId).toBe(1);
  });

  it("has no active profile when nothing lower exists", () => {
    const store = new ChargingProfileStore();
    store.add(upper);
    expect(
      store.getActive(ChargingProfilePurposeType.ChargePointMaxProfile, now),
    ).toBeNull();
  });
});
