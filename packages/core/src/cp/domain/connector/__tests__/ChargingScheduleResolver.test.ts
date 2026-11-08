import { describe, it, expect } from "vitest";
import { resolveScheduleLimitWatts } from "../ChargingScheduleResolver";
import type { ActiveChargingProfile } from "../Connector";
import {
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
  RecurrencyKindType,
} from "../../types/OcppTypes";

function makeProfile(
  overrides: Partial<ActiveChargingProfile> = {},
): ActiveChargingProfile {
  return {
    chargingProfileId: 1,
    connectorId: 1,
    stackLevel: 0,
    chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
    chargingProfileKind: ChargingProfileKindType.Relative,
    chargingRateUnit: ChargingRateUnitType.W,
    chargingSchedulePeriods: [{ startPeriod: 0, limit: 7000 }],
    ...overrides,
  };
}

describe("resolveScheduleLimitWatts", () => {
  it("returns Infinity when no profile is supplied", () => {
    const res = resolveScheduleLimitWatts(null, new Date());
    expect(res.watts).toBe(Infinity);
  });

  it("returns Infinity when no transaction start is supplied", () => {
    const res = resolveScheduleLimitWatts(makeProfile(), null);
    expect(res.watts).toBe(Infinity);
  });

  it("returns the single-period limit for a Relative W profile", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-01T00:00:30Z");
    const res = resolveScheduleLimitWatts(makeProfile(), start, now);
    expect(res.watts).toBe(7000);
    expect(res.periodIndex).toBe(0);
  });

  it("picks the latest period whose startPeriod ≤ elapsed", () => {
    const profile = makeProfile({
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 11000 },
        { startPeriod: 60, limit: 7000 },
        { startPeriod: 120, limit: 3000 },
      ],
    });
    const start = new Date("2026-01-01T00:00:00Z");
    expect(
      resolveScheduleLimitWatts(
        profile,
        start,
        new Date("2026-01-01T00:00:30Z"),
      ).watts,
    ).toBe(11000);
    expect(
      resolveScheduleLimitWatts(
        profile,
        start,
        new Date("2026-01-01T00:01:30Z"),
      ).watts,
    ).toBe(7000);
    expect(
      resolveScheduleLimitWatts(
        profile,
        start,
        new Date("2026-01-01T00:05:00Z"),
      ).watts,
    ).toBe(3000);
  });

  it("converts ampere limits to watts using numberPhases × 230 V", () => {
    const profile = makeProfile({
      chargingRateUnit: ChargingRateUnitType.A,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 16, numberPhases: 1 }],
    });
    const start = new Date("2026-01-01T00:00:00Z");
    expect(resolveScheduleLimitWatts(profile, start).watts).toBe(16 * 230 * 1);
  });

  it("defaults numberPhases to 3 when absent on an ampere profile", () => {
    const profile = makeProfile({
      chargingRateUnit: ChargingRateUnitType.A,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 32 }],
    });
    const start = new Date("2026-01-01T00:00:00Z");
    expect(resolveScheduleLimitWatts(profile, start).watts).toBe(32 * 230 * 3);
  });

  it("clamps a negative resolved value to zero", () => {
    const profile = makeProfile({
      chargingSchedulePeriods: [{ startPeriod: 0, limit: -500 }],
    });
    const start = new Date("2026-01-01T00:00:00Z");
    expect(resolveScheduleLimitWatts(profile, start).watts).toBe(0);
  });

  it("returns Infinity when elapsed is before the first period", () => {
    const profile = makeProfile({
      chargingSchedulePeriods: [{ startPeriod: 60, limit: 7000 }],
    });
    const start = new Date("2026-01-01T00:00:00Z");
    const res = resolveScheduleLimitWatts(
      profile,
      start,
      new Date("2026-01-01T00:00:10Z"),
    );
    expect(res.watts).toBe(Infinity);
  });

  it("anchors Absolute schedules on validFrom", () => {
    const profile = makeProfile({
      chargingProfileKind: ChargingProfileKindType.Absolute,
      validFrom: "2026-01-01T00:00:00Z",
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 11000 },
        { startPeriod: 3600, limit: 5000 },
      ],
    });
    const txStart = new Date("2026-01-01T02:00:00Z");
    // 90 min after validFrom → period 1 (3600s+) is active, regardless of txStart.
    const res = resolveScheduleLimitWatts(
      profile,
      txStart,
      new Date("2026-01-01T01:30:00Z"),
    );
    expect(res.watts).toBe(5000);
  });

  it("wraps Daily Recurring schedules every 24 h", () => {
    const profile = makeProfile({
      chargingProfileKind: ChargingProfileKindType.Recurring,
      recurrencyKind: RecurrencyKindType.Daily,
      validFrom: "2026-01-01T00:00:00Z",
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 3000 },
        { startPeriod: 6 * 3600, limit: 11000 },
        { startPeriod: 22 * 3600, limit: 0 },
      ],
    });
    const start = new Date("2026-01-10T00:00:00Z");
    // 8 days + 7h after validFrom → cycle position = 7h → period @ 6h applies.
    const res = resolveScheduleLimitWatts(
      profile,
      start,
      new Date("2026-01-09T07:00:00Z"),
    );
    expect(res.watts).toBe(11000);
  });

  it("exposes paused state via limit=0 periods", () => {
    const profile = makeProfile({
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 11000 },
        { startPeriod: 30, limit: 0 },
      ],
    });
    const start = new Date("2026-01-01T00:00:00Z");
    expect(
      resolveScheduleLimitWatts(
        profile,
        start,
        new Date("2026-01-01T00:00:10Z"),
      ).watts,
    ).toBe(11000);
    expect(
      resolveScheduleLimitWatts(
        profile,
        start,
        new Date("2026-01-01T00:01:00Z"),
      ).watts,
    ).toBe(0);
  });
});

