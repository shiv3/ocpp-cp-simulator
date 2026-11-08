import { t, type MessageKey } from "../../i18n";
import {
  EV_PRESETS,
  type EVSettings,
  type EVSettingsPatch,
} from "@ocpp-cp-sim/core/cp/domain/connector/EVSettings";
import {
  resolveEvSettings,
  type EditableSpecField,
  type ResolveWarning,
  type VehicleCurrentType,
  type VehicleEvSettings,
  type VehicleProfile,
} from "@ocpp-cp-sim/core/cp/domain/vehicle/VehicleProfile";

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

export const FIELD_LABEL_KEYS: Record<EditableSpecField, MessageKey> = {
  usableBatteryKwh: "common.vehicle.field.usableBatteryKwh",
  acMaxKw: "common.vehicle.field.acMaxKw",
  acPhases: "common.vehicle.field.acPhases",
  dcMaxKw: "common.vehicle.field.dcMaxKw",
};

/** The field's label in the current language. */
export function fieldLabel(field: EditableSpecField): string {
  return t(FIELD_LABEL_KEYS[field]);
}

/** Same as `fieldLabel`, as an object whose entries are translated when read
 *  (so `FIELD_LABELS[f]` in a render follows the language). Spreading it at
 *  module load freezes the language: use `fieldLabel` there instead. */
export const FIELD_LABELS = Object.defineProperties(
  {} as Record<EditableSpecField, string>,
  Object.fromEntries(
    (Object.keys(FIELD_LABEL_KEYS) as EditableSpecField[]).map((field) => [
      field,
      { get: () => fieldLabel(field), enumerable: true },
    ]),
  ),
);

/** Units of the editable specs, for their inputs. */
export const FIELD_UNITS: Record<EditableSpecField, string> = {
  usableBatteryKwh: "kWh",
  acMaxKw: "kW",
  acPhases: "",
  dcMaxKw: "kW",
};

/** What the form shows under a vehicle select after a pick. */
export interface VehicleChoiceNotesState {
  warnings: ResolveWarning[];
  error: string | null;
}

/** What a pick in a vehicle select means for the form. */
type VehicleChoice =
  | {
      kind: "profile";
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
      message: t("common.vehicle.profileGone"),
    };
  }
  const result = resolveEvSettings(profile, currentType);
  if (!result.ok) {
    return {
      kind: "unusable",
      message:
        result.reason === "missing_fields"
          ? t("common.vehicle.unusableMissing", {
              name: profile.name,
              type: currentType,
              fields: result.missing.map((f) => fieldLabel(f)).join(", "),
            })
          : t("common.vehicle.unusableCurve", {
              name: profile.name,
              detail: result.detail,
            }),
    };
  }
  return {
    kind: "profile",
    settings: result.settings,
    warnings: result.warnings,
  };
}

/** What each resolution warning means for the session, in plain words. */
export function describeWarning(warning: ResolveWarning): string {
  switch (warning.code) {
    case "POWER_ABOVE_DC_MAX":
      return t("common.vehicle.warn.powerAboveDcMax", {
        peakKw: warning.peakKw,
        dcMaxKw: warning.dcMaxKw,
      });
    case "CURVE_CAPPED_AT_DC_MAX":
      return t("common.vehicle.warn.curveCapped", {
        peakKw: warning.peakKw,
        dcMaxKw: warning.dcMaxKw,
      });
    case "CURVE_STARTS_ABOVE_ZERO_SOC":
      return t("common.vehicle.warn.curveStartsAboveZero", {
        soc: warning.firstSocPercent,
      });
    case "CURVE_ENDS_BELOW_FULL_SOC":
      return t("common.vehicle.warn.curveEndsBelowFull", {
        soc: warning.lastSocPercent,
      });
    case "NO_DC_CURVE":
      return t("common.vehicle.warn.noDcCurve");
    case "UNSUPPORTED_AC_PHASES":
      return t("common.vehicle.warn.unsupportedAcPhases", {
        phases: warning.acPhases,
      });
    case "AC_PHASES_UNKNOWN":
      return t("common.vehicle.warn.acPhasesUnknown");
  }
}

/** The fields a profile sets that a preset does not have (#458). */
const PROFILE_ONLY_FIELDS = [
  "chargingCurve",
  "currentType",
  "phases",
  "attribution",
] as const;

/**
 * A preset is a whole vehicle: its name, battery and power, a flat curve and
 * no third-party data. Picking one replaces the vehicle the settings hold —
 * whatever it was, and whether or not this edit applied it — so a preset
 * never keeps a profile's curve. What happens to the current type and the
 * phases a preset does not have depends on the form, hence one rule per form.
 */
function presetFields(name: string): Partial<EVSettings> {
  return { modelName: name, ...EV_PRESETS[name] };
}

function withoutProfileFields<T extends Partial<EVSettings>>(settings: T): T {
  const next = { ...settings };
  for (const field of PROFILE_ONLY_FIELDS) delete next[field];
  return next;
}

/** Default EV Settings, stored wholesale: the fields a preset lacks go. */
export function presetForDefaults<T extends Partial<EVSettings>>(
  settings: T,
  name: string,
): T {
  return { ...withoutProfileFields(settings), ...presetFields(name) };
}

/**
 * A scenario's EV settings, where an empty field inherits the connector's:
 * the flat curve and the empty attribution are explicit, so a run takes
 * neither the connector's curve nor the credit of data it no longer holds;
 * the electrical model is left to the connector, like every field a scenario
 * leaves empty (removing it would take a `null` in the scenario file).
 */
export function presetForScenario<T extends Partial<EVSettings>>(
  settings: T,
  name: string,
): T {
  return {
    ...withoutProfileFields(settings),
    ...presetFields(name),
    chargingCurve: [],
    attribution: [],
  };
}

/**
 * A connector's settings, written as a merge patch: every field the preset
 * lacks is removed (`null`), back to the vehicle a preset always was — a flat
 * curve and no electrical model.
 */
export function presetForConnector(name: string): EVSettingsPatch {
  return {
    ...presetFields(name),
    chargingCurve: null,
    currentType: null,
    phases: null,
    attribution: null,
  };
}
