import { describe, expect, it } from "vitest";
import {
  createAccessGuard,
  forwardedHeadersTrusted,
  isAccessGuardActive,
  isLoopbackIp,
  parseTrustedProxy,
  readForwarded,
} from "../accessGuard";
import { createHttpHandlers } from "../httpServer";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createLifecycle } from "../lifecycle";

const req = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe("isAccessGuardActive", () => {
  it("is off without options (defaults keep today's behavior)", () => {
    expect(isAccessGuardActive({})).toBe(false);
    expect(isAccessGuardActive({ allowedHosts: [], rateLimitPerIp: 0 })).toBe(
      false,
    );
    expect(isAccessGuardActive({ requireTls: true })).toBe(true);
  });
});

describe("parseTrustedProxy / loopback", () => {
  it("parses IPs and CIDRs and rejects junk", () => {
    expect(parseTrustedProxy("10.0.0.0/8")).not.toBeNull();
    expect(parseTrustedProxy("::1")).not.toBeNull();
    expect(parseTrustedProxy("fd00::/8")).not.toBeNull();
    expect(parseTrustedProxy("10.0.0.0/33")).toBeNull();
    expect(parseTrustedProxy("nope")).toBeNull();
    expect(parseTrustedProxy("1.2.3.4/8/9")).toBeNull();
  });
  it("knows loopback, including mapped IPv4", () => {
    expect(isLoopbackIp("127.0.0.1")).toBe(true);
    expect(isLoopbackIp("::1")).toBe(true);
    expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackIp("10.0.0.1")).toBe(false);
    expect(isLoopbackIp(null)).toBe(false);
  });
});

describe("readForwarded", () => {
  it("reads Forwarded and X-Forwarded-* and refuses a disagreement", () => {
    const ok = readForwarded(
      new Headers({ forwarded: "for=1.1.1.1;proto=https;host=a.example" }),
    );
    expect(ok).toMatchObject({
      ok: true,
      info: { proto: "https", host: "a.example" },
    });
    const same = readForwarded(
      new Headers({
        forwarded: "proto=https;host=a.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "A.example",
      }),
    );
    expect(same.ok).toBe(true);
    expect(
      readForwarded(
        new Headers({
          forwarded: "proto=https",
          "x-forwarded-proto": "http",
        }),
      ).ok,
    ).toBe(false);
    expect(
      readForwarded(
        new Headers({
          forwarded: "host=a.example",
          "x-forwarded-host": "b.example",
        }),
      ).ok,
    ).toBe(false);
  });
});

describe("Host allowlist", () => {
  const guard = createAccessGuard({ allowedHosts: ["sim.example.com"] });
  it("passes allowed names, IP literals and localhost", () => {
    for (const url of [
      "http://sim.example.com:9700/",
      "http://SIM.example.com/",
      "http://10.1.2.3:9700/",
      "http://[::1]:9700/",
      "http://localhost:9700/",
    ]) {
      expect(guard.check(req(url), "10.9.9.9").refuse).toBeUndefined();
    }
  });
  it("refuses a rebound name", () => {
    const decision = guard.check(req("http://evil.example:9700/"), "10.9.9.9");
    expect(decision.refuse).toMatchObject({ status: 403 });
  });
  it("checks the forwarded host behind a trusted proxy", () => {
    const g = createAccessGuard({
      allowedHosts: ["sim.example.com"],
      trustedProxies: ["10.0.0.0/8"],
    });
    const viaProxy = req("http://internal:9700/", {
      "x-forwarded-host": "evil.example",
    });
    expect(g.check(viaProxy, "10.0.0.5").refuse?.status).toBe(403);
    const fine = req("http://internal:9700/", {
      "x-forwarded-host": "sim.example.com",
    });
    expect(g.check(fine, "10.0.0.5").refuse).toBeUndefined();
  });
});

