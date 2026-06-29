import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createHttpHandlers } from "../httpServer";
import { createLifecycle } from "../lifecycle";

const tempDirs: string[] = [];
type FetchServer = Parameters<
  ReturnType<typeof createHttpHandlers>["fetch"]
>[1];
const stubServer = null as unknown as FetchServer;

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("httpServer removed REST control API", () => {
  it("keeps static Basic Auth while leaving healthz unauthenticated", async () => {
    const staticDir = await makeStaticDir();
    const handlers = makeHandlers({
      staticDir,
      webConsoleBasicAuth: {
        username: "operator",
        password: "top-secret",
      },
    });

    const staticRes = await run(handlers, "GET", "/index.html");
    expect(staticRes.status).toBe(401);
    expect(staticRes.headers.get("www-authenticate")).toMatch(/^Basic realm=/);

    const healthRes = await run(handlers, "GET", "/v1/healthz");
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ ok: true });

    const unauthRestRes = await run(handlers, "GET", "/v1/cp");
    expect(unauthRestRes.status).toBe(401);

    const authedRestRes = await run(handlers, "GET", "/v1/cp", {
      headers: { authorization: basicAuthHeader("operator", "top-secret") },
    });
    expect(authedRestRes.status).toBe(404);
  });

  it("returns 404 for removed REST and native WebSocket routes", async () => {
    const staticDir = await makeStaticDir();
    const handlers = makeHandlers({ staticDir });

    const routes: Array<{ method: string; path: string; body?: string }> = [
      { method: "GET", path: "/v1/cp" },
      { method: "POST", path: "/v1/cp", body: "{}" },
      { method: "GET", path: "/v1/cp/X" },
      { method: "PUT", path: "/v1/cp/X", body: "{}" },
      { method: "DELETE", path: "/v1/cp/X" },
      { method: "POST", path: "/v1/cp/X/command", body: "{}" },
      { method: "GET", path: "/v1/cp/X/logs" },
      { method: "POST", path: "/v1/cp/X/logs/clear", body: "{}" },
      { method: "POST", path: "/v1/state/reset", body: "{}" },
      { method: "POST", path: "/v1/shutdown", body: "{}" },
      { method: "GET", path: "/v1/events" },
      { method: "GET", path: "/v1/cp/X/events" },
    ];

    for (const route of routes) {
      const res = await run(handlers, route.method, route.path, {
        body: route.body,
        headers: route.body ? { "content-type": "application/json" } : {},
      });
      if (res.status !== 404) {
        throw new Error(
          `${route.method} ${route.path} returned ${res.status}, expected 404`,
        );
      }
    }
  });
});

function makeHandlers(options: {
  staticDir: string;
  webConsoleBasicAuth?: { username: string; password: string } | null;
}): ReturnType<typeof createHttpHandlers> {
  const bus = new EventBus();
  const registry = new CPRegistry(bus, null);
  const lifecycle = createLifecycle({ pidPath: null, registry });
  return createHttpHandlers({
    registry,
    bus,
    lifecycle,
    database: null,
    healthPath: "/v1/healthz",
    cors: { kind: "any" },
    staticDir: options.staticDir,
    webConsoleBasicAuth: options.webConsoleBasicAuth ?? null,
  });
}

async function run(
  handlers: ReturnType<typeof createHttpHandlers>,
  method: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return (await Promise.resolve(
    handlers.fetch(
      new Request(`http://127.0.0.1:9700${path}`, {
        ...init,
        method,
      }),
      stubServer,
    ),
  )) as Response;
}

async function makeStaticDir(): Promise<string> {
  const staticDir = await mkdtemp(join(tmpdir(), "ocpp-cp-sim-static-"));
  tempDirs.push(staticDir);
  await writeFile(join(staticDir, "index.html"), "<!doctype html><p>ok</p>");
  return staticDir;
}

function basicAuthHeader(user: string, pass: string): string {
  return "Basic " + btoa(`${user}:${pass}`);
}
