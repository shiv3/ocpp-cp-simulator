import type { ActiveChargingProfile } from "../connector/Connector";
import type { ChargingProfilePurposeType } from "../types/OcppTypes";

export interface ProfileRemoveCriteria {
  profileId?: number;
  purpose?: ChargingProfilePurposeType;
  stackLevel?: number;
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

  add(profile: ActiveChargingProfile): void {
    // Same-id replacement matches Connector.addChargingProfile semantics
    // (§5.16: SetChargingProfile.req with an existing chargingProfileId
    // is an update, not an insert).
    this.profiles = this.profiles.filter(
      (p) => p.chargingProfileId !== profile.chargingProfileId,
    );
    this.profiles.push(profile);
  }

  remove(criteria: ProfileRemoveCriteria): number {
    const before = this.profiles.length;
    this.profiles = this.profiles.filter((profile) => {
      if (
        criteria.profileId != null &&
        profile.chargingProfileId !== criteria.profileId
      ) {
        return true;
      }
      if (
        criteria.purpose != null &&
        profile.chargingProfilePurpose !== criteria.purpose
      ) {
        return true;
      }
      if (
        criteria.stackLevel != null &&
        profile.stackLevel !== criteria.stackLevel
      ) {
        return true;
      }
      return false;
    });
    return before - this.profiles.length;
  }

  clear(): void {
    this.profiles = [];
  }

  all(): ActiveChargingProfile[] {
    return [...this.profiles];
  }

  /**
   * Highest-stackLevel, currently-valid profile matching the given
   * purpose. Returns `null` if none. Validity respects `validFrom` /
   * `validTo` if set; missing bounds count as "always valid" on that side.
   */
  getActive(
    purpose: ChargingProfilePurposeType,
    now: Date = new Date(),
  ): ActiveChargingProfile | null {
    const candidates = this.profiles.filter((p) => {
      if (p.chargingProfilePurpose !== purpose) return false;
      if (p.validFrom && new Date(p.validFrom) > now) return false;
      if (p.validTo && new Date(p.validTo) < now) return false;
      return true;
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((best, c) =>
      c.stackLevel > best.stackLevel ? c : best,
    );
  }
}
