import type {
  ErrorReporter,
  ErrorReporterFactory,
  ErrorReporterInit,
} from "@ocpp-cp-simulator/contracts/errorReporting";
import {
  resolveSentryConfig,
  restrictedDataCollection,
} from "@ocpp-cp-simulator/contracts/sentryOptions";

type SentryReact = typeof import("@sentry/react");

/**
 * The console's built-in Sentry adapter (#794), selected with
 * `VITE_ERROR_REPORTER=sentry` at build time. Reads `VITE_SENTRY_DSN`
 * (required) and `VITE_SENTRY_ENVIRONMENT`; without a DSN it resolves `null`
 * and the SDK chunk is never downloaded. Errors only: no tracing, no session
 * replay, no session reports. The SDK keeps its passive browser handlers
 * (`GlobalHandlers`: `window.onerror`, `unhandledrejection`); the React root
 * hooks come from the core (`apps/web/src/lib/errorReporting.ts`).
 */
export async function createErrorReporter(
  init: ErrorReporterInit,
  load: () => Promise<SentryReact> = () => import("@sentry/react"),
): Promise<ErrorReporter | null> {
  const config = resolveSentryConfig({
    dsn: init.env.VITE_SENTRY_DSN,
    environment: init.env.VITE_SENTRY_ENVIRONMENT,
    release: init.release,
  });
  if (!config) return null;
  const Sentry = await load();
  Sentry.init({
    ...config,
    dataCollection: restrictedDataCollection(),
    beforeSend: (event) => init.scrub(event),
    beforeBreadcrumb: (breadcrumb) => init.scrub(breadcrumb),
    // Errors only: BrowserSession would report a session on every page load.
    integrations: (defaults) =>
      defaults.filter(({ name }) => name !== "BrowserSession"),
  });
  return {
    captureException(error, { mechanism, handled, componentStack }) {
      const hint = { mechanism: { type: mechanism, handled } };
      try {
        if (componentStack)
          // As Sentry's own `reactErrorHandler` does: the component stack
          // becomes a linked "React ErrorBoundary" error, and is kept as a
          // `react` context too.
          Sentry.captureReactException(
            error,
            { componentStack },
            {
              ...hint,
              captureContext: { contexts: { react: { componentStack } } },
            },
          );
        else Sentry.captureException(error, hint);
      } catch {
        // The contract: never throws.
      }
    },
    flush: (timeoutMs) => Sentry.flush(timeoutMs),
  };
}

createErrorReporter satisfies ErrorReporterFactory;
