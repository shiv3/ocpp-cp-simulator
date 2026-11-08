import {
  type ErrorReportingConfig,
  resolveErrorReportingConfig,
  restrictedDataCollection,
  scrubErrorReport,
} from "@ocpp-cp-simulator/contracts/errorReporting";
import { appVersion } from "./appVersion";

type SentryBun = typeof import("@sentry/bun");

/** How long a fatal exit waits for the report to leave. */
const FATAL_FLUSH_TIMEOUT_MS = 2000;

let active: SentryBun | null = null;

/**
 * `@sentry/bun` defaults that `initErrorReporting` drops or re-adds with
 * other options: the session ones and the unhandled-rejection handler.
 */
const REPLACED_DEFAULTS = new Set([
  "ProcessSession",
  "BunServer",
  "BunHttpServer",
  "Http",
  "OnUnhandledRejection",
]);

/**
 * Opt-in error reporting for the CLI and the daemon (#794): on only when
 * `SENTRY_DSN` is set, released as {@link appVersion}.
 */
export function readErrorReportingConfig(
  env: NodeJS.ProcessEnv = process.env,
): ErrorReportingConfig | null {
  return resolveErrorReportingConfig({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: appVersion(env),
  });
}

/**
 * Start Sentry when a DSN is configured. The SDK is imported lazily, so a run
 * without one never loads it. Errors only (no tracing, no session reports), PII off, every event
 * and breadcrumb scrubbed, and nothing written to stdout, which JSON Lines
 * mode owns. Resolves to whether reporting is on.
 */
export async function initErrorReporting(
  config: ErrorReportingConfig | null = readErrorReportingConfig(),
  load: () => Promise<SentryBun> = () => import("@sentry/bun"),
): Promise<boolean> {
  if (!config) return false;
  try {
    const Sentry = await load();
    Sentry.init({
      ...config,
      debug: false,
      dataCollection: restrictedDataCollection(),
      beforeSend: (event) => scrubErrorReport(event),
      beforeBreadcrumb: (breadcrumb) => scrubErrorReport(breadcrumb),
      integrations: (defaults) => [
        // Errors only: no process session, and no per-request session from
        // the HTTP servers (the daemon's `Bun.serve` listeners).
        ...defaults.filter(({ name }) => !REPLACED_DEFAULTS.has(name)),
        Sentry.bunServerIntegration({ sessions: false }),
        Sentry.bunHttpServerIntegration({ sessions: false }),
        Sentry.httpIntegration({ sessions: false }),
        // Without Sentry an unhandled rejection exits the process; the SDK's
        // default `warn` mode would keep it running.
        Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
      ],
    });
    active = Sentry;
    return true;
  } catch (err) {
    process.stderr.write(
      `Error reporting disabled: the Sentry SDK did not start (${err instanceof Error ? err.message : err})\n`,
    );
    return false;
  }
}

/**
 * Report an error the CLI is about to exit on, and wait for it to be sent:
 * `process.exit()` drops whatever is still queued. A no-op while reporting
 * is off.
 */
export async function reportFatalError(err: unknown): Promise<void> {
  if (!active) return;
  active.captureException(err);
  await active.flush(FATAL_FLUSH_TIMEOUT_MS);
}

export function resetErrorReportingForTests(): void {
  active = null;
}
