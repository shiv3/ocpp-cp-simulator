import type { DataAttribution, EVSettings } from "../connector/EVSettings";

/**
 * A reusable vehicle description, saved locally (#458).
 *
 * The shared vehicle object #311 / #327 asked for: it describes the car, not a
 * charging session. A connector, the default EV settings or a scenario take a
 * snapshot of it through {@link resolveEvSettings}, so a simulation never
 * reads a profile at run time and never needs the catalog it came from.
 */
export interface VehicleProfile {
  id: string;
  /** Display name, also written to `EVSettings.modelName` when applied. */
  name: string;
  /** What the import source says. A value it does not give stays `null`. */
  specs: VehicleSpecs;
  /**
   * The DC charging curve in the source's own units (kW against SoC), in
   * source order. Kept in kW rather than as fractions so a later change of
   * the DC maximum does not rescale it, and so it can be shown as published.
   */
  dcCurve: DcCurvePoint[] | null;
  /** The user's local edits. They win over `specs` and survive a refresh. */
  overrides: VehicleSpecOverrides;
  /** Where the specs and the curve come from; `null` for a hand-made profile. */
  origin: VehicleProfileOrigin | null;
  createdAt: string;
  updatedAt: string;
}

export interface VehicleSpecs {
  usableBatteryKwh: number | null;
  acMaxKw: number | null;
  acPhases: number | null;
  dcMaxKw: number | null;
  /** OCPI 2.3.0 ConnectorType values. */
  acConnectors: string[];
  dcConnectors: string[];
}

/** The numeric specs a user can edit. */
export type EditableSpecField =
  "usableBatteryKwh" | "acMaxKw" | "acPhases" | "dcMaxKw";

/** The editable specs, in display order. */
export const EDITABLE_SPEC_FIELDS: readonly EditableSpecField[] = [
  "usableBatteryKwh",
  "acMaxKw",
  "acPhases",
  "dcMaxKw",
];

export type VehicleSpecOverrides = Partial<Record<EditableSpecField, number>>;

export interface DcCurvePoint {
  socPercent: number;
  powerKw: number;
}

/** How much the source says about the origin of a curve, never overstated. */
export type CurveQuality = "MEASURED" | "DERIVED" | "ESTIMATED" | "UNKNOWN";

export interface VehicleProfileLicense {
  id: string;
  name: string;
  url: string;
  attribution: string;
  shareAlike: boolean;
  /** The source the license applies to, when the response names it. */
  sourceId?: string;
}

/**
 * Provenance of an imported profile. Everything needed to cite the data, to
 * show how trustworthy the curve is, and to refresh it from the same record.
 */
export interface VehicleProfileOrigin {
  provider: "open-ev-directory";
  variantId: string;
  makeName: string;
  modelName: string;
  variantName: string;
  /** The source whose record gave the specs (`gaia`, `kilowatt`). */
  sourceId: string;
  /** `<sourceId>:<externalId>`, immutable in the catalog. */
  sourceRecordKey: string;
  sourceUrl: string | null;
  curveId: string | null;
  /** The source of the curve, which may differ from the specs' source. */
  curveSourceId: string | null;
  curveQuality: CurveQuality | null;
  qualityBasis: string | null;
  observations: string[];
  datasetVersion: string | null;
  licenses: VehicleProfileLicense[];
  importedAt: string;
  /** Set when a refresh found the variant gone; the profile stays usable. */
  removedUpstream?: boolean;
}

export type VehicleCurrentType = "AC" | "DC";

/**
 * The part of {@link EVSettings} a vehicle determines. The curve and the
 * current type are required: settings are *merged* into a connector's
 * (`Connector.applyEvSettingsOverride`), where an absent key keeps the
 * previous vehicle's value, so "no curve" has to be the explicit `[]`.
 * `phases` stays optional because DC ignores it. The attribution is explicit
 * too (`[]` for a hand-made profile): it travels with the copied values.
 */
export type VehicleEvSettings = Pick<
  EVSettings,
  "modelName" | "batteryCapacityKwh" | "maxChargingPowerKw" | "phases"
