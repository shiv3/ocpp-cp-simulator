import React, { useMemo } from "react";

import {
  effectiveSpecs,
  missingFields,
  type EditableSpecField,
  type VehicleCurrentType,
  type VehicleProfile,
} from "../../cp/domain/vehicle/VehicleProfile";
import type { VehicleProfilesState } from "../../data/hooks/useVehicleProfiles";
import { cn } from "../../lib/utils";
import {
  describeWarning,
  FIELD_LABELS,
  isPresetName,
  profileOptionValue,
  type VehicleChoiceNotesState,
} from "./vehicleChoice";

function optionLabel(
  profile: VehicleProfile,
  currentType: VehicleCurrentType,
  missing: readonly EditableSpecField[],
): string {
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
  // Recomputed only when the profiles change, not on every keystroke of the
  // form around the select.
  const options = useMemo(
    () =>
      state.profiles.flatMap((profile) =>
        (["DC", "AC"] as const).map((currentType) => {
          const missing = missingFields(profile, currentType);
          return {
            key: `${profile.id}:${currentType}`,
            value: profileOptionValue(profile.id, currentType),
            disabled: missing.length > 0,
            label: optionLabel(profile, currentType, missing),
          };
        }),
      ),
    [state.profiles],
  );
  if (state.error && !state.isKnown) {
    return (
      <optgroup label="Saved profiles">
        <option disabled value="">
          Saved profiles unavailable: {state.error}
        </option>
      </optgroup>
    );
  }
  if (options.length === 0) return null;
  return (
    <optgroup label="Saved profiles">
      {options.map((o) => (
        <option key={o.key} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </optgroup>
  );
};

/** The current model, when it is no preset (an applied profile, a scenario's
 *  EV), shown under its own name rather than as "Custom". */
export const OwnModelOption: React.FC<{ modelName: string | undefined }> = ({
  modelName,
}) =>
  modelName && !isPresetName(modelName) ? (
    <option value={modelName}>{modelName}</option>
  ) : null;

/** The notes shown under a vehicle select after a profile is applied. */
export const VehicleChoiceNotes: React.FC<{
  notes: VehicleChoiceNotesState | null;
  className?: string;
}> = ({ notes, className }) => {
  if (!notes) return null;
  if (notes.error) {
    return (
      <p role="alert" className={cn("text-xs text-cx-rose", className)}>
        {notes.error}
      </p>
    );
  }
  if (notes.warnings.length === 0) return null;
  return (
    <ul
      aria-label="Vehicle profile notes"
      className={cn(
        "list-disc space-y-0.5 pl-4 text-xs text-cx-amber",
        className,
      )}
    >
      {notes.warnings.map((w) => (
        <li key={w.code}>{describeWarning(w)}</li>
      ))}
    </ul>
  );
};
