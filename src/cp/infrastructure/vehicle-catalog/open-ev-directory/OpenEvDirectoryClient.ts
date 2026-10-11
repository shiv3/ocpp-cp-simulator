import type { z } from "zod";

import {
  VehicleCatalogError,
  type CatalogMake,
  type CatalogModel,
  type CatalogModelQuery,
  type CatalogPage,
  type CatalogVariant,
  type CatalogVariantSummary,
  type VehicleCatalog,
} from "../../../domain/vehicle/VehicleCatalog";

import { REDACTED_VALUE } from "../../../shared/redaction";
import {
  makePageSchema,
  modelPageSchema,
  problemSchema,
  variantChargingCurvesSchema,
  variantPageSchema,
  variantSchema,
} from "./dto";

export const DEFAULT_OED_TIMEOUT_MS = 10_000;
/** The largest page the API serves. */
const MAX_PAGE_SIZE = 200;
const PAGE_SIZE = 50;
/**
 * The most pages of makes read (10,000 makes; the catalog has under 100).
 * Bounds the loop when an upstream reports a `totalPages` it cannot mean.
 */
export const MAX_MAKE_PAGES = 50;

/** The part of `fetch` the client uses; narrower than `typeof fetch` so a test double needs no runtime extras. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenEvDirectoryClientOptions {
  /** The API root, e.g. `https://evd.example.org`. Blank means not configured. */
  baseUrl: string;
  /** The user's personal key. Sent as a bearer token, never in a URL. */
  apiKey?: string;
  timeoutMs?: number;
  /** Test seam. */
  fetch?: FetchLike;
}

/**
 * Open EV Directory adapter of the {@link VehicleCatalog} port (#458).
 *
 * Runs both in the daemon (the key comes from its environment) and in the
 * browser in Local mode (the key the user typed, held in memory). In the
 * browser a cross-origin call the API does not allow fails like a network
 * error, which is reported as `network`.
 *
 * No message built here contains the key: errors carry the request path and
 * what the API said, and the underlying fetch error is not kept as a cause,
 * because a runtime may echo request details in it.
 */
export class OpenEvDirectoryClient implements VehicleCatalog {
  private readonly baseUrl: string | null;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenEvDirectoryClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OED_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  get configured(): boolean {
    return this.baseUrl !== null;
  }

  get authenticated(): boolean {
    return this.apiKey !== undefined;
  }

  async listMakes(): Promise<CatalogMake[]> {
    const makes: CatalogMake[] = [];
    for (let page = 0; ; page++) {
      const body = await this.get(
        "/v1/makes",
        { size: String(MAX_PAGE_SIZE), page: String(page) },
        makePageSchema,
      );
      makes.push(
        ...body.items.map((m) => ({
          id: m.id,
          name: m.name,
          modelCount: m.modelCount,
        })),
      );
      if (page + 1 >= Math.min(body.page.totalPages, MAX_MAKE_PAGES)) {
        return makes;
      }
    }
  }

  async searchModels(
    query: CatalogModelQuery,
  ): Promise<CatalogPage<CatalogModel>> {
    const params: Record<string, string> = {
      size: String(PAGE_SIZE),
      page: String(query.page ?? 0),
    };
    if (query.makeId?.trim()) params.make = query.makeId.trim();
    if (query.model?.trim()) params.model = query.model.trim();
    const body = await this.get("/v1/models", params, modelPageSchema);
    return pageOf(body.page, body.items);
  }

  async listVariants(
    modelId: string,
    page = 0,
  ): Promise<CatalogPage<CatalogVariantSummary>> {
    const body = await this.get(
      `/v1/models/${encodeURIComponent(modelId)}/variants`,
      { size: String(PAGE_SIZE), page: String(page) },
      variantPageSchema,
    );
    return pageOf(body.page, body.items);
  }

