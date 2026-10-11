import { describe, expect, it } from "vitest";

import {
  VehicleCatalogError,
  type VehicleCatalogErrorKind,
} from "../../../../domain/vehicle/VehicleCatalog";
import {
  MAX_MAKE_PAGES,
  OpenEvDirectoryClient,
  type FetchLike,
} from "../OpenEvDirectoryClient";

import id7Curves from "../__fixtures__/id7GtxChargingCurves.json";
import id7Variant from "../__fixtures__/id7GtxVariant.json";
import id4Variants from "../__fixtures__/id4ModelVariantsFromGaia.json";
import invalidQuality from "../__fixtures__/invalidQuality.json";
import makes from "../__fixtures__/makes.json";
import modelsMatchingId4 from "../__fixtures__/modelsMatchingId4.json";
import unknownVariant from "../__fixtures__/unknownVariant.json";

const BASE = "https://evd.example.test/";
const KEY = "evd_live_SENTINEL_0123456789abcdef";

interface Call {
  url: string;
  headers: Record<string, string>;
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type":
        status >= 400 ? "application/problem+json" : "application/json",
      ...headers,
    },
  });
}

/** A fake `fetch` answering by path, recording every request. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, headers });
    const { pathname, search } = new URL(url);
    const route = routes[pathname + search] ?? routes[pathname];
    if (!route) return json({ status: 404, title: "Not Found" }, 404);
    return route();
  }) satisfies FetchLike;
  return { impl, calls };
}

function client(
  routes: Record<string, () => Response | Promise<Response>>,
  apiKey?: string,
) {
  const fake = fakeFetch(routes);
  return {
    client: new OpenEvDirectoryClient({
      baseUrl: BASE,
      apiKey,
      fetch: fake.impl,
      timeoutMs: 1000,
    }),
    calls: fake.calls,
  };
}

async function failure(
  promise: Promise<unknown>,
): Promise<VehicleCatalogError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(VehicleCatalogError);
    return e as VehicleCatalogError;
  }
  throw new Error("expected a failure");
}

describe("OpenEvDirectoryClient — reads (#458)", () => {
  it("lists makes", async () => {
    const { client: c, calls } = client({ "/v1/makes": () => json(makes) });
    const result = await c.listMakes();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toEqual({
      id: expect.any(String),
      name: expect.any(String),
      modelCount: expect.any(Number),
    });
    expect(new URL(calls[0]!.url).searchParams.get("size")).toBe("200");
  });

  it("searches models by make and name", async () => {
    const { client: c, calls } = client({
      "/v1/models": () => json(modelsMatchingId4),
    });
    const page = await c.searchModels({ makeId: "volkswagen", model: "id.4" });
    expect(page.items[0]).toEqual({
      id: "volkswagen--id-4",
      name: "ID.4",
      makeId: "volkswagen",
      makeName: "Volkswagen",
      variantCount: 11,
    });
    expect(page.page).toBe(0);
    const query = new URL(calls[0]!.url).searchParams;
    expect(query.get("make")).toBe("volkswagen");
    expect(query.get("model")).toBe("id.4");
  });

  it("lists the variants of a model", async () => {
    const { client: c, calls } = client({
      "/v1/models/volkswagen--id-4/variants": () => json(id4Variants),
    });
    const page = await c.listVariants("volkswagen--id-4", 2);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]).toMatchObject({
      id: expect.stringMatching(/^var_/),
      modelId: "volkswagen--id-4",
      sources: expect.any(Array),
      chargingCurveCount: expect.any(Number),
    });
    expect(new URL(calls[0]!.url).searchParams.get("page")).toBe("2");
  });

  it("reads a variant with every source record and every curve", async () => {
    const { client: c } = client({
      "/v1/variants/var_b16bdbae5aa906a7": () => json(id7Variant),
      "/v1/variants/var_b16bdbae5aa906a7/charging-curves": () =>
        json(id7Curves),
    });
    const variant = await c.getVariant("var_b16bdbae5aa906a7");
    expect(variant).toMatchObject({
      id: "var_b16bdbae5aa906a7",
      name: "ID.7 GTX",
      makeName: "Volkswagen",
      modelName: "ID.7",
      datasetVersion: "sha256:b1e424ab58d32fcf",
    });
    expect(variant.sourceRecords.map((r) => r.key)).toEqual([
      "gaia:volkswagen-id7-gtx-2024",
      "kilowatt:2854a132-20b9-4bb1-b18a-fc0fec23a346",
    ]);
    expect(variant.sourceRecords[0]!.specs).toEqual({
      usableBatteryKwh: 86,
      acMaxKw: 11,
      acPhases: 3,
      dcMaxKw: 200,
      acConnectors: ["IEC_62196_T2"],
      dcConnectors: ["IEC_62196_T2_COMBO"],
    });
    expect(variant.sourceRecords[0]!.license.attribution).toContain("EVDB");
    expect(variant.curves.map((c) => [c.id, c.sourceId, c.quality])).toEqual([
      ["crv_2523855ffac08d0a", "gaia", "UNKNOWN"],
      ["crv_8fb466d59158ccb5", "kilowatt", "UNKNOWN"],
    ]);
    expect(variant.curves[0]!).toMatchObject({
      sourceRecordKey: "gaia:volkswagen-id7-gtx-2024",
      observations: ["ENDS_BELOW_FULL_SOC"],
      qualityBasis: expect.stringContaining("no curve-level evidence"),
    });
    expect(variant.curves[0]!.points[0]).toEqual({
      socPercent: 0,
      powerKw: 200,
    });
  });

  it("reads a variant that moved under a new id from the redirected body", async () => {
    // `fetch` follows the 302; the body names the current id.
    const { client: c, calls } = client({
      "/v1/variants/var_ad04fe41e212ef6a": () => json(id7Variant),
      "/v1/variants/var_b16bdbae5aa906a7/charging-curves": () =>
        json(id7Curves),
    });
    const variant = await c.getVariant("var_ad04fe41e212ef6a");
    expect(variant.id).toBe("var_b16bdbae5aa906a7");
    // The curves are read again under the id the body names.
    expect(
      calls.some((c) =>
        c.url.includes("/v1/variants/var_b16bdbae5aa906a7/charging-curves"),
      ),
    ).toBe(true);
  });
});

describe("OpenEvDirectoryClient — paging (#458)", () => {
  it("stops reading makes after a bounded number of pages", async () => {
    const { client: c, calls } = client({
      "/v1/makes": () =>
        json({
          items: [{ id: "x", name: "X", modelCount: 1 }],
          page: { number: 0, size: 200, totalItems: 1e9, totalPages: 1e7 },
        }),
    });
    const result = await c.listMakes();
    expect(calls).toHaveLength(MAX_MAKE_PAGES);
    expect(result).toHaveLength(MAX_MAKE_PAGES);
  });
});

describe("OpenEvDirectoryClient — credentials (#458)", () => {
  it("sends the key as a bearer token when one is set", async () => {
    const { client: c, calls } = client(
      { "/v1/makes": () => json(makes) },
      KEY,
    );
    await c.listMakes();
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.url).not.toContain(KEY);
  });

  it("sends no authorization header without a key", async () => {
    const { client: c, calls } = client({ "/v1/makes": () => json(makes) });
    await c.listMakes();
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers.accept).toContain("application/json");
  });

  it("is not configured without a base URL", async () => {
    const c = new OpenEvDirectoryClient({ baseUrl: "  " });
    expect((await failure(c.listMakes())).kind).toBe("not_configured");
    expect(c.configured).toBe(false);
  });

  it("refuses a base URL that is not http(s)", () => {
    expect(
      () => new OpenEvDirectoryClient({ baseUrl: "ftp://evd.example.test" }),
    ).toThrow(VehicleCatalogError);
  });
});

describe("OpenEvDirectoryClient — failures never leak the key (#458)", () => {
  const cases: [
    string,
    () => Response | Promise<Response>,
    VehicleCatalogErrorKind,
  ][] = [
    [
      "401",
      () => json({ status: 401, title: "Unauthorized" }, 401),
      "unauthorized",
    ],
    [
      "403",
      () => json({ status: 403, title: "Forbidden" }, 403),
      "unauthorized",
    ],
    ["404 problem", () => json(unknownVariant, 404), "not_found"],
    ["400 problem", () => json(invalidQuality, 400), "invalid_request"],
    ["500", () => new Response("boom", { status: 500 }), "unavailable"],
    ["503", () => new Response("", { status: 503 }), "unavailable"],
    [
      "a body that is not JSON",
      () => new Response("<html>", { status: 200 }),
      "invalid_response",
    ],
    [
      "a body of the wrong shape",
      () => json({ items: "nope" }),
      "invalid_response",
    ],
    [
      "a network failure",
      () => Promise.reject(new TypeError(`Failed to fetch ${KEY}`)),
      "network",
    ],
    [
      "a timeout",
      () =>
        Promise.reject(
          new DOMException("The operation timed out.", "TimeoutError"),
        ),
      "timeout",
    ],
  ];

  for (const [label, route, kind] of cases) {
    it(`maps ${label} to ${kind}`, async () => {
      const { client: c } = client(
        {
          "/v1/variants/var_x": route,
          "/v1/variants/var_x/charging-curves": route,
        },
        KEY,
      );
      const error = await failure(c.getVariant("var_x"));
      expect(error.kind).toBe(kind);
      expect(error.message).not.toContain(KEY);
      expect(String(error.stack)).not.toContain(KEY);
      expect(JSON.stringify(error)).not.toContain(KEY);
    });
  }

  it("names the missing variant from the problem details", async () => {
    const { client: c } = client({
      "/v1/variants/var_0000000000000000": () => json(unknownVariant, 404),
    });
    const error = await failure(c.getVariant("var_0000000000000000"));
    expect(error.message).toContain(
      "No variant with id 'var_0000000000000000'",
    );
  });

  it("reads Retry-After in seconds", async () => {
    const { client: c } = client({
      "/v1/makes": () =>
        json({ status: 429, title: "Too Many Requests" }, 429, {
          "retry-after": "30",
        }),
    });
    const error = await failure(c.listMakes());
    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(30);
  });

  it("reads Retry-After as an HTTP date", async () => {
    const at = new Date(Date.now() + 90_000).toUTCString();
    const { client: c } = client({
      "/v1/makes": () =>
        new Response("", { status: 429, headers: { "retry-after": at } }),
    });
    const error = await failure(c.listMakes());
    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBeGreaterThan(80);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(90);
  });

  it("leaves Retry-After unset when the catalog gives none", async () => {
    const { client: c } = client({
      "/v1/makes": () => new Response("", { status: 429 }),
    });
    const error = await failure(c.listMakes());
    expect(error.retryAfterSeconds).toBeUndefined();
  });
});
