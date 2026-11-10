import type {
  ErrorReporter,
  ErrorReporterFactory,
  ErrorReporterInit,
} from "@ocpp-cp-simulator/contracts/errorReporting";
import {
  resolveSentryConfig,
  restrictedDataCollection,
} from "@ocpp-cp-simulator/contracts/sentryOptions";
import { isBun } from "../runtime";

type SentryBun = typeof import("@sentry/bun");

/**
 * `@sentry/bun` defaults the adapter drops or re-adds with other options:
 * the session ones, and the global handlers the core owns
 * (`apps/cli/src/errorReporting.ts` reports, flushes and exits itself).
 */
const REPLACED_DEFAULTS = new Set([
  "ProcessSession",
  "BunServer",
  "BunHttpServer",
  "Http",
  "OnUncaughtException",
  "OnUnhandledRejection",
]);

/**
 * The built-in Sentry adapter for the CLI and the daemon (#794), selected
 * with `OCPP_SIM_ERROR_REPORTER=sentry`. Reads `SENTRY_DSN` (required) and
 * `SENTRY_ENVIRONMENT`; without a DSN it resolves `null` and the SDK is never
 * loaded. Errors only (no tracing, no session reports), data collection off,
 * every event and breadcrumb scrubbed, and nothing written to stdout, which
 * JSON Lines mode owns.
 */
export async function createErrorReporter(
  init: ErrorReporterInit,
  load: () => Promise<SentryBun> = () => import("@sentry/bun"),
  /**
   * Whether the CLI runs on Bun (#916). `@sentry/bun` is `@sentry/node` plus
   * two Bun integrations; on Node they are left out (`bunServerIntegration`
   * patches the `Bun` global and throws without it) and the event says Node.
   */
  onBun: boolean = isBun,
): Promise<ErrorReporter | null> {
  const config = resolveSentryConfig({
    dsn: init.env.SENTRY_DSN,
    environment: init.env.SENTRY_ENVIRONMENT,
    release: init.release,
  });
  if (!config) return null;
  const Sentry = await load();
  Sentry.init({
    ...config,
    debug: false,
    dataCollection: restrictedDataCollection(),
    beforeSend: (event) => init.scrub(event),
    beforeBreadcrumb: (breadcrumb) => init.scrub(breadcrumb),
    ...(onBun
      ? {}
      : { runtime: { name: "node", version: process.versions.node } }),
    integrations: (defaults) => [
      // Errors only: no process session, and no per-request session from
      // the HTTP servers (the daemon's listeners: `Bun.serve` on Bun,
      // `node:http` on Node). No global handlers either: the core owns
      // unhandled rejections and uncaught exceptions.
      ...defaults.filter(({ name }) => !REPLACED_DEFAULTS.has(name)),
      ...(onBun
        ? [
            Sentry.bunServerIntegration({ sessions: false }),
            Sentry.bunHttpServerIntegration({ sessions: false }),
          ]
        : []),
      Sentry.httpIntegration({ sessions: false }),
    ],
  });
  return {
    captureException(error, { mechanism, handled }) {
      try {
        Sentry.captureException(error, {
          mechanism: { type: mechanism, handled },
          captureContext: { level: handled ? "error" : "fatal" },
        });
      } catch {
        // The contract: never throws.
      }
    },
    flush: (timeoutMs) => Sentry.flush(timeoutMs),
  };
}

createErrorReporter satisfies ErrorReporterFactory;