> &
  Required<Pick<EVSettings, "chargingCurve" | "currentType" | "attribution">>;

/** Facts the user should see when a profile is applied. Nothing is hidden. */
export type ResolveWarning =
  | { code: "POWER_ABOVE_DC_MAX"; dcMaxKw: number; peakKw: number }
  | { code: "CURVE_CAPPED_AT_DC_MAX"; dcMaxKw: number; peakKw: number }
  | { code: "CURVE_STARTS_ABOVE_ZERO_SOC"; firstSocPercent: number }
  | { code: "CURVE_ENDS_BELOW_FULL_SOC"; lastSocPercent: number }
  | { code: "NO_DC_CURVE" }
  | { code: "UNSUPPORTED_AC_PHASES"; acPhases: number }
  | { code: "AC_PHASES_UNKNOWN" };

export type ResolveResult =
  | { ok: true; settings: VehicleEvSettings; warnings: ResolveWarning[] }
  | { ok: false; reason: "missing_fields"; missing: EditableSpecField[] }
  | { ok: false; reason: "invalid_curve"; detail: string };

/** The specs with the user's overrides applied. */
export function effectiveSpecs(profile: VehicleProfile): VehicleSpecs {
  return { ...profile.specs, ...profile.overrides };
}

/**
 * The fields that must be filled in before the profile can be applied with
 * this current type. A missing value is never replaced by a default: a car
 * without a known capacity is not a 75 kWh car.
 */
export function missingFields(
  profile: VehicleProfile,
  currentType: VehicleCurrentType,
): EditableSpecField[] {
  const specs = effectiveSpecs(profile);
  const missing: EditableSpecField[] = [];
  if (!isPositive(specs.usableBatteryKwh)) missing.push("usableBatteryKwh");
  if (currentType === "AC") {
    if (!isPositive(specs.acMaxKw)) missing.push("acMaxKw");
  } else if (!isPositive(specs.dcMaxKw) && curvePeakKw(profile.dcCurve) <= 0) {
    // A curve names the power the car accepts, so its peak stands in for a
    // DC maximum the source does not give.
    missing.push("dcMaxKw");
  }
  return missing;
}

/** The current types whose maximum power is known. */
export function availableCurrentTypes(
  profile: VehicleProfile,
): VehicleCurrentType[] {
  const types: VehicleCurrentType[] = ["AC", "DC"];
  return types.filter(
    (t) => !missingFields(profile, t).some((f) => f !== "usableBatteryKwh"),
  );
}

/**
 * The EV settings this vehicle implies for a session of the given current
 * type.
 *
 * DC: the curve becomes fractions of `max(dcMaxKw, curve peak)`. A source can
 * publish a curve that peaks above its own DC maximum (`POWER_ABOVE_DC_MAX`);
 * dividing by the declared maximum would give fractions above 1, which
 * `normalizeChargingCurve` silently drops. Dividing by the peak keeps every
 * point and the warning says why the maximum is higher than declared.
 *
 * A DC maximum the *user* set (an override) is a limit, not a source claim:
 * the curve is held at it (`CURVE_CAPPED_AT_DC_MAX`), so lowering it lowers
 * the session's power.
 *
 * AC: the AC maximum and the phase count; the catalog's curves are DC only.
 */
