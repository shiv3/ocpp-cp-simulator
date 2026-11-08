import { afterEach, describe, expect, it, vi } from "vitest";

import { restrictedDataCollection } from "@ocpp-cp-simulator/contracts/errorReporting";
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
  };
}

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
    expect(sentry.onUnhandledRejectionIntegration).toHaveBeenCalledWith({
      mode: "strict",
    });
    expect(sentry.init.mock.calls[0]![0].integrations).toEqual([
      { name: "OnUnhandledRejection", options: { mode: "strict" } },
    ]);
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
