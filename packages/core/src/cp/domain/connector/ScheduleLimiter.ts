import { OCPPStatus, ChargingProfilePurposeType } from "../types/OcppTypes";
import type { ChargingProfileStore } from "../charge-point/ChargingProfileStore";
import {
  resolveEffectiveLimitWatts,
  resolveEffectivePhaseLimit,
} from "./ChargingScheduleResolver";
import { electricalModelOf, resolveActivePhases } from "./ChargingCurve";
import type { EVSettings } from "./EVSettings";
import type { Transaction } from "./Transaction";
import type { ActiveChargingProfile } from "./Connector";

/** What the schedule limiter needs from the connector that owns it. */
export interface ScheduleLimiterHost {
  nowDate(): Date;
  getActiveChargingProfile(now?: Date): ActiveChargingProfile | null;
  stationProfiles(): ChargingProfileStore | null;
  evSettings(): EVSettings;
  transaction(): Transaction | null;
  status(): OCPPStatus;
  emitScheduleLimitChange(event: { paused: boolean; watts: number }): void;
}

/**
 * Schedule-derived constraints of one connector (watt cap, active phases) and
 * the edge-triggered `scheduleLimitChange` announcement. Moved verbatim out of
 * `Connector` (#877).
 */
export class ScheduleLimiter {
  constructor(private readonly host: ScheduleLimiterHost) {}

  /**
   * Resolve the effective wattage cap from the active charging profile (if
   * any) at the current instant, anchored to the in-flight transaction's
   * start time. Returns `Infinity` when uncapped — i.e. no profile, or no
   * transaction context to anchor a Relative schedule on.
   *
   * A profile expressed in amperes is converted through this connector's
   * declared electrical model, so an amp limit survives the trip through
   * watts and back into the reported `Current.Import` (#301).
   *
   * Side-effect: if the paused/active state flipped since the last call,
   * emits `scheduleLimitChange` so the ChargePoint can move the connector
   * between Charging and SuspendedEVSE.
   *
   * That emission is **edge-triggered and idempotent**, which is what makes it
   * safe to call this more than once for the same instant — `MeterValueBuilder`
   * does, once for accepted power and once for offered power. `lastSchedulePaused`
   * is written before the emit, so a second call at the same boundary state
   * finds it equal and emits nothing; an uncapped second call finds it already
   * reset to `null` and does nothing either. A subscriber counting transitions
   * therefore sees one per real crossing, not one per sample. Contrast
   * {@link activePhaseCount} below, which is side-effect-free outright because
   * it has no boundary state to latch — the two are safe for the same reason
   * stated two different ways (#301).
   *
   * Idempotent against *repetition* is not the same as safe in every state,
   * and the difference cost a real defect: a crossing seen while the connector
   * is `Preparing` cannot move it anywhere, so latching it there consumed the
   * only edge that would ever be announced. The announcement is therefore
   * skipped entirely outside `Charging` / `SuspendedEVSE`, latch included. Mid-tick crossings of a period
   * boundary inside a Recurring or Absolute profile are picked up this way
   * without needing an extra timer.
   */
  currentScheduleLimitWatts(): number {
    const { watts } = this.resolveScheduleConstraints(this.host.nowDate());
    this.announceScheduleCrossing(watts);
    return watts;
  }

  /**
   * The watt cap and the active phase count, resolved from **one** instant.
   *
   * One instant covers every clock-dependent question the resolve asks:
   * which Tx-layer profile applies (`validFrom` / `validTo`), which station
   * `ChargePointMaxProfile` applies, which schedule period of each is active,
   * and the phase restriction in force.
   *
   * Both constraints are read for every MeterValue, and each used to resolve
   * against its own `new Date()`. A charging-schedule period boundary falling
   * between the two calls took the cap from one period and the divisor from
   * the next: a 10 A three-phase period yields 6900 W, divided as one phase
   * and reported as 30 A — a sample set describing two instants at once,
   * which is the property the single schedule resolve was introduced to hold.
   * A profile-validity boundary falling between the two active-profile
   * lookups was the same defect one layer up, and is closed the same way
   * (#301).
   *
   * Emits `scheduleLimitChange` on a crossing exactly as
   * {@link currentScheduleLimitWatts} does, and is the call a sampling path
   * should make instead of those two.
   */
  scheduleConstraints(): { watts: number; activePhases: number } {
    const constraints = this.resolveScheduleConstraints(this.host.nowDate());
    this.announceScheduleCrossing(constraints.watts);
    return constraints;
  }

