import type { EventEmitter } from "../../shared/EventEmitter";
import type { ActiveChargingProfile, Connector } from "../connector/Connector";
import { ChargingProfilePurposeType } from "../types/OcppTypes";
import type { ChargePoint } from "./ChargePoint";
import type {
  ChargePointEvents,
  ChargingProfileClearReason,
  ChargingProfileSource,
  ClearedChargingProfiles,
} from "./ChargePointEvents";
import type {
  ApplyChargingProfileOptions,
  ChargingProfileStore,
  ProfileRemoveCriteria,
} from "./ChargingProfileStore";

/** What the charging profile control needs from its charge point. */
export interface ChargingProfileControlHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<ChargePoint, "getConnector">;
  readonly connectors: () => Map<number, Connector>;
  readonly events: () => EventEmitter<ChargePointEvents>;
  readonly nowDate: () => Date;
  readonly stationProfiles: () => ChargingProfileStore;
}

/**
 * Install and remove charging profiles on the station store and on the
 * connectors, and report each change (#469). The charge point keeps the
 * public methods as thin delegates.
 */
export class ChargingProfileControl {
  constructor(private readonly host: ChargingProfileControlHost) {}

  /**
   * Install a profile on the station store (`connectorId` 0) or on its
   * connector, replacing any profile with the same id in that scope (and,
   * with `options.replaceSameSlot`, the one with the same stackLevel and
   * purpose), and
   * emit `chargingProfileApplied`. Validation is the caller's job.
   *
   * @returns `false`, changing nothing, when the connector does not exist.
   */
  applyChargingProfile(
    profile: ActiveChargingProfile,
    source: ChargingProfileSource,
    options: ApplyChargingProfileOptions = {},
  ): boolean {
    const stationProfiles = this.host.stationProfiles();
    const idsBefore = (list: readonly ActiveChargingProfile[]) =>
      list.map((p) => p.chargingProfileId);
    let before: number[];
    let after: number[];
    if (profile.connectorId === 0) {
      before = idsBefore(stationProfiles.all());
      stationProfiles.add(profile, options);
      after = idsBefore(stationProfiles.all());
    } else {
      const connector = this.host.chargePoint.getConnector(profile.connectorId);
      if (!connector) return false;
      before = idsBefore(connector.chargingProfiles);
      connector.addChargingProfile(profile, options);
      after = idsBefore(connector.chargingProfiles);
    }
    const replaced = before.includes(profile.chargingProfileId);
    // Other profiles the same-slot rule displaced (#594).
    const replacedIds = before.filter(
      (id) => id !== profile.chargingProfileId && !after.includes(id),
    );
    this.host.events().emit("chargingProfileApplied", {
      connectorId: profile.connectorId,
      profile,
      replaced,
      replacedIds,
      source,
    });
    return true;
  }

  /**
   * Remove the profiles matching `criteria` (1.6 §5.4 / 2.x K10 targets):
   * no `connectorId` clears the station store and every connector, `0` the
   * station store only, `> 0` that connector. Emits one
   * `chargingProfilesCleared` per scope that lost a profile.
   *
   * @returns The non-empty scopes, station store first.
   */
  clearChargingProfiles(
    connectorId: number | undefined,
    criteria: ProfileRemoveCriteria,
    reason: ChargingProfileClearReason,
  ): ClearedChargingProfiles[] {
    const cleared: ClearedChargingProfiles[] = [];
    const report = (scope: number, profiles: ActiveChargingProfile[]) => {
      if (profiles.length === 0) return;
      cleared.push({ connectorId: scope, profiles });
      this.host.events().emit("chargingProfilesCleared", {
        connectorId: scope,
        profiles,
        reason,
      });
    };
    if (connectorId === undefined || connectorId === 0) {
      report(0, this.host.stationProfiles().take(criteria));
    }
    if (connectorId === 0) return cleared;
    const targets =
      connectorId === undefined
        ? this.host.connectors().values()
        : [this.host.chargePoint.getConnector(connectorId)];
    for (const connector of targets) {
      if (connector) {
        report(connector.id, connector.takeChargingProfiles(criteria));
      }
    }
    return cleared;
  }

  /** The currently active ChargePointMaxProfile (highest stackLevel) at the
   *  station level, `null` if none. */
  getActiveChargePointMaxProfile(
    now: Date = this.host.nowDate(),
  ): ActiveChargingProfile | null {
    return this.host
      .stationProfiles()
      .getActive(ChargingProfilePurposeType.ChargePointMaxProfile, now);
  }
}