export function resolveEvSettings(
  profile: VehicleProfile,
  currentType: VehicleCurrentType,
): ResolveResult {
  const missing = missingFields(profile, currentType);
  if (missing.length > 0)
    return { ok: false, reason: "missing_fields", missing };
  const specs = effectiveSpecs(profile);
  const batteryCapacityKwh = specs.usableBatteryKwh!;
  const warnings: ResolveWarning[] = [];

  if (currentType === "AC") {
    // Explicit flat curve and phase count: see `applyVehicleSettings`.
    const settings: VehicleEvSettings = {
      modelName: profile.name,
      batteryCapacityKwh,
      maxChargingPowerKw: specs.acMaxKw!,
      currentType: "AC",
      chargingCurve: [],
      phases: specs.acPhases === 3 ? 3 : 1,
      attribution: attributionOf(profile),
    };
    if (specs.acPhases === 1 || specs.acPhases === 3) {
      // Taken as given.
    } else if (specs.acPhases == null) {
      warnings.push({ code: "AC_PHASES_UNKNOWN" });
    } else {
      warnings.push({
        code: "UNSUPPORTED_AC_PHASES",
        acPhases: specs.acPhases,
      });
    }
    return { ok: true, settings, warnings };
  }

  const curve = profile.dcCurve ?? [];
  const invalid = curve.find((p) => !isUsableCurvePoint(p));
  if (invalid) {
    return {
      ok: false,
      reason: "invalid_curve",
      detail: `point ${JSON.stringify(invalid)} is outside 0-100 % or below 0 kW`,
    };
  }

  const peakKw = curvePeakKw(curve);
  const dcMaxKw = isPositive(specs.dcMaxKw) ? specs.dcMaxKw : 0;
  const capKw = isPositive(profile.overrides.dcMaxKw)
    ? profile.overrides.dcMaxKw
    : null;
  const maxChargingPowerKw = capKw ?? Math.max(dcMaxKw, peakKw);
  if (capKw !== null && peakKw > capKw) {
    warnings.push({ code: "CURVE_CAPPED_AT_DC_MAX", dcMaxKw: capKw, peakKw });
  } else if (capKw === null && dcMaxKw > 0 && peakKw > dcMaxKw) {
    warnings.push({ code: "POWER_ABOVE_DC_MAX", dcMaxKw, peakKw });
  }

  const settings: VehicleEvSettings = {
    modelName: profile.name,
    batteryCapacityKwh,
    maxChargingPowerKw,
    currentType: "DC",
    attribution: attributionOf(profile),
    chargingCurve: curve.map((p) => ({
      socPercent: p.socPercent,
      powerFraction:
        Math.min(p.powerKw, maxChargingPowerKw) / maxChargingPowerKw,
    })),
  };
  if (curve.length === 0) {
    warnings.push({ code: "NO_DC_CURVE" });
    return { ok: true, settings, warnings };
  }
  const socs = curve.map((p) => p.socPercent);
  const first = Math.min(...socs);
  const last = Math.max(...socs);
  if (first > 0) {
    warnings.push({
      code: "CURVE_STARTS_ABOVE_ZERO_SOC",
      firstSocPercent: first,
    });
  }
  if (last < 100) {
    warnings.push({ code: "CURVE_ENDS_BELOW_FULL_SOC", lastSocPercent: last });
  }
  return { ok: true, settings, warnings };
}

/**
 * Put a resolved vehicle onto existing settings: the session's SoCs and the
 * electrical values a vehicle does not determine (voltage, power factor) are
 * kept. A plain spread, because {@link VehicleEvSettings} already carries an
 * explicit curve and current type.
 */
export function applyVehicleSettings<T extends Partial<EVSettings>>(
  base: T,
  vehicle: VehicleEvSettings,
): T & VehicleEvSettings {
  return { ...base, ...vehicle };
}

/** The credit the profile's sources ask for, in the settings' shape. */
function attributionOf(profile: VehicleProfile): DataAttribution[] {
  return (profile.origin?.licenses ?? []).map((license) => ({
    ...(license.sourceId ? { sourceId: license.sourceId } : {}),
    text: license.attribution,
    licenseName: license.name,
    licenseUrl: license.url,
    shareAlike: license.shareAlike,
  }));
}

function curvePeakKw(curve: readonly DcCurvePoint[] | null): number {
  if (!curve || curve.length === 0) return 0;
  return Math.max(
    0,
    ...curve.map((p) => (Number.isFinite(p.powerKw) ? p.powerKw : 0)),
  );
}

function isUsableCurvePoint(p: DcCurvePoint): boolean {
  return (
    Number.isFinite(p.socPercent) &&
    Number.isFinite(p.powerKw) &&
    p.socPercent >= 0 &&
    p.socPercent <= 100 &&
    p.powerKw >= 0
  );
}

function isPositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