  /**
   * Resolve both schedule-derived constraints at `now`. Pure: the crossing
   * announcement is {@link announceScheduleCrossing}'s job, so a caller that
   * only wants a number — `activePhaseCount` — can share this without
   * acquiring a side effect.
   */
  resolveScheduleConstraints(now: Date): {
    watts: number;
    activePhases: number;
  } {
    // `now` reaches the *selection* of both profiles, not only the period and
    // phase resolvers below. Both lookups defaulted to a clock reading of
    // their own, so a `validFrom` / `validTo` boundary falling between them
    // and the pinned instant selected a profile belonging to a different
    // moment than the periods were then resolved against — applied a moment
    // early, or omitted a moment late (#301). Every applicable-profile
    // question in this method is now asked about one instant.
    const txProfile = this.host.getActiveChargingProfile(now);
    const stationMax =
      this.host
        .stationProfiles()
        ?.getActive(ChargingProfilePurposeType.ChargePointMaxProfile, now) ??
      null;
    const start = this.host.transaction()?.startTime ?? null;
    const resolved = resolveEffectiveLimitWatts(
      txProfile,
      stationMax,
      start,
      now,
      // A `ChargingRateUnit=A` limit is converted with this connector's own
      // volts/phases/cos φ when it declares them, so that the current
      // `MeterValueBuilder` derives back from the resulting cap never exceeds
      // the amperage the CSMS set (#301). `undefined` for a connector that
      // declares no electrical model — that is the pre-#301 conversion and it
      // stays exactly where it was.
      electricalModelOf(this.host.evSettings()),
    );
    const limitPhases = resolveEffectivePhaseLimit(
      txProfile,
      stationMax,
      start,
      now,
    );
    return {
      watts: resolved.watts,
      activePhases: resolveActivePhases(
        this.host.evSettings(),
        limitPhases ?? undefined,
      ),
    };
  }

  /** Emit `scheduleLimitChange` when the paused/active boundary has moved
   *  since the last resolve. Edge-triggered: see
   *  {@link currentScheduleLimitWatts}'s note on why repeated calls at one
   *  boundary state emit once. */
  announceScheduleCrossing(watts: number): void {
    // No profile in force: disarm, whatever the connector's status. This is
    // bookkeeping, not an announcement — it emits nothing — so it deliberately
    // runs before the status guard below. The case it carries is a withdrawal
    // seen *inside* a live session, in a status the listener ignores: the car
    // pauses (`SuspendedEV`), the CSMS withdraws the zero-limit profile while
    // it is stopped, the car resumes, and a fresh zero-limit profile arrives.
    // Skipping the disarm there left the latch at `true` for a crossing that
    // had genuinely been undone, and the new pause went unannounced — the
    // meter capped at zero while the connector reported Charging (#301).
    // Across a *transaction* boundary the latch is re-armed by
    // {@link beginTransaction} instead, which is where its lifetime ends;
    // this disarm cannot cover that case, because a profile that survives the
    // session is never cleared and nothing samples in the gap.
    if (watts === Infinity) {
      this.lastSchedulePaused = null;
      return;
    }

    // The status guard gates **the announcement only**, not the disarm above.
    // The ChargePoint listener toggles Charging ↔ SuspendedEVSE and does
    // nothing otherwise, so latching a crossing seen while `Preparing` — a
    // scenario's first MeterValue lands there, before StartTransaction is
    // accepted — consumed the one edge that would ever be reported: every
    // later resolve found the latch already set and stayed silent. The latch
    // is idempotent against repetition (see {@link currentScheduleLimitWatts}),
    // which is a different thing from being safe against a crossing nobody
    // could act on. Leaving the latch untouched here means the first resolve
    // that *can* act announces it (#301).
    if (
      this.host.status() !== OCPPStatus.Charging &&
      this.host.status() !== OCPPStatus.SuspendedEVSE
    ) {
      return;
    }

    const paused = watts === 0;
    if (
      this.lastSchedulePaused === null ||
      paused !== this.lastSchedulePaused
    ) {
      this.lastSchedulePaused = paused;
      this.host.emitScheduleLimitChange({ paused, watts });
    }
  }

  /**
   * How many phases this connector is delivering on right now: its own wiring
   * (1 for DC), narrowed by the tightest `numberPhases` any applicable
   * charging profile imposes.
   *
   * The restriction is composed across the Tx-layer profile and the
   * `ChargePointMaxProfile` **independently** of the watt cap, because they
   * are independent constraints: the profile that supplies the lower wattage
   * need not be the one that restricts the phases, and a restriction still in
   * force must not be dropped merely because the other profile won on watts
   * (#301). The per-phase MeterValues samples read this, so they cannot claim
   * consumption on a phase the CSMS excluded.
   *
   * Unlike {@link currentScheduleLimitWatts} this has no side effects — it
   * never emits `scheduleLimitChange` — because it is called while building a
   * sample set, not while driving the meter.
   */
  activePhaseCount(): number {
    return this.resolveScheduleConstraints(this.host.nowDate()).activePhases;
  }

  /**
   * Snapshot of the last resolved "paused" state, used to detect crossings of
   * the limit=0 boundary across schedule periods. `null` means nothing has
   * been announced yet.
   *
   * **Its lifetime is one transaction.** It records what this session last
   * told the ChargePoint, and the `scheduleLimitChange` listener returns
   * without a transaction attached, so "already announced" is only a
   * meaningful claim within one. It is re-armed to `null` by
   * {@link beginTransaction}, and disarmed mid-session by
   * {@link announceScheduleCrossing} whenever no profile is in force (#301).
   */
  private lastSchedulePaused: boolean | null = null;

  /** Re-arm the latch: called when a transaction is attached. */
  rearm(): void {
    this.lastSchedulePaused = null;
  }
}
