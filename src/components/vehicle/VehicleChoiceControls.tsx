import React from "react";

import {
  effectiveSpecs,
  missingFields,
  type ResolveWarning,
  type VehicleCurrentType,
  type VehicleProfile,
} from "../../cp/domain/vehicle/VehicleProfile";
import type { VehicleProfilesState } from "../../data/hooks/useVehicleProfiles";
import {
  describeWarning,
  FIELD_LABELS,
  profileOptionValue,
} from "./vehicleChoice";

function optionLabel(
  profile: VehicleProfile,
  currentType: VehicleCurrentType,
): string {
  const missing = missingFields(profile, currentType);
  if (missing.length > 0) {
    return `${profile.name} · ${currentType} (missing ${missing
      .map((f) => FIELD_LABELS[f])
      .join(", ")})`;
  }
  const specs = effectiveSpecs(profile);
  const parts = [`${profile.name} · ${currentType}`];
  parts.push(`${specs.usableBatteryKwh} kWh`);
  if (currentType === "AC") {
    parts.push(`${specs.acMaxKw} kW`);
    if (specs.acPhases) parts.push(`${specs.acPhases} ph`);
  } else {
    if (specs.dcMaxKw) parts.push(`${specs.dcMaxKw} kW`);
    parts.push(profile.dcCurve?.length ? "curve" : "no curve");
  }
  return parts.join(" · ");
}

/** The "Saved profiles" group of a vehicle select. */
export const VehicleProfileOptions: React.FC<{
  state: VehicleProfilesState;
}> = ({ state }) => {
  if (state.error && !state.isKnown) {
    return (
      <optgroup label="Saved profiles">
        <option disabled value="">
          Saved profiles unavailable: {state.error}
        </option>
      </optgroup>
    );
  }
  if (state.profiles.length === 0) return null;
  return (
    <optgroup label="Saved profiles">
      {state.profiles.flatMap((profile) =>
        (["DC", "AC"] as const).map((currentType) => (
          <option
            key={`${profile.id}:${currentType}`}
            value={profileOptionValue(profile.id, currentType)}
            disabled={missingFields(profile, currentType).length > 0}
          >
            {optionLabel(profile, currentType)}
          </option>
        )),
      )}
    </optgroup>
  );
};

/** The notes shown under a vehicle select after a profile is applied. */
export const VehicleChoiceNotes: React.FC<{
  notes: { warnings: ResolveWarning[]; error: string | null } | null;
  className?: string;
}> = ({ notes, className }) => {
  if (!notes) return null;
  if (notes.error) {
    return (
      <p role="alert" className={`text-xs text-cx-rose ${className ?? ""}`}>
        {notes.error}
      </p>
    );
  }
  if (notes.warnings.length === 0) return null;
  return (
    <ul
      aria-label="Vehicle profile notes"
      className={`list-disc space-y-0.5 pl-4 text-xs text-cx-amber ${className ?? ""}`}
    >
      {notes.warnings.map((w) => (
        <li key={w.code}>{describeWarning(w)}</li>
      ))}
    </ul>
  );
};
