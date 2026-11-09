import type { RootOptions } from "react-dom/client";

import { resolveBuildVersion } from "@ocpp-cp-simulator/contracts/buildVersion";
import { scrubErrorReport } from "@ocpp-cp-simulator/contracts/errorReporting";
import {
  type SentryConfig as ErrorReportingConfig,
  resolveSentryConfig as resolveErrorReportingConfig,
  restrictedDataCollection,
} from "@ocpp-cp-simulator/contracts/sentryOptions";

type SentryReact = typeof import("@sentry/react");

export type RootErrorHooks = Pick<
  RootOptions,
  "onUncaughtError" | "onCaughtError" | "onRecoverableError"
>;

/**
 * Opt-in error reporting for the console (#794). Vite bakes
 * `VITE_SENTRY_DSN` into the bundle at build time: a `SENTRY_DSN` given to the
 * daemon at runtime does not reach the console it serves. Without it the
 * console reports nothing.
 */
export function readErrorReportingConfig(
  env: Record<string, unknown> = import.meta.env,
): ErrorReportingConfig | null {
  return resolveErrorReportingConfig({
    dsn: env.VITE_SENTRY_DSN,
    environment: env.VITE_SENTRY_ENVIRONMENT,
    release: resolveBuildVersion({
      packageVersion: __APP_VERSION__,
      commit: __APP_COMMIT__,
    }),
  });
}

/**
 * Start Sentry when a DSN is configured and return the `createRoot` error
 * hooks that feed it. The SDK is a lazy chunk, so the default (no DSN) build
 * never downloads it; an SDK that fails to load or start leaves reporting off
 * rather than the console blank, so this never rejects. Errors only: no
 * tracing, no session replay, no session reports.
 */
export async function initErrorReporting(
  config: ErrorReportingConfig | null = readErrorReportingConfig(),
  load: () => Promise<SentryReact> = () => import("@sentry/react"),
): Promise<RootErrorHooks> {
  if (!config) return {};
  let Sentry: SentryReact;
  try {
    Sentry = await load();
    Sentry.init({
      ...config,
      dataCollection: restrictedDataCollection(),
      beforeSend: (event) => scrubErrorReport(event),
      beforeBreadcrumb: (breadcrumb) => scrubErrorReport(breadcrumb),
      // Errors only: BrowserSession would report a session on every page load.
      integrations: (defaults) =>
        defaults.filter(({ name }) => name !== "BrowserSession"),
    });
  } catch (err) {
    console.warn("Error reporting disabled: the Sentry SDK did not start", err);
    return {};
  }
  // Taking these hooks over replaces React's default logging, so log too.
  const capture = Sentry.reactErrorHandler();
  return {
    onUncaughtError: (error, errorInfo) => {
      capture(error, errorInfo);
      console.error(error);
    },
    onCaughtError: Sentry.reactErrorHandler((error, errorInfo) =>
      console.error(error, errorInfo.componentStack),
    ),
    onRecoverableError: Sentry.reactErrorHandler((error) =>
      console.error(error),
    ),
  };
}