  async getVariant(variantId: string): Promise<CatalogVariant> {
    // Both requested at once. A former id answers with a 302 that fetch
    // follows and whose body names the current id; in that rare case the
    // curves are read again under it, and the early answer is dropped.
    const curvesOf = (id: string) =>
      this.get(
        `/v1/variants/${encodeURIComponent(id)}/charging-curves`,
        {},
        variantChargingCurvesSchema,
      );
    const early = curvesOf(variantId);
    early.catch(() => {});
    const variant = await this.get(
      `/v1/variants/${encodeURIComponent(variantId)}`,
      {},
      variantSchema,
    );
    const curves =
      variant.id === variantId ? await early : await curvesOf(variant.id);
    return {
      id: variant.id,
      name: variant.name,
      makeName: variant.make.name,
      modelName: variant.model.name,
      datasetVersion: variant.datasetVersion ?? null,
      sourceRecords: variant.sourceRecords.map((r) => ({
        key: r.key,
        sourceId: r.sourceId,
        makeName: r.makeName,
        modelName: r.modelName,
        variantName: r.variantName ?? "",
        year: r.year ?? null,
        yearKind: r.yearKind ?? null,
        markets: r.markets ?? [],
        sourceUrl: r.sourceUrl ?? null,
        specs: {
          usableBatteryKwh: r.specifications.usableBatteryKwh ?? null,
          acMaxKw: r.specifications.acMaxKw ?? null,
          acPhases: r.specifications.acPhases ?? null,
          dcMaxKw: r.specifications.dcMaxKw ?? null,
          acConnectors: r.specifications.acConnectors ?? [],
          dcConnectors: r.specifications.dcConnectors ?? [],
        },
        license: { ...r.license },
      })),
      curves: curves.items.map((c) => ({
        id: c.id,
        sourceId: c.sourceId,
        sourceRecordKey: c.sourceRecord.key,
        quality: c.quality,
        qualityBasis: c.qualityBasis,
        originalQuality: c.originalQuality,
        observations: [...c.observations],
        points: c.points.map((p) => ({
          socPercent: p.socPercent,
          powerKw: p.powerKw,
        })),
        datasetVersion: c.datasetVersion ?? null,
        license: { ...c.license },
      })),
    };
  }

  private async get<S extends z.ZodType>(
    path: string,
    params: Record<string, string>,
    schema: S,
  ): Promise<z.infer<S>> {
    if (!this.baseUrl) {
      throw new VehicleCatalogError(
        "not_configured",
        "No Open EV Directory URL is configured",
      );
    }
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw transportError(error, path, this.timeoutMs);
    }

    if (!response.ok) throw this.scrub(await statusError(response, path));

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new VehicleCatalogError(
        "invalid_response",
        `Open EV Directory ${path} did not answer with JSON`,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new VehicleCatalogError(
        "invalid_response",
        `Open EV Directory ${path} answered with an unexpected shape`,
      );
    }
    return parsed.data;
  }

  /** A problem `detail` is the API's text: make sure it cannot echo the key. */
  private scrub(error: VehicleCatalogError): VehicleCatalogError {
    if (!this.apiKey || !error.message.includes(this.apiKey)) return error;
    return new VehicleCatalogError(
      error.kind,
      error.message.replaceAll(this.apiKey, REDACTED_VALUE),
      { retryAfterSeconds: error.retryAfterSeconds },
    );
  }
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new VehicleCatalogError(
      "not_configured",
      "The Open EV Directory URL is not a valid URL",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new VehicleCatalogError(
      "not_configured",
      "The Open EV Directory URL must use http or https",
    );
  }
  return trimmed;
}

function pageOf<T>(
  page: { number: number; totalPages: number; totalItems: number },
  items: T[],
): CatalogPage<T> {
  return {
    items,
    page: page.number,
    totalPages: page.totalPages,
    totalItems: page.totalItems,
  };
}

function transportError(
  error: unknown,
  path: string,
  timeoutMs: number,
): VehicleCatalogError {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new VehicleCatalogError(
      "timeout",
      `Open EV Directory ${path} did not answer within ${timeoutMs} ms`,
    );
  }
  return new VehicleCatalogError(
    "network",
    `Open EV Directory ${path} is unreachable (offline, DNS, or a cross-origin call the API does not allow)`,
  );
}

async function statusError(
  response: Response,
  path: string,
): Promise<VehicleCatalogError> {
  const detail = await problemDetail(response);
  const suffix = detail ? `: ${detail}` : "";
  const status = response.status;
  if (status === 401 || status === 403) {
    return new VehicleCatalogError(
      "unauthorized",
      `Open EV Directory refused the API key (HTTP ${status})${suffix}`,
    );
  }
  if (status === 404) {
    return new VehicleCatalogError(
      "not_found",
      `Open EV Directory has no ${path}${suffix}`,
    );
  }
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfter(
      response.headers.get("retry-after"),
    );
    const wait =
      retryAfterSeconds === undefined
        ? ""
        : `; retry in ${retryAfterSeconds} s`;
    return new VehicleCatalogError(
      "rate_limited",
      `Open EV Directory rate limit reached${wait}`,
      { retryAfterSeconds },
    );
  }
  if (status >= 500) {
    return new VehicleCatalogError(
      "unavailable",
      `Open EV Directory failed (HTTP ${status})${suffix}`,
    );
  }
  return new VehicleCatalogError(
    "invalid_request",
    `Open EV Directory rejected ${path} (HTTP ${status})${suffix}`,
  );
}

/** The problem's `detail` (or `title`), when the body is problem JSON. */
async function problemDetail(response: Response): Promise<string | null> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return null;
  try {
    const parsed = problemSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    return parsed.data.detail ?? parsed.data.title ?? null;
  } catch {
    return null;
  }
}

/** `Retry-After` as delta-seconds or an HTTP date, in whole seconds. */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}
