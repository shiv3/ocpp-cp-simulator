import type { ActiveChargingProfile } from "./Connector";
import {
  ChargingProfileKindType,
  ChargingRateUnitType,
  RecurrencyKindType,
} from "../types/OcppTypes";

/**
 * Reference voltage used to convert ChargingRateUnit=A to watts. OCPP 1.6 §7.5
 * does not pin down a value (real CPs report the AC line voltage). 230 V
 * matches IEC single-phase; for 3-phase systems we multiply by numberPhases.
 */
const REFERENCE_PHASE_VOLTAGE = 230;

/**
 * Result of resolving the currently effective limit for a connector.
 *
 * `watts` is the effective max power draw in W. `Infinity` means "no profile
 * active — uncapped" (auto-meter runs at its configured rate). `0` means
 * paused (SuspendedEVSE).
 */
export interface ResolvedScheduleLimit {
  watts: number;
  /** Source profile id, useful for logging / debugging. */
  profileId: number | null;
  /** Which schedule period (index) within the source profile is active. */
  periodIndex: number | null;
  /** Raw period limit value (in the profile's native unit). */
  rawLimit: number | null;
  /** Unit the profile declared (`W` or `A`). */
  unit: ChargingRateUnitType | null;
}

const UNCAPPED: ResolvedScheduleLimit = {
  watts: Infinity,
  profileId: null,
  periodIndex: null,
  rawLimit: null,
  unit: null,
};

/**
 * Compute "seconds since the profile's reference point" given a profile and
 * the current transaction context. The reference depends on
 * `chargingProfileKind`:
 *
 * - `Absolute`: elapsed from `validFrom` / `startSchedule`. If neither is set
 *   we fall back to "seconds since transaction start" so the profile is
 *   still useful in a fresh session.
 * - `Recurring` (Daily/Weekly): wraps around the cycle starting at
 *   `validFrom` / `startSchedule`.
 * - `Relative`: elapsed from transaction start.
 */
function elapsedSecondsForProfile(
  profile: ActiveChargingProfile,
  transactionStart: Date,
  now: Date,
): number {
  const nowMs = now.getTime();
  const txMs = transactionStart.getTime();

  switch (profile.chargingProfileKind) {
    case ChargingProfileKindType.Relative:
      return Math.max(0, (nowMs - txMs) / 1000);

    case ChargingProfileKindType.Absolute: {
      const refIso = profile.validFrom;
      if (!refIso) return Math.max(0, (nowMs - txMs) / 1000);
      const refMs = new Date(refIso).getTime();
      if (Number.isNaN(refMs)) return Math.max(0, (nowMs - txMs) / 1000);
      return Math.max(0, (nowMs - refMs) / 1000);
    }

    case ChargingProfileKindType.Recurring: {
      const refIso = profile.validFrom;
      const refMs = refIso ? new Date(refIso).getTime() : txMs;
      const elapsed = Math.max(0, (nowMs - refMs) / 1000);
      const cycleSec =
        profile.recurrencyKind === RecurrencyKindType.Weekly
          ? 7 * 24 * 3600
          : 24 * 3600;
      return elapsed % cycleSec;
    }

    default:
      return Math.max(0, (nowMs - txMs) / 1000);
  }
}

/**
 * Pick the schedule period whose `startPeriod` is the latest one ≤ elapsed.
 * Periods are assumed sorted ascending; we sort defensively to handle CSMSs
 * that send them out of order.
 */
function selectPeriodIndex(
  profile: ActiveChargingProfile,
  elapsedSec: number,
): number | null {
  const periods = profile.chargingSchedulePeriods;
  if (periods.length === 0) return null;

  const sorted = periods
    .map((p, idx) => ({ idx, startPeriod: p.startPeriod }))
    .sort((a, b) => a.startPeriod - b.startPeriod);

  let selected: number | null = null;
  for (const entry of sorted) {
    if (entry.startPeriod <= elapsedSec) selected = entry.idx;
    else break;
  }
  // If elapsed is before the first period we treat the schedule as not yet in
  // effect (caller falls back to unlimited).
  return selected;
}

function limitToWatts(
  rawLimit: number,
  unit: ChargingRateUnitType,
  numberPhases: number | undefined,
): number {
  if (unit === ChargingRateUnitType.W) return rawLimit;
  // A → W: amperes × volts × phases. OCPP §7.21: numberPhases defaults to 3
  // when absent. Single-phase profiles must set numberPhases=1 explicitly.
  const phases = numberPhases ?? 3;
  return rawLimit * REFERENCE_PHASE_VOLTAGE * phases;
}

/**
 * Resolve the effective wattage cap for a connector at this instant. Returns
 * `Infinity` when there's no active profile (i.e. the auto-meter is free to
 * use its scenario-configured rate).
 */
export function resolveScheduleLimitWatts(
  profile: ActiveChargingProfile | null,
  transactionStart: Date | null,
  now: Date = new Date(),
): ResolvedScheduleLimit {
  if (!profile || !transactionStart) return UNCAPPED;

  const elapsed = elapsedSecondsForProfile(profile, transactionStart, now);
  const idx = selectPeriodIndex(profile, elapsed);
  if (idx == null) return UNCAPPED;

  const period = profile.chargingSchedulePeriods[idx];
  const watts = limitToWatts(
    period.limit,
    profile.chargingRateUnit,
    period.numberPhases,
  );

  return {
    watts: Math.max(0, watts),
    profileId: profile.chargingProfileId,
    periodIndex: idx,
    rawLimit: period.limit,
    unit: profile.chargingRateUnit,
  };
}
