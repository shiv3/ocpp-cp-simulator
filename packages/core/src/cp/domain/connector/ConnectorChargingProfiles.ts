import { ChargingProfilePurposeType } from "../types/OcppTypes";
import {
  partitionProfiles,
  upsertProfile,
  type ApplyChargingProfileOptions,
  type ChargingProfileStore,
  type ProfileRemoveCriteria,
} from "../charge-point/ChargingProfileStore";
import { isScheduleInEffect } from "./ChargingScheduleResolver";
import type { Transaction } from "./Transaction";
import type { ActiveChargingProfile } from "./Connector";

/** What the profile list needs from the connector that owns it. */
export interface ConnectorChargingProfilesHost {
  nowDate(): Date;
  stationProfiles(): ChargingProfileStore | null;
  transaction(): Transaction | null;
  emitChargingProfilesChange(event: {
    profiles: ActiveChargingProfile[];
  }): void;
  emitChargingProfileChange(event: {
    profile: ActiveChargingProfile | null;
  }): void;
}

/**
 * The connector's own charging profiles and the Tx-layer resolution of the
 * active one. Moved verbatim out of `Connector` (#877).
 */
export class ConnectorChargingProfiles {
  private _chargingProfiles: ActiveChargingProfile[] = [];

  constructor(private readonly host: ConnectorChargingProfilesHost) {}

  /**
   * Get all charging profiles for this connector, sorted by stack level (highest first)
   */
  get chargingProfiles(): ActiveChargingProfile[] {
    return [...this._chargingProfiles].sort(
      (a, b) => b.stackLevel - a.stackLevel,
    );
  }

  /**
   * Resolve the connector's currently active **Tx-layer** charging profile
   * per OCPP 1.6 §3.13.3 precedence rules:
   *
   *   1. The connector's own TxProfile (highest valid stackLevel) — if
   *      one exists it completely overrules anything else at the Tx layer.
   *   2. Otherwise, the highest valid TxDefaultProfile among:
   *        - this connector's own TxDefaultProfile(s), and
   *        - the station-wide TxDefaultProfile(s) (installed by the CSMS
   *          via SetChargingProfile.req with connectorId=0).
   *
   * The ChargePointMaxProfile lives separately on the ChargePoint and is
   * combined with this result via `min` inside the resolver.
   *
   * Returns `null` when no Tx-layer profile applies.
   */
  getActiveChargingProfile(
    now: Date = this.host.nowDate(),
  ): ActiveChargingProfile | null {
    const txStart = this.host.transaction()?.startTime ?? null;
    const isValid = (profile: ActiveChargingProfile) => {
      if (profile.validFrom && new Date(profile.validFrom) > now) return false;
      if (profile.validTo && new Date(profile.validTo) <= now) return false;
      // A schedule past its `duration` (or not yet at its `startSchedule`)
      // yields to the next lower stackLevel (1.6 errata 3.43).
      return isScheduleInEffect(profile, txStart, now);
    };

    // Tier 1: TxProfile on this connector wins outright (§3.13.3).
    const txProfiles = this._chargingProfiles.filter(
      (p) =>
        p.chargingProfilePurpose === ChargingProfilePurposeType.TxProfile &&
        isValid(p),
    );
    if (txProfiles.length > 0) {
      return txProfiles.reduce((best, c) =>
        c.stackLevel > best.stackLevel ? c : best,
      );
    }

    // Tier 2: TxDefaultProfile — connector-own and station-wide compete
    // by stackLevel. (If a CSMS wants connector defaults to always win
    // over station defaults, it sets them at a higher stackLevel.)
    const ownDefaults = this._chargingProfiles.filter(
      (p) =>
        p.chargingProfilePurpose ===
          ChargingProfilePurposeType.TxDefaultProfile && isValid(p),
    );
    const stationDefaults =
      this.host
        .stationProfiles()
        ?.all()
        .filter(
          (p) =>
            p.chargingProfilePurpose ===
              ChargingProfilePurposeType.TxDefaultProfile && isValid(p),
        ) ?? [];
    const defaults = [...ownDefaults, ...stationDefaults];
    if (defaults.length === 0) return null;
    return defaults.reduce((best, c) =>
      c.stackLevel > best.stackLevel ? c : best,
    );
  }

  /**
   * Backwards compatibility: get the active charging profile
   * @deprecated Use getActiveChargingProfile() instead
   */
  get chargingProfile(): ActiveChargingProfile | null {
    return this.getActiveChargingProfile();
  }

  /**
   * Backwards compatibility: set a single charging profile (replaces all profiles)
   * @deprecated Use addChargingProfile() or setChargingProfiles() instead
   */
  set chargingProfile(profile: ActiveChargingProfile | null) {
    if (profile === null) {
      this.clearAllChargingProfiles();
    } else {
      this._chargingProfiles = [profile];
      this.emitProfileChanges();
    }
  }

  /**
   * Add or update a charging profile. If a profile with the same ID exists, it is replaced.
   * @returns Whether a profile with the same ID was replaced
   */
  addChargingProfile(
    profile: ActiveChargingProfile,
    options: ApplyChargingProfileOptions = {},
  ): boolean {
    const { profiles, replaced } = upsertProfile(
      this._chargingProfiles,
      profile,
      options,
    );
    this._chargingProfiles = profiles;
    this.emitProfileChanges();
    return replaced;
  }

  /**
   * Remove the charging profiles matching every given criterion
   * @returns The removed profiles
   */
  takeChargingProfiles(
    criteria: ProfileRemoveCriteria,
  ): ActiveChargingProfile[] {
    const { kept, removed } = partitionProfiles(
      this._chargingProfiles,
      criteria,
    );
    this._chargingProfiles = kept;
    if (removed.length > 0) {
      this.emitProfileChanges();
    }
    return removed;
  }

  /**
   * Clear all charging profiles
   */
  clearAllChargingProfiles(): void {
    if (this._chargingProfiles.length > 0) {
      this._chargingProfiles = [];
      this.emitProfileChanges();
    }
  }

  /**
   * Set all charging profiles (replaces existing profiles)
   */
  setChargingProfiles(profiles: ActiveChargingProfile[]): void {
    this._chargingProfiles = [...profiles];
    this.emitProfileChanges();
  }

  /**
   * Emit events when charging profiles change
   */
  private emitProfileChanges(): void {
    this.host.emitChargingProfilesChange({
      profiles: this.chargingProfiles,
    });
    // Also emit backwards-compatible event
    this.host.emitChargingProfileChange({
      profile: this.getActiveChargingProfile(),
    });
  }
}
