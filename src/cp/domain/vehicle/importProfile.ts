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

/** One difference a refresh would bring, shown before it is applied. */
export type RefreshChange =
  | {
      field: keyof VehicleSpecs | "variantId" | "datasetVersion";
      before: unknown;
      after: unknown;
    }
  | { field: "dcCurve" };

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
  if (origin.variantId !== variant.id) {
    changes.push({
      field: "variantId",
      before: origin.variantId,
      after: variant.id,
    });
  }
  if (origin.datasetVersion !== nextOrigin.datasetVersion) {
    changes.push({
      field: "datasetVersion",
      before: origin.datasetVersion,
      after: nextOrigin.datasetVersion,
    });
  }

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