describe("startSchedule and duration (1.6 §7.13, errata 3.43, 3.44)", () => {
  const txStart = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-01-01T01:00:00Z");

  it("counts an Absolute profile from startSchedule, not from the transaction start", () => {
    const profile = makeProfile({
      chargingProfileKind: ChargingProfileKindType.Absolute,
      startSchedule: "2026-01-01T00:30:00Z",
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 11000 },
        { startPeriod: 3600, limit: 3000 },
      ],
    });
    // 30 min after startSchedule (1 h after the transaction start).
    expect(resolveScheduleLimitWatts(profile, txStart, now).watts).toBe(11000);
    // 1 h 30 min after startSchedule.
    expect(
      resolveScheduleLimitWatts(
        profile,
        txStart,
        new Date("2026-01-01T02:00:00Z"),
      ).watts,
    ).toBe(3000);
  });

  it("is not in effect before startSchedule", () => {
    const profile = makeProfile({
      chargingProfileKind: ChargingProfileKindType.Absolute,
      startSchedule: "2026-01-01T02:00:00Z",
    });
    expect(resolveScheduleLimitWatts(profile, txStart, now).watts).toBe(
      Infinity,
    );
  });

  it("ends an Absolute profile at its duration", () => {
    const profile = makeProfile({
      chargingProfileKind: ChargingProfileKindType.Absolute,
      startSchedule: "2026-01-01T00:00:00Z",
      duration: 600,
    });
    const at = (s: number) => new Date(txStart.getTime() + s * 1000);
    expect(resolveScheduleLimitWatts(profile, txStart, at(599)).watts).toBe(
      7000,
    );
    expect(resolveScheduleLimitWatts(profile, txStart, at(600)).watts).toBe(
      Infinity,
    );
  });

  it("ends a Relative profile at its duration", () => {
    const profile = makeProfile({ duration: 600 });
    expect(
      resolveScheduleLimitWatts(
        profile,
        txStart,
        new Date(txStart.getTime() + 601_000),
      ).watts,
    ).toBe(Infinity);
  });

  it("cycles a Daily profile from startSchedule and ignores periods past 24 h", () => {
    const profile = makeProfile({
      chargingProfileKind: ChargingProfileKindType.Recurring,
      recurrencyKind: RecurrencyKindType.Daily,
      startSchedule: "2026-01-01T00:00:00Z",
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 2000 },
        { startPeriod: 3600 * 2, limit: 5000 },
        { startPeriod: 86_400 + 3600, limit: 9000 },
      ],
    });
    const at = (iso: string) =>
      resolveScheduleLimitWatts(profile, txStart, new Date(iso)).watts;
    expect(at("2026-01-02T01:00:00Z")).toBe(2000); // cycle 2, 1 h in
    expect(at("2026-01-02T03:00:00Z")).toBe(5000); // cycle 2, 3 h in
    expect(at("2026-01-01T23:59:59Z")).toBe(5000); // never the 9000 period
  });

  it("restarts a Recurring duration every cycle", () => {
    const profile = makeProfile({
      chargingProfileKind: ChargingProfileKindType.Recurring,
      recurrencyKind: RecurrencyKindType.Daily,
      startSchedule: "2026-01-01T00:00:00Z",
      duration: 3600,
    });
    const at = (iso: string) =>
      resolveScheduleLimitWatts(profile, txStart, new Date(iso)).watts;
    expect(at("2026-01-02T00:30:00Z")).toBe(7000);
    expect(at("2026-01-02T02:00:00Z")).toBe(Infinity);
  });
});
