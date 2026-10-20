import type {
  CurveQuality,
  DcCurvePoint,
  VehicleProfileLicense,
  VehicleSpecs,
} from "./VehicleProfile";

/**
 * Port to a vehicle catalog an import reads from (#458).
 *
 * The simulator only ever *imports* through it: nothing at run time calls a
 * catalog, so a simulation keeps working when the catalog is unreachable. The
 * shapes below are the catalog as the simulator sees it, and are plain JSON so
 * the daemon can carry them over RPC unchanged.
 */
export interface VehicleCatalog {
  listMakes(): Promise<CatalogMake[]>;
  searchModels(query: CatalogModelQuery): Promise<CatalogPage<CatalogModel>>;
  listVariants(
    modelId: string,
    page?: number,
  ): Promise<CatalogPage<CatalogVariantSummary>>;
  /** The variant, every source record of it, and every curve of it. */
  getVariant(variantId: string): Promise<CatalogVariant>;
}

export interface CatalogModelQuery {
  makeId?: string;
  /** A model id or a part of the model name. */
  model?: string;
  page?: number;
}

export interface CatalogPage<T> {
  items: T[];
  /** 0-based. */
  page: number;
  totalPages: number;
  totalItems: number;
}

export interface CatalogMake {
  id: string;
  name: string;
  modelCount: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  makeId: string;
  makeName: string;
  variantCount: number;
}

export interface CatalogVariantSummary {
  id: string;
  name: string;
  makeId: string;
  modelId: string;
  sources: string[];
  chargingCurveCount: number;
}

/**
 * A variant with its source records side by side. The catalog never
 * consolidates them: two sources may disagree, and the user picks one.
 */
export interface CatalogVariant {
  id: string;
  name: string;
  makeName: string;
  modelName: string;
  datasetVersion: string | null;
  sourceRecords: CatalogSourceRecord[];
  curves: CatalogCurve[];
}

export interface CatalogSourceRecord {
  key: string;
  sourceId: string;
  makeName: string;
  modelName: string;
  variantName: string;
  year: number | null;
  yearKind: string | null;
  markets: string[];
  sourceUrl: string | null;
  specs: VehicleSpecs;
  license: VehicleProfileLicense;
}

/** One source's DC curve. Curves of different sources are never merged. */
export interface CatalogCurve {
  id: string;
  sourceId: string;
  sourceRecordKey: string;
  quality: CurveQuality;
  qualityBasis: string;
  originalQuality: string;
  observations: string[];
  points: DcCurvePoint[];
  datasetVersion: string | null;
  license: VehicleProfileLicense;
}

export type VehicleCatalogErrorKind =
  /** No catalog is configured (no base URL). */
  | "not_configured"
  /** The key is missing, invalid, revoked or expired. */
  | "unauthorized"
  /** The variant or curve does not exist (any more). */
  | "not_found"
  | "rate_limited"
  /** The catalog answered with a server error. */
  | "unavailable"
  | "timeout"
  /** No answer at all: offline, DNS, or a browser blocking a cross-origin call. */
  | "network"
  /** A request the catalog rejected (400), or an answer it should not give. */
  | "invalid_request"
  | "invalid_response";

/**
 * A failed catalog call. The message is safe to show and to log: it never
 * contains the API key.
 */
export class VehicleCatalogError extends Error {
  readonly kind: VehicleCatalogErrorKind;
  /** Seconds to wait before retrying, for `rate_limited` when the catalog says. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    kind: VehicleCatalogErrorKind,
    message: string,
    options: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "VehicleCatalogError";
    this.kind = kind;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
