import { describe, expect, it, vi } from "vitest";

import { scrubErrorReport } from "@ocpp-cp-simulator/contracts/errorReporting";
import { REDACTED_VALUE } from "@ocpp-cp-simulator/contracts/redaction";
import { restrictedDataCollection } from "@ocpp-cp-simulator/contracts/sentryOptions";
import { createErrorReporter } from "./sentry";

const DSN = "https://public@o1.ingest.sentry.io/2";

/** A stand-in for `@sentry/react`, recording what the adapter asks of it. */
function fakeSentry() {
  return {
    init: vi.fn(),
    captureException: vi.fn(),
    captureReactException: vi.fn(),
    flush: vi.fn(async () => true),
  };
}

type Integration = { name: string };

/**
 * The integration names the SDK ends up with for these `init` options, as
 * `getIntegrationsToSetup` in `@sentry/core` resolves them: an array is
 * added to the defaults, a function replaces them.
 */
function resolveIntegrations(
  options: { integrations?: unknown },
  defaults: Integration[],
): string[] {
  const { integrations } = options;
  const resolved =
    typeof integrations === "function"
      ? (integrations as (d: Integration[]) => Integration[])(defaults)
      : [...defaults, ...((integrations as Integration[] | undefined) ?? [])];
  return resolved.map((integration) => integration.name);
}

function init(env: Record<string, unknown>) {
  return { release: "1.0.0", env, scrub: scrubErrorReport };
}

async function started(
  env: Record<string, unknown> = { VITE_SENTRY_DSN: DSN },
) {
  const sentry = fakeSentry();
  const reporter = await createErrorReporter(
    init(env),
    async () => sentry as never,
  );
  return { sentry, reporter, options: sentry.init.mock.calls[0]?.[0] };
}

describe("Sentry adapter (console)", () => {
  it("resolves null and never loads the SDK without VITE_SENTRY_DSN", async () => {
    const load = vi.fn();
    await expect(createErrorReporter(init({}), load)).resolves.toBeNull();
    await expect(
      createErrorReporter(init({ VITE_SENTRY_DSN: " " }), load),
    ).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("initialises the SDK with data collection off, no tracing and the scrubber", async () => {
    const { options } = await started({
      VITE_SENTRY_DSN: DSN,
      VITE_SENTRY_ENVIRONMENT: "pages",
    });
    expect(options).toMatchObject({
      dsn: DSN,
      release: "1.0.0",
      environment: "pages",
      dataCollection: restrictedDataCollection(),
    });
    expect(options).not.toHaveProperty("tracesSampleRate");

    const event = options.beforeSend({
      message: "ws://cp:secret@csms.example/ocpp",
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(
      options.beforeBreadcrumb({ message: 'password="hunter2"' }).message,
    ).toContain(REDACTED_VALUE);
  });

  it("sends no session reports and keeps the passive browser handlers", async () => {
    const { options } = await started();
    // `@sentry/react` defaults include BrowserSession, which reports a
    // session on every page load even when nothing fails.
    const defaults = [{ name: "BrowserSession" }, { name: "GlobalHandlers" }];
    expect(resolveIntegrations(options, defaults)).toEqual(["GlobalHandlers"]);
  });

  it("links the component stack as Sentry's reactErrorHandler does", async () => {
    const { sentry, reporter } = await started();
    const err = new Error("caught");
    const componentStack = "\n    at Broken";

    reporter!.captureException(err, {
      mechanism: "react.caught",
      handled: true,
      componentStack,
    });

    expect(sentry.captureReactException).toHaveBeenCalledWith(
      err,
      { componentStack },
      {
        mechanism: { type: "react.caught", handled: true },
        captureContext: { contexts: { react: { componentStack } } },
      },
    );
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures without a component stack, never throws, and flushes", async () => {
    const { sentry, reporter } = await started();
    const err = new Error("x");

    reporter!.captureException(err, { mechanism: "fatal", handled: false });
    expect(sentry.captureException).toHaveBeenCalledWith(err, {
      mechanism: { type: "fatal", handled: false },
    });

    sentry.captureException.mockImplementation(() => {
      throw new Error("sdk bug");
    });
    expect(() =>
      reporter!.captureException(err, { mechanism: "x", handled: true }),
    ).not.toThrow();

    await expect(reporter!.flush(500)).resolves.toBe(true);
    expect(sentry.flush).toHaveBeenCalledWith(500);
  });
});
