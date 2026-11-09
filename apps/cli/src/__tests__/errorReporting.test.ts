import { afterEach, describe, expect, it, vi } from "vitest";

import { restrictedDataCollection } from "@ocpp-cp-simulator/contracts/sentryOptions";
import { REDACTED_VALUE } from "@ocpp-cp-simulator/contracts/redaction";
import {
  initErrorReporting,
  readErrorReportingConfig,
  reportFatalError,
  resetErrorReportingForTests,
} from "../errorReporting";

const DSN = "https://public@o1.ingest.sentry.io/2";

afterEach(() => {
  resetErrorReportingForTests();
});

/** A stand-in for `@sentry/bun`, recording what the CLI asks of it. */
function fakeSentry() {
  return {
    init: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn(async () => true),
    onUnhandledRejectionIntegration: vi.fn((options: unknown) => ({
      name: "OnUnhandledRejection",
      options,
    })),
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

describe("readErrorReportingConfig", () => {
  it("is off without SENTRY_DSN", () => {
    expect(readErrorReportingConfig({})).toBeNull();
    expect(readErrorReportingConfig({ SENTRY_DSN: "" })).toBeNull();
  });

  it("reads SENTRY_DSN and SENTRY_ENVIRONMENT, released as appVersion()", () => {
    const config = readErrorReportingConfig({
      SENTRY_DSN: DSN,
      SENTRY_ENVIRONMENT: "ci",
      APP_VERSION: "9.9.9",
    });
    expect(config).toEqual({ dsn: DSN, environment: "ci", release: "9.9.9" });
  });
});

describe("initErrorReporting", () => {
  it("never loads the SDK without a DSN", async () => {
    const load = vi.fn();
    await expect(initErrorReporting(null, load)).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("initialises the SDK with data collection off, no tracing and a scrubber", async () => {
    const sentry = fakeSentry();
    await expect(
      initErrorReporting(
        { dsn: DSN, release: "1.0.0" },
        async () => sentry as never,
      ),
    ).resolves.toBe(true);

    const options = sentry.init.mock.calls[0]![0];
    expect(options).toMatchObject({
      dsn: DSN,
      release: "1.0.0",
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

  it("keeps the exit-on-unhandled-rejection the CLI has without Sentry", async () => {
    const sentry = fakeSentry();
    await initErrorReporting(
      { dsn: DSN, release: "1.0.0" },
      async () => sentry as never,
    );

    // The SDK's default `warn` mode would keep a broken process running.
    expect(
      resolveIntegrations(sentry.init.mock.calls[0]![0], BUN_DEFAULTS).filter(
        ({ name }) => name === "OnUnhandledRejection",
      ),
    ).toEqual([{ name: "OnUnhandledRejection", options: { mode: "strict" } }]);
    expect(sentry.onUnhandledRejectionIntegration).toHaveBeenCalledWith({
      mode: "strict",
    });
  });

  it("sends no session reports (errors only)", async () => {
    const sentry = fakeSentry();
    await initErrorReporting(
      { dsn: DSN, release: "1.0.0" },
      async () => sentry as never,
    );

    const resolved = resolveIntegrations(
      sentry.init.mock.calls[0]![0],
      BUN_DEFAULTS,
    );
    // ProcessSession reports the process as a session; the HTTP servers
    // (the daemon's Bun.serve listeners) aggregate one per request.
    expect(resolved.map(({ name }) => name).sort()).toEqual(
      BUN_DEFAULTS.map(({ name }) => name)
        .filter((name) => name !== "ProcessSession")
        .sort(),
    );
    for (const name of ["BunServer", "BunHttpServer", "Http"]) {
      expect(resolved.filter((i) => i.name === name)).toEqual([
        { name, options: { sessions: false } },
      ]);
    }
  });

  it("starts without reporting when the SDK fails to load", async () => {
    const warned = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(
      initErrorReporting({ dsn: DSN, release: "1.0.0" }, () =>
        Promise.reject(new Error("missing module")),
      ),
    ).resolves.toBe(false);
    expect(warned).toHaveBeenCalledTimes(1);
    warned.mockRestore();
  });

  it("starts without reporting when the SDK fails to start", async () => {
    const warned = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const sentry = fakeSentry();
    sentry.init.mockImplementation(() => {
      throw new Error("bad options");
    });
    await expect(
      initErrorReporting(
        { dsn: DSN, release: "1.0.0" },
        async () => sentry as never,
      ),
    ).resolves.toBe(false);
    expect(warned).toHaveBeenCalledTimes(1);
    warned.mockRestore();

    // Off means off: a later fatal exit does not reach the half-started SDK.
    await reportFatalError(new Error("x"));
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("reportFatalError", () => {
  it("does nothing while reporting is off", async () => {
    await expect(reportFatalError(new Error("x"))).resolves.toBeUndefined();
  });

  it("captures the error and flushes before the caller exits", async () => {
    const sentry = fakeSentry();
    await initErrorReporting(
      { dsn: DSN, release: "1.0.0" },
      async () => sentry as never,
    );
    const err = new Error("fatal");

    await reportFatalError(err);

    expect(sentry.captureException).toHaveBeenCalledWith(err);
    expect(sentry.flush).toHaveBeenCalledTimes(1);
    expect(sentry.flush.mock.invocationCallOrder[0]!).toBeGreaterThan(
      sentry.captureException.mock.invocationCallOrder[0]!,
    );
  });
});
