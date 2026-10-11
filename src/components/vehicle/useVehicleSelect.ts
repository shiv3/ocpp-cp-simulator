import { useState } from "react";

import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import { applyVehicleSettings } from "../../cp/domain/vehicle/VehicleProfile";
import { useVehicleProfiles } from "../../data/hooks/useVehicleProfiles";
import {
  readVehicleChoice,
  withoutProfileFields,
  type VehicleChoiceNotesState,
} from "./vehicleChoice";

/**
 * A vehicle select over EV settings held as one object (#458): the Default
 * EV Settings and a scenario's EV settings. A saved profile is applied with
 * its notes; anything else (a preset, Custom, "use default") is the host's
 * `applyOther`, given the settings with a profile picked earlier in this
 * edit undone, so a preset never keeps that profile's curve.
 */
export function useVehicleSelect<T extends Partial<EVSettings>>(
  value: T,
  onChange: (next: T) => void,
) {
  const profiles = useVehicleProfiles();
  const [beforeProfile, setBeforeProfile] = useState<T | null>(null);
  const [notes, setNotes] = useState<VehicleChoiceNotesState | null>(null);

  const select = (optionValue: string, applyOther: (base: T) => T): void => {
    const choice = readVehicleChoice(optionValue, profiles.profiles);
    if (choice.kind === "unusable") {
      setNotes({ warnings: [], error: choice.message });
      return;
    }
    if (choice.kind === "profile") {
      setBeforeProfile((before) => before ?? value);
      onChange(applyVehicleSettings(value, choice.settings));
      setNotes({ warnings: choice.warnings, error: null });
      return;
    }
    setNotes(null);
    setBeforeProfile(null);
    onChange(applyOther(withoutProfileFields(value, beforeProfile)));
  };

  return { profiles, notes, select };
}
