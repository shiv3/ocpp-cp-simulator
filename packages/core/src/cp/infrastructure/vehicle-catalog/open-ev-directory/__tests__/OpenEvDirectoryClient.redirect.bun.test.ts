// Runs under `bun test`: the daemon's own `fetch` follows the redirects.
import { afterEach, describe, expect, it } from "bun:test";

import id7Curves from "../__fixtures__/id7GtxChargingCurves.json";
import id7Variant from "../__fixtures__/id7GtxVariant.json";
import { OpenEvDirectoryClient } from "../OpenEvDirectoryClient";

/**
 * #458 review: a redirect is followed with the API key only on the same
 * origin. Pinned against the daemon's runtime, so a change in how Bun
 * handles `Authorization` on a cross-origin redirect fails here.
 */

const KEY = "evd_live_SENTINEL_redirect";
const servers: { stop: (force: boolean) => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

describe("OpenEvDirectoryClient redirects (#458)", () => {
  it("keeps the key on a same-origin redirect and drops it on another origin", async () => {
    const seen: { origin: string; auth: string | null }[] = [];
    const other = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push({ origin: "other", auth: req.headers.get("authorization") });
        const path = new URL(req.url).pathname;
        return Response.json(
          path.endsWith("/charging-curves") ? id7Curves : id7Variant,
        );
      },
    });
    servers.push(other);
    const catalog = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push({
          origin: "catalog",
          auth: req.headers.get("authorization"),
        });
        const path = new URL(req.url).pathname;
        // A former id moves within the catalog; its curves move elsewhere.
        if (path === "/v1/variants/var_ad04fe41e212ef6a") {
          return Response.redirect(`/v1/variants/${id7Variant.id}`, 302);
        }
        if (path === `/v1/variants/${id7Variant.id}`)
          return Response.json(id7Variant);
        return Response.redirect(`http://localhost:${other.port}${path}`, 302);
      },
    });
    servers.push(catalog);

    const client = new OpenEvDirectoryClient({
      baseUrl: `http://127.0.0.1:${catalog.port}`,
      apiKey: KEY,
    });
    const variant = await client.getVariant("var_ad04fe41e212ef6a");
    expect(variant.id).toBe(id7Variant.id);

    expect(
      seen
        .filter((s) => s.origin === "catalog")
        .every((s) => s.auth === `Bearer ${KEY}`),
    ).toBe(true);
    expect(seen.some((s) => s.origin === "other")).toBe(true);
    expect(
      seen.filter((s) => s.origin === "other").every((s) => s.auth === null),
    ).toBe(true);
  });
});
