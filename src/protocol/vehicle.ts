import { z } from "zod";

import type { VehicleProfile } from "../cp/domain/vehicle/VehicleProfile";
import { STR_1K, STR_256 } from "./limits";

/**
 * Wire and storage shape of a {@link VehicleProfile} (#458).
 *
 * Validated where a profile enters from outside the domain: the
 * `vehicle_profiles.save` RPC and a stored row read back. Bounded like every
 * other control-plane payload, so a hostile client cannot store an unbounded
 * curve. Numbers are finite and non-negative; whether a value is *enough* to
 * apply the profile is the domain's `missingFields`, not this schema.
 */

/** More points than any published curve has; a guard, not a limit users meet. */
export const MAX_VEHICLE_CURVE_POINTS = 512;
export const MAX_VEHICLE_PROFILES = 1_000;

const KW = z.number().finite().min(0);
const NULLABLE_KW = KW.nullable();
const CONNECTORS = z.array(STR_256).max(32);

const specsSchema = z.object({
  usableBatteryKwh: NULLABLE_KW,
  acMaxKw: NULLABLE_KW,
  acPhases: NULLABLE_KW,
  dcMaxKw: NULLABLE_KW,
  acConnectors: CONNECTORS,
  dcConnectors: CONNECTORS,
});

const overridesSchema = z.object({
  usableBatteryKwh: KW.optional(),
  acMaxKw: KW.optional(),
  acPhases: KW.optional(),
  dcMaxKw: KW.optional(),
});

const licenseSchema = z.object({
  id: STR_256,
  name: STR_256,
  url: STR_1K,
  attribution: STR_1K,
  shareAlike: z.boolean(),
  sourceId: STR_256.optional(),
});

const originSchema = z.object({
  provider: z.literal("open-ev-directory"),
  variantId: STR_256.min(1),
  makeName: STR_256,
  modelName: STR_256,
  variantName: STR_256,
  sourceId: STR_256.min(1),
  sourceRecordKey: STR_256.min(1),
  sourceUrl: STR_1K.nullable(),
  curveId: STR_256.nullable(),
  curveSourceId: STR_256.nullable(),
  curveQuality: z
    .enum(["MEASURED", "DERIVED", "ESTIMATED", "UNKNOWN"])
    .nullable(),
  qualityBasis: STR_1K.nullable(),
  observations: z.array(STR_256).max(32),
  datasetVersion: STR_256.nullable(),
  licenses: z.array(licenseSchema).max(16),
  importedAt: STR_256,
  removedUpstream: z.boolean().optional(),
});

export const vehicleProfileSchema = z.object({
  id: STR_256.min(1).describe("Profile identifier"),
  name: STR_256.min(1).describe("Display name, also the EV model name"),
  specs: specsSchema,
  dcCurve: z
    .array(
      z.object({
        socPercent: z.number().finite().min(0).max(100),
        powerKw: KW,
      }),
    )
    .max(MAX_VEHICLE_CURVE_POINTS)
    .nullable()
    .describe("DC curve in kW against SoC, in source order"),
  overrides: overridesSchema.describe("Local edits, kept across a refresh"),
  origin: originSchema
    .nullable()
    .describe("Provenance of an imported profile; null when hand-made"),
  createdAt: STR_256,
  updatedAt: STR_256,
}) satisfies z.ZodType<VehicleProfile>;

// ---------------------------------------------------------------------------
// Catalog results carried over RPC (`vehicle_catalog.*`). The daemon calls the
// catalog with its own key and returns these; the key never crosses the wire.

/** The largest page the catalog serves. */
export const MAX_CATALOG_PAGE_ITEMS = 200;

const catalogLicenseSchema = licenseSchema.omit({ sourceId: true });
/**
 * A make, model or variant id as a path segment: letters, digits, `_` and
 * `-` only. `.`, `..`, `/` or `?` would let an id reach another path of the
 * catalog with the daemon's key.
 */
export const CATALOG_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CATALOG_ID = STR_256.regex(CATALOG_ID_PATTERN);

const catalogPage = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item).max(MAX_CATALOG_PAGE_ITEMS),
    page: z.number().int().min(0),
    totalPages: z.number().int().min(0),
    totalItems: z.number().int().min(0),
  });

