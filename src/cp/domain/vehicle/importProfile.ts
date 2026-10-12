import type {
  CatalogCurve,
  CatalogSourceRecord,
  CatalogVariant,
} from "./VehicleCatalog";
import type {
  VehicleProfile,
  VehicleProfileLicense,
  VehicleProfileOrigin,
  VehicleSpecs,
} from "./VehicleProfile";

/**
 * What the user picked in a variant. Both are explicit: the catalog keeps the
 * sources apart, and the simulator never chooses a "best" record or curve on
 * the user's behalf.
 */
export interface CatalogSelection {
  sourceRecordKey: string;
  /** `null` imports no curve: the vehicle then charges flat at its maximum. */
  curveId: string | null;
}

export type ImportFailure =
  "source_record_not_found" | "curve_not_found" | "not_imported";

export type ImportResult =
  { ok: true; profile: VehicleProfile } | { ok: false; reason: ImportFailure };

/** A new profile from a catalog variant (#458). */
export function profileFromCatalog(
  variant: CatalogVariant,
  selection: CatalogSelection,
  options: { id: string; now: string; name?: string },
): ImportResult {
  const picked = pick(variant, selection);
  if (!picked.ok) return picked;
  const { record, curve } = picked;
  return {
    ok: true,
    profile: {
      id: options.id,
      name: options.name?.trim() || `${variant.makeName} ${variant.name}`,
      specs: copySpecs(record.specs),
      dcCurve: curve ? curve.points.map((p) => ({ ...p })) : null,
      overrides: {},
      origin: originOf(variant, record, curve, options.now),
      createdAt: options.now,
      updatedAt: options.now,
    },
  };
}

/** Provenance a refresh does not compare: when, and the removal flag. */
type UncomparedOriginField = "importedAt" | "removedUpstream";

/** One difference a refresh would bring, shown before it is applied. */
export type RefreshChange =
  | {
      field:
        | keyof VehicleSpecs
        | Exclude<
            keyof VehicleProfileOrigin,
            UncomparedOriginField | "licenses"
          >;
      before: unknown;
      after: unknown;
    }
  /** The curve or the licenses (with their attribution) differ. */
  | { field: "dcCurve" | "licenses" }
  /** The variant was flagged as removed and the catalog has it again. */
  | { field: "backInCatalog" };

export type RefreshResult =
  | {
      ok: true;
      /** The refreshed profile, to save once the user accepts the changes. */
      profile: VehicleProfile;
      changes: RefreshChange[];
      upToDate: boolean;
    }
  | { ok: false; reason: ImportFailure };

const SPEC_FIELDS: readonly (keyof VehicleSpecs)[] = [
  "usableBatteryKwh",
  "acMaxKw",
  "acPhases",
  "dcMaxKw",
  "acConnectors",
  "dcConnectors",
];

/**
 * The profile re-read from the same record and curve of a fresh copy of its
 * variant. Only the imported values change: the name, the user's overrides
 * and the creation date are kept, so a refresh never loses a local edit. The
 * caller saves the result only after showing `changes`.
 */
export function refreshFromCatalog(
  profile: VehicleProfile,
  variant: CatalogVariant,
  now: string,
): RefreshResult {
  const origin = profile.origin;
  if (!origin) return { ok: false, reason: "not_imported" };
  const picked = pick(variant, {
    sourceRecordKey: origin.sourceRecordKey,
    curveId: origin.curveId,
  });
  if (!picked.ok) return picked;
  const { record, curve } = picked;

  const nextOrigin = originOf(variant, record, curve, now);
  const nextCurve = curve ? curve.points.map((p) => ({ ...p })) : null;
  const changes: RefreshChange[] = [];
  for (const field of SPEC_FIELDS) {
    const before = profile.specs[field];
    const after = record.specs[field];
    if (!sameJson(before, after)) changes.push({ field, before, after });
  }
  if (!sameJson(profile.dcCurve, nextCurve)) changes.push({ field: "dcCurve" });
  // Every provenance key, so a field added to the origin later is compared
  // too: a new curve quality or attribution matters as much as a new value.
  const keys = new Set([...Object.keys(nextOrigin), ...Object.keys(origin)]);
  for (const key of keys as Set<keyof VehicleProfileOrigin>) {
    if (key === "importedAt" || key === "removedUpstream") continue;
    const before = origin[key];
    const after = nextOrigin[key];
    if (sameJson(before, after)) continue;
    if (key === "licenses") changes.push({ field: "licenses" });
    else changes.push({ field: key, before, after });
  }
  if (origin.removedUpstream) changes.push({ field: "backInCatalog" });

  return {
    ok: true,
    upToDate: changes.length === 0,
    changes,
    profile: {
      ...profile,
      specs: copySpecs(record.specs),
      dcCurve: nextCurve,
      origin: nextOrigin,
      updatedAt: now,
    },
  };
}

/**
 * The catalog no longer has the variant. The profile keeps every value and
 * stays usable; the flag only tells the user a refresh cannot happen.
 */
export function markRemovedUpstream(
  profile: VehicleProfile,
  now: string,
): VehicleProfile {
  if (!profile.origin) return profile;
  return {
    ...profile,
    origin: { ...profile.origin, removedUpstream: true },
    updatedAt: now,
  };
}

function pick(
  variant: CatalogVariant,
  selection: CatalogSelection,
):
  | { ok: true; record: CatalogSourceRecord; curve: CatalogCurve | null }
  | { ok: false; reason: ImportFailure } {
  const record = variant.sourceRecords.find(
    (r) => r.key === selection.sourceRecordKey,
  );
  if (!record) return { ok: false, reason: "source_record_not_found" };
  if (selection.curveId === null) return { ok: true, record, curve: null };
  const curve = variant.curves.find((c) => c.id === selection.curveId);
  if (!curve) return { ok: false, reason: "curve_not_found" };
  return { ok: true, record, curve };
}

function originOf(
  variant: CatalogVariant,
  record: CatalogSourceRecord,
  curve: CatalogCurve | null,
  now: string,
): VehicleProfileOrigin {
  const licenses: VehicleProfileLicense[] = [
    { ...record.license, sourceId: record.sourceId },
  ];
  if (curve && curve.sourceId !== record.sourceId) {
    licenses.push({ ...curve.license, sourceId: curve.sourceId });
  }
  return {
    provider: "open-ev-directory",
    variantId: variant.id,
    makeName: record.makeName,
    modelName: record.modelName,
    variantName: record.variantName,
    sourceId: record.sourceId,
    sourceRecordKey: record.key,
    sourceUrl: record.sourceUrl,
    curveId: curve?.id ?? null,
    curveSourceId: curve?.sourceId ?? null,
    curveQuality: curve?.quality ?? null,
    qualityBasis: curve?.qualityBasis ?? null,
    observations: curve ? [...curve.observations] : [],
    datasetVersion: curve?.datasetVersion ?? variant.datasetVersion,
    licenses,
    importedAt: now,
  };
}

function copySpecs(specs: VehicleSpecs): VehicleSpecs {
  return {
    ...specs,
    acConnectors: [...specs.acConnectors],
    dcConnectors: [...specs.dcConnectors],
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
