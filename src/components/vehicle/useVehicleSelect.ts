import { useState } from "react";

import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import { applyVehicleSettings } from "../../cp/domain/vehicle/VehicleProfile";
import { useVehicleProfiles } from "../../data/hooks/useVehicleProfiles";
import {
  readVehicleChoice,
  type VehicleChoiceNotesState,
} from "./vehicleChoice";

/**
 * A vehicle select over EV settings held as one object (#458): the Default
 * EV Settings and a scenario's EV settings. A saved profile is applied with
 * its notes; anything else (a preset, Custom, "use default") is the host's
 * `applyOther`, which works from the settings alone — the rule must hold
 * after a save and a reopen, when no edit state remains.
 */
export function useVehicleSelect<T extends Partial<EVSettings>>(
  value: T,
  onChange: (next: T) => void,
) {
  const profiles = useVehicleProfiles();
  const [notes, setNotes] = useState<VehicleChoiceNotesState | null>(null);

  const select = (optionValue: string, applyOther: (base: T) => T): void => {
    const choice = readVehicleChoice(optionValue, profiles.profiles);
    if (choice.kind === "unusable") {
      setNotes({ warnings: [], error: choice.message });
      return;
    }
    if (choice.kind === "profile") {
      onChange(applyVehicleSettings(value, choice.settings));
      setNotes({ warnings: choice.warnings, error: null });
      return;
    }
    setNotes(null);
    onChange(applyOther(value));
  };

  return { profiles, notes, select };
}