describe("trusted proxies", () => {
  const guard = createAccessGuard({ trustedProxies: ["10.0.0.0/8"] });
  it("believes forwarding headers only from a listed peer", () => {
    const r = req("http://x/", { "x-forwarded-host": "a" });
    expect(guard.check(r, "10.0.0.1").forwardedTrusted).toBe(true);
    expect(guard.check(r, "192.168.0.1").forwardedTrusted).toBe(false);
  });
  it("refuses conflicting Forwarded headers from a trusted proxy", () => {
    const r = req("http://x/", {
      forwarded: "proto=https",
      "x-forwarded-proto": "http",
    });
    expect(guard.check(r, "10.0.0.1").refuse?.status).toBe(400);
    // From an untrusted peer the headers are ignored, not refused.
    expect(guard.check(r, "192.168.0.1").refuse).toBeUndefined();
  });
  it("without a list every peer is believed (--trust-forwarded-headers alone)", () => {
    const g = createAccessGuard({ allowedHosts: ["a"] });
    expect(g.check(req("http://a/"), "8.8.8.8").forwardedTrusted).toBe(true);
  });
  it("rejects a malformed entry", () => {
    expect(() => createAccessGuard({ trustedProxies: ["bogus"] })).toThrow();
  });
});

describe("--require-tls", () => {
  const guard = createAccessGuard({
    requireTls: true,
    trustedProxies: ["10.0.0.0/8"],
    healthPath: "/health",
  });
  it("lets direct loopback callers through", () => {
    expect(guard.check(req("http://x/"), "127.0.0.1").refuse).toBeUndefined();
    expect(guard.check(req("http://x/"), "::1").refuse).toBeUndefined();
  });
  it("refuses a remote client without TLS", () => {
    expect(guard.check(req("http://x/"), "192.168.1.5").refuse?.status).toBe(
      403,
    );
    const viaHttp = req("http://x/", {
      "x-forwarded-proto": "http",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(guard.check(viaHttp, "10.0.0.1").refuse?.message).toBe(
      "TLS required",
    );
  });
  it("accepts https reported by a trusted proxy, even on a loopback proxy", () => {
    const viaHttps = req("http://x/", {
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(guard.check(viaHttps, "10.0.0.1").refuse).toBeUndefined();
    const loopbackProxy = createAccessGuard({
      requireTls: true,
      trustedProxies: ["127.0.0.1"],
    });
    const plain = req("http://x/", {
      "x-forwarded-proto": "http",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(loopbackProxy.check(plain, "127.0.0.1").refuse?.status).toBe(403);
  });
  it("exempts the health path", () => {
    expect(
      guard.check(req("http://x/health"), "192.168.1.5").refuse,
    ).toBeUndefined();
  });
});

describe("per-IP rate limit", () => {
  it("allows a burst of `rate` then answers 429 with Retry-After", () => {
    let t = 0;
    const guard = createAccessGuard({
      rateLimitPerIp: 2,
      now: () => t,
    });
    const r = req("http://x/a");
    expect(guard.check(r, "1.1.1.1").refuse).toBeUndefined();
    expect(guard.check(r, "1.1.1.1").refuse).toBeUndefined();
    const refused = guard.check(r, "1.1.1.1").refuse;
    expect(refused?.status).toBe(429);
    expect(refused?.retryAfter).toBeGreaterThanOrEqual(1);
    // Another IP has its own bucket; time refills this one.
    expect(guard.check(r, "2.2.2.2").refuse).toBeUndefined();
    t = 1000;
    expect(guard.check(r, "1.1.1.1").refuse).toBeUndefined();
  });
  it("bounds the number of tracked IPs, dropping the least recent", () => {
    const guard = createAccessGuard({ rateLimitPerIp: 1, rateLimitMaxIps: 3 });
    const r = req("http://x/a");
    for (let i = 1; i <= 50; i++) guard.check(r, `10.0.0.${i}`);
    expect(guard.trackedIps()).toBe(3);
  });
  it("keys on the client behind a trusted proxy, not the proxy", () => {
    const guard = createAccessGuard({
      rateLimitPerIp: 1,
      trustedProxies: ["10.0.0.1"],
    });
    const a = req("http://x/", { "x-forwarded-for": "203.0.113.1" });
    const b = req("http://x/", { "x-forwarded-for": "203.0.113.2" });
    expect(guard.check(a, "10.0.0.1").refuse).toBeUndefined();
    expect(guard.check(b, "10.0.0.1").refuse).toBeUndefined();
    expect(guard.check(a, "10.0.0.1").refuse?.status).toBe(429);
  });
  it("does not trust a spoofed X-Forwarded-For from an unlisted peer", () => {
    const guard = createAccessGuard({
      rateLimitPerIp: 1,
      trustedProxies: ["10.0.0.1"],
    });
    const spoof = (n: number) =>
      req("http://x/", { "x-forwarded-for": `203.0.113.${n}` });
    expect(guard.check(spoof(1), "8.8.8.8").refuse).toBeUndefined();
    expect(guard.check(spoof(2), "8.8.8.8").refuse?.status).toBe(429);
  });
  it("never limits the health path", () => {
    const guard = createAccessGuard({ rateLimitPerIp: 1 });
    for (let i = 0; i < 5; i++) {
      expect(
        guard.check(req("http://x/v1/healthz"), "1.1.1.1").refuse,
      ).toBeUndefined();
    }
  });
});

describe("createHttpHandlers with an access guard", () => {
  function handlers(guard: ReturnType<typeof createAccessGuard> | null) {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    return createHttpHandlers({
      registry,
      bus,
      lifecycle: createLifecycle({ pidPath: null, registry }),
      database: null,
      healthPath: "/v1/healthz",
      cors: { kind: "same-origin", trustForwardedHeaders: true },
      accessGuard: guard,
    });
  }
  const server = (address: string) =>
    ({ requestIP: () => ({ address }) }) as never;

  it("answers 403 before dispatching a refused Host", async () => {
    const h = handlers(createAccessGuard({ allowedHosts: ["ok.example"] }));
    const res = (await h.fetch(
      req("http://evil.example/v1/healthz"),
      server("203.0.113.1"),
    )) as Response;
    expect(res.status).toBe(403);
    const ok = (await h.fetch(
      req("http://ok.example/v1/healthz"),
      server("203.0.113.1"),
    )) as Response;
    expect(ok.status).toBe(200);
  });

  it("sets Retry-After on 429", async () => {
    const h = handlers(createAccessGuard({ rateLimitPerIp: 1 }));
    await h.fetch(req("http://x/index.html"), server("1.1.1.1"));
    const res = (await h.fetch(
      req("http://x/index.html"),
      server("1.1.1.1"),
    )) as Response;
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("ignores X-Forwarded-* for CORS when the peer is not a trusted proxy", async () => {
    const h = handlers(createAccessGuard({ trustedProxies: ["10.0.0.1"] }));
    const headers = {
      origin: "https://public.example",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "public.example",
    };
    const spoofed = (await h.fetch(
      req("http://internal:9700/v1/healthz", headers),
      server("203.0.113.1"),
    )) as Response;
    expect(spoofed.status).toBe(403);
    const proxied = (await h.fetch(
      req("http://internal:9700/v1/healthz", headers),
      server("10.0.0.1"),
    )) as Response;
    expect(proxied.status).toBe(200);
  });

  it("without a guard nothing changes", async () => {
    const res = (await handlers(null).fetch(
      req("http://anything.example/v1/healthz"),
      null as never,
    )) as Response;
    expect(res.status).toBe(200);
  });
});

describe("forwardedHeadersTrusted", () => {
  it("is true for an unmarked request", () => {
    expect(forwardedHeadersTrusted(req("http://x/"))).toBe(true);
  });
});
