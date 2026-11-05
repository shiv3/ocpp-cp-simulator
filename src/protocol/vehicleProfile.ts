// The vehicle profile data model (#458): what the `vehicle_profiles.*` methods
// carry and what a stored row holds. Data only; the rules that apply a profile
// to a connector (`effectiveSpecs`, `missingFields`, `resolveEvSettings`) stay
// in `cp/domain/vehicle/VehicleProfile.ts`.

/**
 * A reusable vehicle description, saved locally (#458).
 *
 * The shared vehicle object #311 / #327 asked for: it describes the car, not a
 * charging session. A connector, the default EV settings or a scenario take a
 * snapshot of it through `resolveEvSettings`, so a simulation never
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
