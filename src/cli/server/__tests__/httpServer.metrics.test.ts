/* eslint-disable @typescript-eslint/no-explicit-any -- Bun Server stub */
import { describe, expect, it } from "vitest";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createLifecycle } from "../lifecycle";
import { createHttpHandlers } from "../httpServer";
import { MetricsRecorder } from "../metrics/MetricsRecorder";
import { renderMetrics } from "../metrics/render";

// These tests never reach socket.io, so an opaque cast for the Bun `Server`
// argument is enough.
const stubServer = null as any;

function makeHandlers(opts: {
  metrics?: boolean;
  metricsNoAuth?: boolean;
  basicAuth?: { username: string; password: string } | null;
}) {
  const bus = new EventBus();
  const registry = new CPRegistry(bus, null);
  const lifecycle = createLifecycle({ pidPath: null, registry });
  const recorder = new MetricsRecorder();
  return {
    registry,
    recorder,
    handlers: createHttpHandlers({
      registry,
      bus,
      lifecycle,
      database: null,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: opts.basicAuth ?? null,
      metrics: opts.metrics
        ? {
            render: () => renderMetrics(registry, recorder),
            exemptFromBasicAuth: opts.metricsNoAuth === true,
          }
        : null,
    }),
  };
}

function authHeader(user: string, pass: string): string {
  return "Basic " + btoa(unescape(encodeURIComponent(`${user}:${pass}`)));
}

const CREDS = { username: "admin", password: "secret" };

describe("GET /metrics (#298)", () => {
  it("is opt-in, and reserved: an explicit 404 rather than a fallthrough", async () => {
    // With a web console mounted, an unhandled extension-less path reaches the
    // SPA fallback and answers 200 with index.html — a scraper would read HTML
    // as a successful scrape.
    const { handlers } = makeHandlers({});
    const res = (await handlers.fetch(
      new Request("http://localhost/metrics"),
      stubServer,
    )) as Response;
    expect(res.status).toBe(404);
  });

  it("serves the Prometheus text exposition when enabled", async () => {
    const { handlers } = makeHandlers({ metrics: true });
    const res = (await handlers.fetch(
      new Request("http://localhost/metrics"),
      stubServer,
    )) as Response;

    expect(res.status).toBe(200);
    // The version parameter is what makes a scraper parse this as the text
    // exposition rather than guess from the body.
    expect(res.headers.get("content-type")).toBe(
      "text/plain; version=0.0.4; charset=utf-8",
    );
    const body = await res.text();
    expect(body).toContain("# TYPE ocppcp_charge_points gauge");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("refuses anything but GET", async () => {
    const { handlers } = makeHandlers({ metrics: true });
    const res = (await handlers.fetch(
      new Request("http://localhost/metrics", { method: "POST" }),
      stubServer,
    )) as Response;
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("is behind the Basic Auth gate by default, unlike the health path", async () => {
    // The health probe is deliberately unauthenticated so container probes
    // work, and it says almost nothing. /metrics exposes fleet size and
    // traffic shape, so it must not inherit that exemption.
    const { handlers } = makeHandlers({ metrics: true, basicAuth: CREDS });

    const denied = (await handlers.fetch(
      new Request("http://localhost/metrics"),
      stubServer,
    )) as Response;
    expect(denied.status).toBe(401);

    const health = (await handlers.fetch(
      new Request("http://localhost/v1/healthz"),
      stubServer,
    )) as Response;
    expect(health.status).toBe(200);

    const allowed = (await handlers.fetch(
      new Request("http://localhost/metrics", {
        headers: { authorization: authHeader("admin", "secret") },
      }),
      stubServer,
    )) as Response;
    expect(allowed.status).toBe(200);
  });

  it("can be exempted explicitly for a trusted network", async () => {
    const { handlers } = makeHandlers({
      metrics: true,
      metricsNoAuth: true,
      basicAuth: CREDS,
    });
    const res = (await handlers.fetch(
      new Request("http://localhost/metrics"),
      stubServer,
    )) as Response;
    expect(res.status).toBe(200);
  });

  it("does not exempt anything else when it is exempted", async () => {
    const { handlers } = makeHandlers({
      metrics: true,
      metricsNoAuth: true,
      basicAuth: CREDS,
    });
    const res = (await handlers.fetch(
      new Request("http://localhost/v1/cp"),
      stubServer,
    )) as Response;
    expect(res.status).toBe(401);
  });

  it("reflects traffic the recorder counted", async () => {
    const { handlers, recorder } = makeHandlers({ metrics: true });
    recorder.countRpc("cp.list", "ok");
    recorder.countReconnect();

    const body = await (
      (await handlers.fetch(
        new Request("http://localhost/metrics"),
        stubServer,
      )) as Response
    ).text();

    expect(body).toContain(
      'ocppcp_rpc_requests_total{method="cp.list",outcome="ok"} 1',
    );
    expect(body).toContain("ocppcp_ws_reconnects_total 1");
  });
});
