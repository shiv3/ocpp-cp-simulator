/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHttpHandlers } from "../httpServer";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createLifecycle } from "../lifecycle";

// serveStatic uses Bun.file, so this lives in a `.bun.test.ts` file that runs
// under `bun test` rather than vitest.
//
// Covers issue #79: the daemon must emit semantically-correct Cache-Control
// headers so a CDN behind forward-auth doesn't edge-cache auth-gated assets by
// file extension, while still letting content-hashed build assets cache long.

const stubServer = null as any;

let staticDir: string;

function makeHandlers(): ReturnType<typeof createHttpHandlers> {
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
    staticDir,
  });
}

async function run(req: Request): Promise<Response> {
  const handlers = makeHandlers();
  return (await Promise.resolve(handlers.fetch(req, stubServer))) as Response;
}

beforeAll(() => {
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocpp-static-"));
  fs.mkdirSync(path.join(staticDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(staticDir, "index.html"),
    "<!doctype html><html><body>hi</body></html>",
  );
  fs.writeFileSync(
    path.join(staticDir, "assets", "index-abc123.js"),
    "console.log('hi');",
  );
});

afterAll(() => {
  fs.rmSync(staticDir, { recursive: true, force: true });
});

describe("httpServer static Cache-Control (issue #79)", () => {
  it("marks content-hashed /assets/* as immutable, long-lived", async () => {
    const res = await run(
      new Request("http://127.0.0.1:9700/assets/index-abc123.js"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("marks the HTML entry point (/) as no-store", async () => {
    const res = await run(new Request("http://127.0.0.1:9700/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("marks an explicit index.html request as no-store", async () => {
    const res = await run(new Request("http://127.0.0.1:9700/index.html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("marks the SPA fallback (deep link) as no-store", async () => {
    const res = await run(new Request("http://127.0.0.1:9700/settings"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("marks missing asset responses as no-store", async () => {
    const res = await run(new Request("http://127.0.0.1:9700/missing.js"));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
