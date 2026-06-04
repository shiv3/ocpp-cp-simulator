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

/**
 * §3.13.3 combined limit for a connector:
 *
 *   effective = min(connector's Tx-layer profile, ChargePointMaxProfile)
 *
 * Either side may be `null`; an absent profile contributes `Infinity` and
 * is therefore ignored by `min`. When both sides are absent the result is
 * `UNCAPPED`.
 *
 * The returned `profileId` / `periodIndex` come from whichever side is
 * tighter (so logs show which profile actually constrained the draw).
 */
export function resolveEffectiveLimitWatts(
  txProfile: ActiveChargingProfile | null,
  chargePointMaxProfile: ActiveChargingProfile | null,
  transactionStart: Date | null,
  now: Date = new Date(),
): ResolvedScheduleLimit {
  const tx = resolveScheduleLimitWatts(txProfile, transactionStart, now);
  const cap = resolveScheduleLimitWatts(
    chargePointMaxProfile,
    transactionStart,
    now,
  );
  if (tx.watts === Infinity && cap.watts === Infinity) return UNCAPPED;
  // The tighter side wins. Equal watts → prefer the tx side (more
  // specific) for the metadata.
  if (cap.watts < tx.watts) return cap;
  return tx;
}

// ─── Composite schedule (GetCompositeSchedule.req) ───────────────────────

export interface CompositePeriod {
  startPeriod: number;
  /** Watts. `Infinity` means "uncapped" — the caller should skip emitting
   *  a ChargingSchedulePeriod for this slice, since OCPP has no encoding
   *  for "no limit". */
  watts: number;
}

export interface CompositeInput {
  /**
   * Tx-layer profile to apply across the duration. For a connector-scoped
   * composite this is `connector.getActiveChargingProfile()`. For
   * connectorId=0 composites the caller passes the SUM-of-connectors
   * pseudo-profile — currently we approximate that by passing the highest
   * connector Tx (simulator does not model multiple parallel sessions for
   * total-power purposes).
   */
  txProfile: ActiveChargingProfile | null;
  /** The station-wide ChargePointMaxProfile, if any. */
  chargePointMaxProfile: ActiveChargingProfile | null;
}

/**
 * Build a composite schedule over `[anchor, anchor + duration)`.
 *
 * Algorithm:
 *   1. Project each input profile onto absolute-time period boundaries
 *      inside the window. For Recurring profiles we expand cycles within
 *      `duration` (so a Daily profile contributes its 24-hour period set
 *      at every 24-hour offset that lands in the window).
 *   2. Walk the merged sorted boundary set. At each boundary compute the
 *      effective `min` across the inputs that are "live" at that instant.
 *   3. Collapse consecutive identical limits to keep the period count
 *      small (CSMSs commonly cap this around `ChargingScheduleMaxPeriods`).
 *
 * Output watts are clamped to `0..Infinity`. The CompositePeriod with
 * `watts === Infinity` is emitted; the SmartCharging handler decides
 * whether to skip those when serializing to ChargingSchedulePeriod[] (the
 * OCPP type has no "uncapped" encoding).
 */
export function buildCompositeWattsSchedule(
  inputs: CompositeInput,
  anchor: Date,
  durationSeconds: number,
): CompositePeriod[] {
  const profiles: ActiveChargingProfile[] = [];
  if (inputs.txProfile) profiles.push(inputs.txProfile);
  if (inputs.chargePointMaxProfile) profiles.push(inputs.chargePointMaxProfile);
  if (profiles.length === 0) return [];

  // Collect boundary offsets (seconds since anchor) where the effective
  // limit could change. We seed with 0 to ensure at least one slice; the
  // window-end at `duration` bounds the last slice but is not emitted.
  const boundaries = new Set<number>([0]);
  for (const profile of profiles) {
    addProfileBoundaries(profile, anchor, durationSeconds, boundaries);
  }
  const sorted = Array.from(boundaries)
    .filter((s) => s >= 0 && s < durationSeconds)
    .sort((a, b) => a - b);

  // Compute effective limit at each boundary.
  const slices: CompositePeriod[] = [];
  for (const startPeriod of sorted) {
    const at = new Date(anchor.getTime() + startPeriod * 1000);
    let limit = Infinity;
    for (const profile of profiles) {
      // For Recurring/Absolute kinds the resolver walks elapsed time from
      // the profile's reference; for Relative it's elapsed from the
      // anchor (we treat the composite anchor as the transaction start).
      const r = resolveScheduleLimitWatts(profile, anchor, at);
      if (r.watts < limit) limit = r.watts;
    }
    if (slices.length === 0 || slices[slices.length - 1].watts !== limit) {
      slices.push({ startPeriod, watts: limit });
    }
  }
  return slices;
}

/**
 * Push boundary offsets (relative to `anchor`, in seconds) where the given
 * profile's period selection could change inside `[0, duration)`.
 *
 * - `Absolute` / `Relative`: each `startPeriod` (validated against the
 *   profile's reference instant) translates to an offset from `anchor`.
 * - `Recurring`: we expand the period set across every cycle that
 *   intersects the window.
 *
 * Defensive: profiles with no periods, periods past `duration`, or with
 * insane start offsets are silently dropped here — the resolver still
 * treats them as uncapped on lookup.
 */
function addProfileBoundaries(
  profile: ActiveChargingProfile,
  anchor: Date,
  durationSeconds: number,
  out: Set<number>,
): void {
  const periods = profile.chargingSchedulePeriods;
  if (periods.length === 0) return;
  const sorted = [...periods].sort((a, b) => a.startPeriod - b.startPeriod);

  // Profile reference instant in ms — see elapsedSecondsForProfile.
  const refMs = profileReferenceMs(profile, anchor);
  const anchorMs = anchor.getTime();

  if (profile.chargingProfileKind === ChargingProfileKindType.Recurring) {
    const cycleSec =
      profile.recurrencyKind === RecurrencyKindType.Weekly
        ? 7 * 24 * 3600
        : 24 * 3600;
    // First cycle that touches [anchorMs, anchorMs + durationSeconds).
    let cycleStartMs = refMs;
    if (cycleStartMs > anchorMs) {
      // Profile's first cycle hasn't started yet; nothing to emit until
      // it does.
      cycleStartMs = anchorMs; // walked forward below
    } else {
      const cyclesElapsed = Math.floor(
        (anchorMs - cycleStartMs) / 1000 / cycleSec,
      );
      cycleStartMs = refMs + cyclesElapsed * cycleSec * 1000;
    }
    while (cycleStartMs < anchorMs + durationSeconds * 1000) {
      for (const p of sorted) {
        const offset = (cycleStartMs - anchorMs) / 1000 + p.startPeriod;
        if (offset >= 0 && offset < durationSeconds) out.add(offset);
      }
      cycleStartMs += cycleSec * 1000;
    }
    return;
  }

  // Absolute / Relative: each startPeriod is an offset from `refMs`.
  for (const p of sorted) {
    const offset = (refMs - anchorMs) / 1000 + p.startPeriod;
    if (offset >= 0 && offset < durationSeconds) out.add(offset);
  }
}

function profileReferenceMs(
  profile: ActiveChargingProfile,
  anchor: Date,
): number {
  switch (profile.chargingProfileKind) {
    case ChargingProfileKindType.Relative:
      return anchor.getTime();
    case ChargingProfileKindType.Absolute:
    case ChargingProfileKindType.Recurring: {
      if (profile.validFrom) {
        const ms = new Date(profile.validFrom).getTime();
        if (!Number.isNaN(ms)) return ms;
      }
      return anchor.getTime();
    }
    default:
      return anchor.getTime();
  }
}
