import type { ActiveChargingProfile } from "../connector/Connector";
import { isScheduleInEffect } from "../connector/ChargingScheduleResolver";
import type { ChargingProfilePurposeType } from "../types/OcppTypes";

export interface ProfileRemoveCriteria {
  profileId?: number;
  purpose?: ChargingProfilePurposeType;
  stackLevel?: number;
}

export interface ApplyChargingProfileOptions {
  /**
   * Also replace the profile that has the same `stackLevel` and
   * `chargingProfilePurpose` (OCPP 1.6 SetChargingProfile, #594). Off for
   * 2.x, which keeps replacing by id only.
   */
  replaceSameSlot?: boolean;
}

/**
 * `profiles` with `profile` in place of any profile with the same id
 * (§5.16: SetChargingProfile.req with an existing chargingProfileId is an
 * update, not an insert), and whether one was replaced. Shared by the
 * station store and `Connector`.
 */
export function upsertProfile(
  profiles: readonly ActiveChargingProfile[],
  profile: ActiveChargingProfile,
  options: ApplyChargingProfileOptions = {},
): { profiles: ActiveChargingProfile[]; replaced: boolean } {
  const others = profiles.filter(
    (p) =>
      p.chargingProfileId !== profile.chargingProfileId &&
      !(
        options.replaceSameSlot &&
        p.stackLevel === profile.stackLevel &&
        p.chargingProfilePurpose === profile.chargingProfilePurpose
      ),
  );
  return {
    profiles: [...others, profile],
    replaced: others.length < profiles.length,
  };
}

/** Split `profiles` into those matching every given criterion and the rest. */
export function partitionProfiles(
  profiles: readonly ActiveChargingProfile[],
  criteria: ProfileRemoveCriteria,
): { kept: ActiveChargingProfile[]; removed: ActiveChargingProfile[] } {
  const kept: ActiveChargingProfile[] = [];
  const removed: ActiveChargingProfile[] = [];
  for (const profile of profiles) {
    const matches =
      (criteria.profileId == null ||
        profile.chargingProfileId === criteria.profileId) &&
      (criteria.purpose == null ||
        profile.chargingProfilePurpose === criteria.purpose) &&
      (criteria.stackLevel == null ||
        profile.stackLevel === criteria.stackLevel);
    (matches ? removed : kept).push(profile);
  }
  return { kept, removed };
}

/**
 * Holds charging profiles that apply at the charge-point (station) level
 * rather than to a specific connector. Per OCPP 1.6 §3.13.3 these are the
 * profiles a CSMS installs by sending `SetChargingProfile.req` with
 * `connectorId = 0`:
 *
 * - `ChargePointMaxProfile`: an overall cap on the station's total draw
 *   that combines (via `min`) with per-connector Tx layers.
 * - `TxDefaultProfile` (connectorId = 0): a station-wide default Tx layer
 *   used by any connector that doesn't have its own `TxDefaultProfile`.
 *
 * The store is intentionally minimal — same Map+filter shape used by
 * `Connector._chargingProfiles`. Keeping the storage symmetric makes the
 * composite-schedule code that has to walk both layers easier to read.
 */
export class ChargingProfileStore {
  private profiles: ActiveChargingProfile[] = [];

  /** @returns whether a profile with the same id was replaced. */
  add(
    profile: ActiveChargingProfile,
    options: ApplyChargingProfileOptions = {},
  ): boolean {
    const { profiles, replaced } = upsertProfile(
      this.profiles,
      profile,
      options,
    );
    this.profiles = profiles;
    return replaced;
  }

  /** Remove the profiles matching every given criterion and return them. */
  take(criteria: ProfileRemoveCriteria): ActiveChargingProfile[] {
    const { kept, removed } = partitionProfiles(this.profiles, criteria);
    this.profiles = kept;
    return removed;
  }

  all(): ActiveChargingProfile[] {
    return [...this.profiles];
  }

  /**
   * Highest-stackLevel, currently-valid profile matching the given
   * purpose. Returns `null` if none. Validity respects `validFrom` /
   * `validTo` if set; missing bounds count as "always valid" on that side.
   * A profile whose schedule `duration` has elapsed is skipped, so the next
   * lower stackLevel applies (1.6 errata 3.43).
   */
  getActive(
    purpose: ChargingProfilePurposeType,
    now: Date = new Date(),
    transactionStart: Date | null = null,
  ): ActiveChargingProfile | null {
    const candidates = this.profiles.filter((p) => {
      if (p.chargingProfilePurpose !== purpose) return false;
      if (p.validFrom && new Date(p.validFrom) > now) return false;
      if (p.validTo && new Date(p.validTo) <= now) return false;
      return isScheduleInEffect(p, transactionStart, now);
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((best, c) =>
      c.stackLevel > best.stackLevel ? c : best,
    );
  }
}
