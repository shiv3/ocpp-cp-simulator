import { z } from "zod";

/**
 * The Open EV Directory v1 responses this adapter reads, as published in its
 * `docs/openapi.json` (#458). Only the fields the simulator uses are listed;
 * unknown fields are ignored, so an additive change upstream does not break
 * the import. Nullability follows the OpenAPI document.
 */

const num = z.number().nullable().optional();

const pageMetadata = z.object({
  number: z.number(),
  size: z.number(),
  totalItems: z.number(),
  totalPages: z.number(),
});

export const licenseSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  attribution: z.string(),
  shareAlike: z.boolean(),
});

export const makePageSchema = z.object({
  items: z.array(
    z.object({ id: z.string(), name: z.string(), modelCount: z.number() }),
  ),
  page: pageMetadata,
});

export const modelPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      makeId: z.string(),
      makeName: z.string(),
      variantCount: z.number(),
    }),
  ),
  page: pageMetadata,
});

export const variantPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      makeId: z.string(),
      modelId: z.string(),
      sources: z.array(z.string()),
      chargingCurveCount: z.number(),
    }),
  ),
  page: pageMetadata,
});

const specificationsSchema = z.object({
  usableBatteryKwh: num,
  acMaxKw: num,
  acPhases: num,
  dcMaxKw: num,
  acConnectors: z.array(z.string()).optional(),
  dcConnectors: z.array(z.string()).optional(),
});

export const variantSchema = z.object({
  id: z.string(),
  name: z.string(),
  datasetVersion: z.string().nullable().optional(),
  make: z.object({ id: z.string(), name: z.string() }),
  model: z.object({ id: z.string(), name: z.string() }),
  sourceRecords: z.array(
    z.object({
      key: z.string(),
      sourceId: z.string(),
      makeName: z.string(),
      modelName: z.string(),
      variantName: z.string().nullable().optional(),
      year: z.number().nullable().optional(),
      yearKind: z.string().nullable().optional(),
      markets: z.array(z.string()).optional(),
      sourceUrl: z.string().nullable().optional(),
      specifications: specificationsSchema,
      license: licenseSchema,
    }),
  ),
});

export const quality = z.enum(["MEASURED", "DERIVED", "ESTIMATED", "UNKNOWN"]);

export const chargingCurveSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  quality,
  qualityBasis: z.string(),
  originalQuality: z.string(),
  observations: z.array(z.string()),
  points: z.array(z.object({ socPercent: z.number(), powerKw: z.number() })),
  datasetVersion: z.string().nullable().optional(),
  license: licenseSchema,
  sourceRecord: z.object({ key: z.string() }),
});

export const variantChargingCurvesSchema = z.object({
  items: z.array(chargingCurveSchema),
});

/** RFC 9457 problem details, as far as the adapter reads them. */
export const problemSchema = z.object({
  title: z.string().optional(),
  detail: z.string().optional(),
  status: z.number().optional(),
});
