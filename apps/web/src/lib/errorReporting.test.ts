import type { ErrorInfo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { restrictedDataCollection } from "@ocpp-cp-simulator/contracts/errorReporting";
import { REDACTED_VALUE } from "@ocpp-cp-simulator/contracts/redaction";
import { initErrorReporting, readErrorReportingConfig } from "./errorReporting";

const DSN = "https://public@o1.ingest.sentry.io/2";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A stand-in for `@sentry/react`, recording what the console asks of it. */
function fakeSentry() {
  const captured: unknown[] = [];
  const sentry = {
    init: vi.fn(),
    reactErrorHandler: vi.fn(
      (callback?: (error: unknown, info: ErrorInfo, id: string) => void) =>
        (error: unknown, info: ErrorInfo) => {
          captured.push(error);
          callback?.(error, info, "event-id");
        },
    ),
  };
  return { sentry, captured };
}

describe("readErrorReportingConfig", () => {
  it("is off when the build carries no VITE_SENTRY_DSN", () => {
    expect(readErrorReportingConfig({})).toBeNull();
    expect(readErrorReportingConfig({ VITE_SENTRY_DSN: " " })).toBeNull();
  });

  it("reads the DSN and environment the build baked in", () => {
    const config = readErrorReportingConfig({
      VITE_SENTRY_DSN: DSN,
      VITE_SENTRY_ENVIRONMENT: "pages",
    });
    expect(config).toMatchObject({ dsn: DSN, environment: "pages" });
    // The release is the console's own build version, never empty.
    expect(config?.release).toBeTruthy();
  });
});

describe("initErrorReporting", () => {
  it("never loads the SDK without a DSN", async () => {
    const load = vi.fn();
    await expect(initErrorReporting(null, load)).resolves.toEqual({});
    expect(load).not.toHaveBeenCalled();
  });

  it("initialises the SDK with data collection off, no tracing and a scrubber", async () => {
    const { sentry } = fakeSentry();
    await initErrorReporting(
      { dsn: DSN, release: "1.0.0", environment: "pages" },
      async () => sentry as never,
    );

    expect(sentry.init).toHaveBeenCalledTimes(1);
    const options = sentry.init.mock.calls[0]![0];
    expect(options).toMatchObject({
      dsn: DSN,
      release: "1.0.0",
      environment: "pages",
      dataCollection: restrictedDataCollection(),
    });
    expect(options).not.toHaveProperty("tracesSampleRate");
    expect(options).not.toHaveProperty("integrations");

    const event = options.beforeSend({
      message: "ws://cp:secret@csms.example/ocpp",
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(
      options.beforeBreadcrumb({ message: 'password="hunter2"' }).message,
    ).toContain(REDACTED_VALUE);
  });

  it("hands every React root error to Sentry and still logs it", async () => {
    const { sentry, captured } = fakeSentry();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const hooks = await initErrorReporting(
      { dsn: DSN, release: "1.0.0" },
      async () => sentry as never,
    );

    const info = { componentStack: "\n    at Broken" };
    const errors = [new Error("uncaught"), new Error("caught"), new Error("r")];
    hooks.onUncaughtError?.(errors[0], info);
    hooks.onCaughtError?.(errors[1], info);
    hooks.onRecoverableError?.(errors[2], info);

    expect(captured).toEqual(errors);
    expect(logged).toHaveBeenCalledTimes(3);
  });

  it("renders without reporting when the SDK chunk fails to load", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      initErrorReporting({ dsn: DSN, release: "1.0.0" }, () =>
        Promise.reject(new Error("chunk load failed")),
      ),
    ).resolves.toEqual({});
    expect(warned).toHaveBeenCalledTimes(1);
  });
});
