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

  describe("remove", () => {
    it("removes by profileId", () => {
      const store = new ChargingProfileStore();
      store.add(profile({ chargingProfileId: 1 }));
      store.add(profile({ chargingProfileId: 2 }));
      expect(store.remove({ profileId: 1 })).toBe(1);
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
        store.remove({ purpose: ChargingProfilePurposeType.TxDefaultProfile }),
      ).toBe(1);
      expect(store.all()).toHaveLength(1);
    });

    it("clears all when called with no criteria", () => {
      const store = new ChargingProfileStore();
      store.add(profile({ chargingProfileId: 1 }));
      store.add(profile({ chargingProfileId: 2 }));
      expect(store.remove({})).toBe(2);
      expect(store.all()).toEqual([]);
    });
  });
});
