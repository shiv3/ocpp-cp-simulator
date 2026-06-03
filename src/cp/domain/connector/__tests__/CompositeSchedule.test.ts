import { describe, it, expect } from "vitest";
import {
  buildCompositeWattsSchedule,
  resolveEffectiveLimitWatts,
} from "../ChargingScheduleResolver";
import type { ActiveChargingProfile } from "../Connector";
import {
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
  RecurrencyKindType,
} from "../../types/OcppTypes";

function profile(
  over: Partial<ActiveChargingProfile> = {},
): ActiveChargingProfile {
  return {
    chargingProfileId: 1,
    connectorId: 1,
    stackLevel: 0,
    chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
    chargingProfileKind: ChargingProfileKindType.Relative,
    chargingRateUnit: ChargingRateUnitType.W,
    chargingSchedulePeriods: [{ startPeriod: 0, limit: 7000 }],
    ...over,
  };
}

describe("resolveEffectiveLimitWatts", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-01-01T00:00:30Z");

  it("returns the tx limit when no station max profile is present", () => {
    const tx = profile({
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 6000 }],
    });
    const res = resolveEffectiveLimitWatts(tx, null, start, now);
    expect(res.watts).toBe(6000);
    expect(res.profileId).toBe(tx.chargingProfileId);
  });

  it("returns the station max when it is tighter than tx", () => {
    const tx = profile({
      chargingProfileId: 1,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 10_000 }],
    });
    const cap = profile({
      chargingProfileId: 99,
      chargingProfilePurpose: ChargingProfilePurposeType.ChargePointMaxProfile,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 4_000 }],
    });
    const res = resolveEffectiveLimitWatts(tx, cap, start, now);
    expect(res.watts).toBe(4_000);
    expect(res.profileId).toBe(99);
  });

  it("uncapped when neither side provides a limit", () => {
    const res = resolveEffectiveLimitWatts(null, null, start, now);
    expect(res.watts).toBe(Infinity);
  });

  it("falls back to the station max alone when no tx profile", () => {
    const cap = profile({
      chargingProfileId: 99,
      chargingProfilePurpose: ChargingProfilePurposeType.ChargePointMaxProfile,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 4_000 }],
    });
    const res = resolveEffectiveLimitWatts(null, cap, start, now);
    expect(res.watts).toBe(4_000);
  });
});

describe("buildCompositeWattsSchedule", () => {
  const anchor = new Date("2026-01-01T00:00:00Z");

  it("emits an empty schedule when no profiles are supplied", () => {
    const result = buildCompositeWattsSchedule(
      { txProfile: null, chargePointMaxProfile: null },
      anchor,
      3600,
    );
    expect(result).toEqual([]);
  });

  it("emits a single period when only the tx profile is present", () => {
    const tx = profile({
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 5000 },
        { startPeriod: 1800, limit: 3000 },
      ],
    });
    const result = buildCompositeWattsSchedule(
      { txProfile: tx, chargePointMaxProfile: null },
      anchor,
      3600,
    );
    expect(result).toEqual([
      { startPeriod: 0, watts: 5000 },
      { startPeriod: 1800, watts: 3000 },
    ]);
  });

  it("takes the min across tx + ChargePointMaxProfile per slice", () => {
    const tx = profile({
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 10_000 },
        { startPeriod: 1800, limit: 2_000 },
      ],
    });
    const cap = profile({
      chargingProfilePurpose: ChargingProfilePurposeType.ChargePointMaxProfile,
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 6_000 },
        { startPeriod: 900, limit: 4_000 },
      ],
    });
    const result = buildCompositeWattsSchedule(
      { txProfile: tx, chargePointMaxProfile: cap },
      anchor,
      3600,
    );
    // Expected boundaries: 0, 900, 1800. At each:
    //   0    → min(10000, 6000) = 6000
    //   900  → min(10000, 4000) = 4000
    //   1800 → min( 2000, 4000) = 2000
    expect(result).toEqual([
      { startPeriod: 0, watts: 6000 },
      { startPeriod: 900, watts: 4000 },
      { startPeriod: 1800, watts: 2000 },
    ]);
  });

  it("collapses consecutive identical limits", () => {
    const tx = profile({
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 5000 },
        { startPeriod: 1800, limit: 5000 }, // same limit → should merge
      ],
    });
    const result = buildCompositeWattsSchedule(
      { txProfile: tx, chargePointMaxProfile: null },
      anchor,
      3600,
    );
    expect(result).toEqual([{ startPeriod: 0, watts: 5000 }]);
  });

  it("expands a Recurring Daily profile across the window", () => {
    // Daily profile anchored at midnight; window starts 12h in, runs 36h.
    const cap = profile({
      chargingProfilePurpose: ChargingProfilePurposeType.ChargePointMaxProfile,
      chargingProfileKind: ChargingProfileKindType.Recurring,
      recurrencyKind: RecurrencyKindType.Daily,
      validFrom: anchor.toISOString(),
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 5000 }, // 00:00–06:00 each day
        { startPeriod: 6 * 3600, limit: 10_000 }, // 06:00–24:00 each day
      ],
    });
    const windowStart = new Date(anchor.getTime() + 12 * 3600 * 1000);
    const result = buildCompositeWattsSchedule(
      { txProfile: null, chargePointMaxProfile: cap },
      windowStart,
      36 * 3600,
    );
    // We expect boundaries at the daily cycle restarts: 12h (anchor=0
    // already there), then 12h+12h=24h offset where the next day's
    // 00:00→06:00 slot starts again.
    const offsets = result.map((p) => p.startPeriod);
    expect(offsets).toContain(0); // anchor
    // Next-day 00:00 lands at offset 12h
    expect(offsets).toContain(12 * 3600);
    // Day-2 06:00 lands at offset 12h + 6h = 18h
    expect(offsets).toContain(18 * 3600);
  });
});
