import { EV_PRESETS } from "../../cp/domain/connector/EVSettings";
import {
  resolveEvSettings,
  type EditableSpecField,
  type ResolveWarning,
  type VehicleCurrentType,
  type VehicleEvSettings,
  type VehicleProfile,
} from "../../cp/domain/vehicle/VehicleProfile";

/**
 * Saved vehicle profiles in the vehicle selects (#458): the connector's
 * Config dialog, the Default EV Settings and a scenario's EV settings. Each
 * keeps its own `<select>`; these helpers add the profiles to it and turn a
 * pick into EV settings.
 *
 * A profile is offered once per current type, because the same car charges
 * differently on AC and DC; a type it lacks a value for is listed disabled,
 * with what is missing, rather than hidden.
 */

const PROFILE_PREFIX = "vehicle-profile:";

export function profileOptionValue(
  profileId: string,
  currentType: VehicleCurrentType,
): string {
  return `${PROFILE_PREFIX}${currentType}:${profileId}`;
}

export function isPresetName(name: string | undefined): boolean {
  return name !== undefined && Object.keys(EV_PRESETS).includes(name);
}

export const FIELD_LABELS: Record<EditableSpecField, string> = {
  usableBatteryKwh: "usable battery capacity",
  acMaxKw: "AC maximum power",
  acPhases: "AC phases",
  dcMaxKw: "DC maximum power",
};

/** What a pick in a vehicle select means for the form. */
export type VehicleChoice =
  | {
      kind: "profile";
      profile: VehicleProfile;
      currentType: VehicleCurrentType;
      settings: VehicleEvSettings;
      warnings: ResolveWarning[];
    }
  | { kind: "unusable"; message: string }
  | { kind: "other" };

/** Reads a select value: a saved profile resolved for its current type, or
 *  anything else the host select handles itself (a preset, Custom, …). */
export function readVehicleChoice(
  value: string,
  profiles: readonly VehicleProfile[],
): VehicleChoice {
  if (!value.startsWith(PROFILE_PREFIX)) return { kind: "other" };
  const rest = value.slice(PROFILE_PREFIX.length);
  const currentType = rest.slice(0, 2) as VehicleCurrentType;
  const profile = profiles.find((p) => p.id === rest.slice(3));
  if (!profile || (currentType !== "AC" && currentType !== "DC")) {
    return {
      kind: "unusable",
      message: "This vehicle profile no longer exists.",
    };
  }
  const result = resolveEvSettings(profile, currentType);
  if (!result.ok) {
    return {
      kind: "unusable",
      message:
        result.reason === "missing_fields"
          ? `${profile.name} cannot be used for ${currentType}: ${result.missing
              .map((f) => FIELD_LABELS[f])
              .join(
                ", ",
              )} missing. Fill it in under Settings → Vehicle profiles.`
          : `${profile.name} has a DC curve the simulator cannot use: ${result.detail}.`,
    };
  }
  return {
    kind: "profile",
    profile,
    currentType,
    settings: result.settings,
    warnings: result.warnings,
  };
}

/** What each resolution warning means for the session, in plain words. */
export function describeWarning(warning: ResolveWarning): string {
  switch (warning.code) {
    case "POWER_ABOVE_DC_MAX":
      return `The curve peaks at ${warning.peakKw} kW, above the declared DC maximum of ${warning.dcMaxKw} kW: the maximum is set to ${warning.peakKw} kW so no point of the curve is lost.`;
    case "CURVE_STARTS_ABOVE_ZERO_SOC":
      return `The curve starts at ${warning.firstSocPercent} % SoC: below that, its first power is held.`;
    case "CURVE_ENDS_BELOW_FULL_SOC":
      return `The curve ends at ${warning.lastSocPercent} % SoC: above that, its last power is held.`;
    case "NO_DC_CURVE":
      return "No DC curve: the vehicle charges flat at its maximum power.";
    case "UNSUPPORTED_AC_PHASES":
      return `The source gives ${warning.acPhases} AC phases; the simulator models 1 or 3, so the phase count is left unset (single phase).`;
    case "AC_PHASES_UNKNOWN":
      return "The source gives no AC phase count: single phase is assumed.";
  }
}
