/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { createHttpHandlers, type CorsPolicy } from "../httpServer";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createLifecycle } from "../lifecycle";

// CORS checks run before dispatch() and don't touch the WS `server`, so an
// opaque cast is enough (mirrors httpServer.basicAuth.test.ts).
const stubServer = null as any;

function makeHandlers(cors: CorsPolicy): ReturnType<typeof createHttpHandlers> {
  const bus = new EventBus();
  const registry = new CPRegistry(bus, null);
  const lifecycle = createLifecycle({ pidPath: null, registry });
  return createHttpHandlers({
    registry,
    bus,
    lifecycle,
    database: null,
    healthPath: "/v1/healthz",
    cors,
  });
}

// A request as the daemon sees it behind a reverse proxy: the proxy connects
// to the internal bind address, sets X-Forwarded-* to the public URL, and the
// browser sends Origin = the public URL.
function proxiedRequest(
  origin: string,
  fwdProto: string,
  fwdHost: string,
  init: { method?: string; path?: string } = {},
): Request {
  return new Request(`http://10.0.0.5:9700${init.path ?? "/v1/healthz"}`, {
    method: init.method ?? "GET",
    headers: {
      origin,
      "x-forwarded-proto": fwdProto,
      "x-forwarded-host": fwdHost,
    },
  });
}

async function run(
  handlers: ReturnType<typeof createHttpHandlers>,
  req: Request,
): Promise<Response> {
  return (await Promise.resolve(handlers.fetch(req, stubServer))) as Response;
}

describe("httpServer same-origin CORS behind a reverse proxy", () => {
  it("rejects the proxied public origin by default (trust off)", async () => {
    const handlers = makeHandlers({ kind: "same-origin" });
    const res = await run(
      handlers,
      proxiedRequest("https://app.example.com", "https", "app.example.com"),
    );
    expect(res.status).toBe(403);
  });

  it("accepts the proxied public origin when trustForwardedHeaders is on", async () => {
    const handlers = makeHandlers({
      kind: "same-origin",
      trustForwardedHeaders: true,
    });
    const res = await run(
      handlers,
      proxiedRequest("https://app.example.com", "https", "app.example.com"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
  });

  it("still rejects an origin that does not match the forwarded host (trust on)", async () => {
    const handlers = makeHandlers({
      kind: "same-origin",
      trustForwardedHeaders: true,
    });
    const res = await run(
      handlers,
      proxiedRequest("https://evil.example.com", "https", "app.example.com"),
    );
    expect(res.status).toBe(403);
  });

  it("still rejects when the forwarded proto differs from the Origin (trust on)", async () => {
    const handlers = makeHandlers({
      kind: "same-origin",
      trustForwardedHeaders: true,
    });
    // Origin is https but the proxy reports http — scheme mismatch must fail.
    const res = await run(
      handlers,
      proxiedRequest("https://app.example.com", "http", "app.example.com"),
    );
    expect(res.status).toBe(403);
  });

  it("takes the first value from a comma-separated forwarded chain (trust on)", async () => {
    const handlers = makeHandlers({
      kind: "same-origin",
      trustForwardedHeaders: true,
    });
    const res = await run(
      handlers,
      proxiedRequest(
        "https://app.example.com",
        "https, http",
        "app.example.com, internal:9700",
      ),
    );
    expect(res.status).toBe(200);
  });

  it("answers socket.io OPTIONS preflight 204 with the forwarded origin echoed (trust on)", async () => {
    const handlers = makeHandlers({
      kind: "same-origin",
      trustForwardedHeaders: true,
    });
    const res = await run(
      handlers,
      proxiedRequest("https://app.example.com", "https", "app.example.com", {
        method: "OPTIONS",
        path: "/socket.io/?EIO=4&transport=polling",
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
  });

  it("preserves genuine same-origin requests when trust is on (no forwarded headers)", async () => {
    const handlers = makeHandlers({
      kind: "same-origin",
      trustForwardedHeaders: true,
    });
    const req = new Request("http://localhost:9700/v1/healthz", {
      headers: { origin: "http://localhost:9700" },
    });
    const res = await run(handlers, req);
    expect(res.status).toBe(200);
  });

  it("ignores forwarded headers entirely when trust is off, even for a same-host match", async () => {
    // Without trust, only the real request host counts. The proxied request's
    // real host is 10.0.0.5:9700, so a public Origin must be rejected.
    const handlers = makeHandlers({ kind: "same-origin" });
    const res = await run(
      handlers,
      proxiedRequest("https://app.example.com", "https", "app.example.com"),
    );
    expect(res.status).toBe(403);
  });
});
