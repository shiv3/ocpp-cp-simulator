import React from "react";

import type { ActiveChargingProfile } from "@/cp/domain/connector/Connector";

export interface ChargingProfilesListProps {
  /** Every installed profile; when empty, `current` alone (older
   *  snapshots carry only the composite one). */
  profiles: ReadonlyArray<ActiveChargingProfile>;
  /** The profile the connector currently applies. */
  current: ActiveChargingProfile | null;
}

/**
 * A connector's charging profiles (SetChargingProfile / ClearChargingProfile),
 * collapsed by default: purpose, kind, stack level and schedule periods, with
 * the one in effect marked **Current** and a profile whose every limit is 0
 * marked **Paused**. Same content as the classic side panel's Charging
 * Profile card.
 */
const ChargingProfilesList: React.FC<ChargingProfilesListProps> = ({
  profiles,
  current,
}) => {
  const shown = profiles.length > 0 ? profiles : current ? [current] : [];

  return (
    <details
      data-testid="charging-profiles"
      className="rounded-md bg-cx-sub text-xs"
    >
      <summary className="cursor-pointer select-none px-2 py-1.5 font-medium text-cx-fg2">
        Charging profiles ({shown.length})
      </summary>
      <div className="space-y-2 px-2 pb-2">
        {shown.length === 0 ? (
          <p className="text-cx-muted">
            No charging profile: the connector charges at its unrestricted rate
            until the CSMS sends a SetChargingProfile.
          </p>
        ) : (
          shown.map((profile) => {
            const paused = profile.chargingSchedulePeriods.every(
              (p) => p.limit === 0,
            );
            const isCurrent =
              current?.chargingProfileId === profile.chargingProfileId;
            return (
              <div
                key={profile.chargingProfileId}
                data-profile-id={profile.chargingProfileId}
                className="rounded border border-cx-border bg-cx-card p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-cx-fg">
                    #{profile.chargingProfileId}
                  </span>
                  <span className={paused ? "text-cx-amber" : "text-cx-fg2"}>
                    {paused ? "Paused · " : ""}
                    {isCurrent ? "Current" : "Stored"}
                  </span>
                </div>
                <div className="mt-0.5 text-cx-fg2">
                  {profile.chargingProfilePurpose} ·{" "}
                  {profile.chargingProfileKind} · stack {profile.stackLevel}
                </div>
                <ul className="mt-1 space-y-0.5 font-mono">
                  {profile.chargingSchedulePeriods.map((period, idx) => (
                    <li key={idx} className="flex justify-between gap-2">
                      <span className="text-cx-muted">
                        @{period.startPeriod}s
                      </span>
                      <span className="text-cx-fg">
                        {period.limit} {profile.chargingRateUnit}
                        {period.numberPhases != null
                          ? ` · ${period.numberPhases}φ`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </details>
  );
};

export default ChargingProfilesList;
