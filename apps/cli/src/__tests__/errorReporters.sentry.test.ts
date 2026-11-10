import { describe, expect, it, vi } from "vitest";

import { scrubErrorReport } from "@ocpp-cp-simulator/contracts/errorReporting";
import { REDACTED_VALUE } from "@ocpp-cp-simulator/contracts/redaction";
import { restrictedDataCollection } from "@ocpp-cp-simulator/contracts/sentryOptions";
import { createErrorReporter } from "../errorReporters/sentry";

const DSN = "https://public@o1.ingest.sentry.io/2";

/** A stand-in for `@sentry/bun`, recording what the adapter asks of it. */
function fakeSentry() {
  return {
    init: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn(async () => true),
    bunServerIntegration: vi.fn((options: unknown) => ({
      name: "BunServer",
      options,
    })),
    bunHttpServerIntegration: vi.fn((options: unknown) => ({
      name: "BunHttpServer",
      options,
    })),
    httpIntegration: vi.fn((options: unknown) => ({ name: "Http", options })),
  };
}

type Integration = { name: string; options?: unknown };

/**
 * The integrations the SDK ends up with for these `init` options, as
 * `getIntegrationsToSetup` in `@sentry/core` resolves them: an array
 * overrides the defaults of the same name, a function replaces them.
 */
function resolveIntegrations(
  options: { integrations?: unknown },
  defaults: Integration[],
): Integration[] {
  const { integrations } = options;
  if (typeof integrations === "function")
    return (integrations as (d: Integration[]) => Integration[])(defaults);
  const added = (integrations as Integration[] | undefined) ?? [];
  const overridden = new Set(added.map(({ name }) => name));
  return [...defaults.filter(({ name }) => !overridden.has(name)), ...added];
}

/** `@sentry/bun`'s defaults that matter here, as the SDK builds them. */
const BUN_DEFAULTS: Integration[] = [
  { name: "Console" },
  { name: "Http" },
  { name: "OnUncaughtException" },
  { name: "OnUnhandledRejection" },
  { name: "ProcessSession" },
  { name: "BunServer" },
  { name: "BunHttpServer" },
];

function init(env: Record<string, unknown>) {
  return { release: "1.0.0", env, scrub: scrubErrorReport };
}

async function started(
  env: Record<string, unknown> = { SENTRY_DSN: DSN },
  onBun = true,
) {
  const sentry = fakeSentry();
  const reporter = await createErrorReporter(
    init(env),
    async () => sentry as never,
    onBun,
  );
  return { sentry, reporter, options: sentry.init.mock.calls[0]?.[0] };
}

describe("Sentry adapter (CLI)", () => {
  it("resolves null and never loads the SDK without SENTRY_DSN", async () => {
    const load = vi.fn();
    await expect(createErrorReporter(init({}), load)).resolves.toBeNull();
    await expect(
      createErrorReporter(init({ SENTRY_DSN: " " }), load),
    ).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("initialises the SDK with data collection off, no tracing and the scrubber", async () => {
    const { options, reporter } = await started({
      SENTRY_DSN: DSN,
      SENTRY_ENVIRONMENT: "ci",
    });
    expect(reporter).not.toBeNull();
    expect(options).toMatchObject({
      dsn: DSN,
      release: "1.0.0",
      environment: "ci",
      dataCollection: restrictedDataCollection(),
    });
    expect(options).not.toHaveProperty("tracesSampleRate");
    // Never write to stdout: JSON Lines mode owns it.
    expect(options.debug).toBe(false);

    const event = options.beforeSend({
      exception: { values: [{ value: "ws://cp:secret@csms.example/ocpp" }] },
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(
      options.beforeBreadcrumb({ message: "Bearer tok-123" }).message,
    ).toContain(REDACTED_VALUE);
  });

  it("sends no session reports and leaves the global handlers to the core", async () => {
    const { options } = await started();
    const resolved = resolveIntegrations(options, BUN_DEFAULTS);
    // ProcessSession reports the process as a session; the HTTP servers
    // (the daemon's Bun.serve listeners) aggregate one per request. The
    // core reports, flushes and exits on unhandled rejections and uncaught
    // exceptions itself.
    expect(resolved.map(({ name }) => name).sort()).toEqual(
      ["BunHttpServer", "BunServer", "Console", "Http"].sort(),
    );
    for (const name of ["BunServer", "BunHttpServer", "Http"]) {
      expect(resolved.filter((i) => i.name === name)).toEqual([
        { name, options: { sessions: false } },
      ]);
    }
  });

  it("leaves the Bun integrations out on Node and says the runtime is Node (#916)", async () => {
    const { options, sentry } = await started({ SENTRY_DSN: DSN }, false);
    const resolved = resolveIntegrations(options, BUN_DEFAULTS);
    expect(resolved.map(({ name }) => name).sort()).toEqual(
      ["Console", "Http"].sort(),
    );
    expect(resolved.find((i) => i.name === "Http")).toEqual({
      name: "Http",
      options: { sessions: false },
    });
    expect(sentry.bunServerIntegration).not.toHaveBeenCalled();
    expect(options.runtime).toEqual({
      name: "node",
      version: process.versions.node,
    });
  });

  it("passes the mechanism to the SDK, and never throws", async () => {
    const { sentry, reporter } = await started();
    const err = new Error("x");

    reporter!.captureException(err, {
      mechanism: "unhandledRejection",
      handled: false,
    });
    expect(sentry.captureException).toHaveBeenCalledWith(err, {
      mechanism: { type: "unhandledRejection", handled: false },
      captureContext: { level: "fatal" },
    });

    sentry.captureException.mockImplementation(() => {
      throw new Error("sdk bug");
    });
    expect(() =>
      reporter!.captureException(err, { mechanism: "fatal", handled: false }),
    ).not.toThrow();

    await expect(reporter!.flush(2000)).resolves.toBe(true);
    expect(sentry.flush).toHaveBeenCalledWith(2000);
  });
});