const CATALOG_PAGE_PARAM = z.number().int().min(0).max(100_000).optional();

export const catalogMakeSchema = z.object({
  id: STR_256,
  name: STR_256,
  modelCount: z.number().int().min(0),
});

export const catalogModelSchema = z.object({
  id: STR_256,
  name: STR_256,
  makeId: STR_256,
  makeName: STR_256,
  variantCount: z.number().int().min(0),
});

export const catalogVariantSummarySchema = z.object({
  id: STR_256,
  name: STR_256,
  makeId: STR_256,
  modelId: STR_256,
  sources: z.array(STR_256).max(32),
  chargingCurveCount: z.number().int().min(0),
});

export const catalogVariantSchema = z.object({
  id: STR_256,
  name: STR_256,
  makeName: STR_256,
  modelName: STR_256,
  datasetVersion: STR_256.nullable(),
  sourceRecords: z
    .array(
      z.object({
        key: STR_256,
        sourceId: STR_256,
        makeName: STR_256,
        modelName: STR_256,
        variantName: STR_256,
        year: z.number().int().nullable(),
        yearKind: STR_256.nullable(),
        markets: z.array(STR_256).max(256),
        sourceUrl: STR_1K.nullable(),
        specs: specsSchema,
        license: catalogLicenseSchema,
      }),
    )
    .max(64),
  curves: z
    .array(
      z.object({
        id: STR_256,
        sourceId: STR_256,
        sourceRecordKey: STR_256,
        quality: z.enum(["MEASURED", "DERIVED", "ESTIMATED", "UNKNOWN"]),
        qualityBasis: STR_1K,
        originalQuality: STR_1K,
        observations: z.array(STR_256).max(32),
        points: z
          .array(
            z.object({
              socPercent: z.number().finite().min(0).max(100),
              powerKw: KW,
            }),
          )
          .max(MAX_VEHICLE_CURVE_POINTS),
        datasetVersion: STR_256.nullable(),
        license: catalogLicenseSchema,
      }),
    )
    .max(64),
});

export const catalogMakesSchema = z.array(catalogMakeSchema).max(10_000);
export const catalogModelPageSchema = catalogPage(catalogModelSchema);
export const catalogVariantPageSchema = catalogPage(
  catalogVariantSummarySchema,
);

/** `vehicle_catalog.*` and `vehicle_profiles.*` entries of the METHODS table. */
export const VEHICLE_METHODS = {
  "vehicle_profiles.list": {
    params: z.object({}),
    result: z.array(vehicleProfileSchema).max(MAX_VEHICLE_PROFILES),
  },
  "vehicle_profiles.save": {
    params: z.object({ profile: vehicleProfileSchema }),
    result: vehicleProfileSchema,
  },
  "vehicle_profiles.delete": {
    params: z.object({ id: STR_256.min(1) }),
    result: z.object({ ok: z.literal(true) }),
  },
  "vehicle_catalog.list_makes": {
    params: z.object({}),
    result: catalogMakesSchema,
  },
  "vehicle_catalog.search_models": {
    params: z.object({
      makeId: CATALOG_ID.optional(),
      model: STR_256.optional(),
      page: CATALOG_PAGE_PARAM,
    }),
    result: catalogModelPageSchema,
  },
  "vehicle_catalog.list_variants": {
    params: z.object({ modelId: CATALOG_ID, page: CATALOG_PAGE_PARAM }),
    result: catalogVariantPageSchema,
  },
  "vehicle_catalog.get_variant": {
    params: z.object({ variantId: CATALOG_ID }),
    result: catalogVariantSchema,
  },
} as const;

/** `server.info.vehicleCatalog`: whether the daemon can import, never the key. */
export const vehicleCatalogInfoSchema = z.object({
  provider: z.literal("open-ev-directory"),
  /** A base URL is set. */
  configured: z.boolean(),
  /** An API key is set (its value is never exposed). */
  authenticated: z.boolean(),
});
export type VehicleCatalogInfo = z.infer<typeof vehicleCatalogInfoSchema>;
