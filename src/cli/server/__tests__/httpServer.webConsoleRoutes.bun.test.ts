import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createHttpHandlers } from "../httpServer";
import { createLifecycle } from "../lifecycle";

/**
 * `--web-console` serves the browser app's routes from one `index.html`
 * (the client router picks the page), while `/v1/...` stays the daemon's
 * own namespace. #411 moved the web console to `/`, kept the classic UI
 * under `/v2` and turned `/v3/...` into client-side redirects: each of those
 * must reach the app on a hard load (bookmark, reload, deep link).
 */
const tempDirs: string[] = [];
type FetchServer = Parameters<
  ReturnType<typeof createHttpHandlers>["fetch"]
>[1];
const stubServer = null as unknown as FetchServer;
const INDEX = "<!doctype html><p>web console</p>";

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("web console routes on the daemon (#411)", () => {
  it.each([
    "/",
    "/cp/CP-1",
    "/scenarios?cp=CP-1",
    "/scenarios/edit?cp=CP-1&connector=1&id=s1",
    "/scenarios/run?cp=CP-1&connector=1&id=s1&run=r-1",
    "/scenarios/runs",
    "/logs",
    "/settings",
    "/v3",
    "/v3/scenarios/run?cp=CP-1&connector=1&id=s1",
    "/v2",
    "/v2/settings",
  ])("%s serves the app", async (path) => {
    const handlers = makeHandlers({ staticDir: await makeStaticDir() });

    const res = await run(handlers, "GET", path);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
  });

  it("keeps /v1 as the daemon's namespace: health endpoint, 404 elsewhere", async () => {
    const handlers = makeHandlers({ staticDir: await makeStaticDir() });

    const health = await run(handlers, "GET", "/v1/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    for (const path of ["/v1", "/v1/settings", "/v1/cp"]) {
      expect((await run(handlers, "GET", path)).status).toBe(404);
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
  await writeFile(join(staticDir, "index.html"), INDEX);
  return staticDir;
}
