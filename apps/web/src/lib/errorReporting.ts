import type { RootOptions } from "react-dom/client";

import { resolveBuildVersion } from "@ocpp-cp-simulator/contracts/buildVersion";
import {
  type ErrorReporter,
  type ErrorReporterFactory,
  resolveErrorReporterName,
  scrubErrorReport,
} from "@ocpp-cp-simulator/contracts/errorReporting";

export type RootErrorHooks = Pick<
  RootOptions,
  "onUncaughtError" | "onCaughtError" | "onRecoverableError"
>;

type ReporterModule = { createErrorReporter: ErrorReporterFactory };

/**
 * How long the first paint waits for a selected adapter (#794). Past it the
 * console renders and the adapter keeps loading in the background.
 */
export const ERROR_REPORTER_WAIT_MS = 300;

/** How many errors raised while the adapter loads are kept for it. */
export const ERROR_REPORTER_BUFFER_SIZE = 20;

/**
 * The console's adapters, by the name `VITE_ERROR_REPORTER` selects them
 * with. Each is a lazy chunk, so the default build (no selector) never
 * downloads a vendor SDK. The console cannot load an arbitrary module: a new
 * adapter is added here (and under `errorReporters/`).
 */
export const BUILTIN_REPORTERS: Readonly<
  Record<string, () => Promise<ReporterModule>>
> = {
  sentry: () => import("./errorReporters/sentry"),
};

/** Why a built-in adapter resolved to `null`, for the warning. */
const NOT_CONFIGURED: Readonly<Record<string, string>> = {
  sentry: "VITE_SENTRY_DSN is not set",
};

/** The console's own build version, as the release. */
function consoleRelease(): string {
  return resolveBuildVersion({
    packageVersion: __APP_VERSION__,
    commit: __APP_COMMIT__,
  });
}

/**
 * The `createRoot` error hooks that hand every React root error to the
 * reporter. Taking these hooks over replaces React's default logging, so
 * they log too.
 */
export function rootErrorHooks(reporter: ErrorReporter): RootErrorHooks {
  const capture = (
    error: unknown,
    mechanism: string,
    handled: boolean,
    componentStack: string | null | undefined,
  ) => {
    try {
      reporter.captureException(
        error,
        componentStack
          ? { mechanism, handled, componentStack }
          : { mechanism, handled },
      );
    } catch {
      // A broken adapter must not take the console down with it.
    }
  };
  return {
    onUncaughtError: (error, errorInfo) => {
      capture(error, "react.uncaught", false, errorInfo.componentStack);
      console.error(error);
    },
    onCaughtError: (error, errorInfo) => {
      capture(error, "react.caught", true, errorInfo.componentStack);
      console.error(error, errorInfo.componentStack);
    },
    onRecoverableError: (error, errorInfo) => {
      capture(error, "react.recoverable", true, errorInfo.componentStack);
      console.error(error);
    },
  };
}

/**
 * Opt-in error reporting for the console (#794), vendor-neutral. Vite bakes
 * `VITE_ERROR_REPORTER` (and the adapter's own variables, such as
 * `VITE_SENTRY_DSN`) into the bundle at build time: variables given to the
 * daemon at run time do not reach the console it serves. Without a selector
 * the console reports nothing and loads no adapter.
 *
 * Never rejects: an unknown name, or an adapter that fails to load or start,
 * leaves reporting off with one warning rather than the console blank.
 * Resolves to the `createRoot` error hooks ({} while reporting is off), at
 * the latest after `ERROR_REPORTER_WAIT_MS`: an optional adapter must not
 * keep the first paint blank. Past the bound the hooks log at once and hand
 * errors to the adapter once it has loaded, the first
 * `ERROR_REPORTER_BUFFER_SIZE` raised meanwhile included.
 */
export async function initErrorReporting(
  env: Record<string, unknown> = import.meta.env,
  builtins: Readonly<
    Record<string, () => Promise<ReporterModule>>
  > = BUILTIN_REPORTERS,
): Promise<RootErrorHooks> {
  const name = resolveErrorReporterName(env.VITE_ERROR_REPORTER);
  if (!name) return {};
  const load = Object.hasOwn(builtins, name) ? builtins[name] : undefined;
  if (!load) {
    console.warn(
      `Error reporting disabled: unknown error reporter "${name}" (built in: ${Object.keys(builtins).join(", ")})`,
    );
    return {};
  }
  const started = startReporter(name, load, env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ERROR_REPORTER_WAIT_MS);
  });
  const first = await Promise.race([started, bound]);
  clearTimeout(timer);
  if (first === "timeout") return rootErrorHooks(lateReporter(started));
  return first ? rootErrorHooks(first) : {};
}

/**
 * A reporter that keeps the first errors until the adapter has loaded, hands
 * them over then, and forwards directly from there on. If the adapter never
 * starts, the kept errors are dropped (they were logged when raised).
 */
function lateReporter(started: Promise<ErrorReporter | null>): ErrorReporter {
  let ready: ErrorReporter | null | undefined;
  let pending: Parameters<ErrorReporter["captureException"]>[] = [];
  void started.then((reporter) => {
    ready = reporter;
    const kept = pending;
    pending = [];
    if (!reporter) return;
    for (const args of kept) {
      try {
        reporter.captureException(...args);
      } catch {
        // A broken adapter must not take the console down with it.
      }
    }
  });
  return {
    captureException: (...args) => {
      if (ready) ready.captureException(...args);
      else if (
        ready === undefined &&
        pending.length < ERROR_REPORTER_BUFFER_SIZE
      )
        pending.push(args);
    },
    flush: (timeoutMs) =>
      ready ? ready.flush(timeoutMs) : Promise.resolve(false),
  };
}

/**
 * Loads and starts the named adapter. Never rejects: resolves to `null`,
 * with one warning, when reporting stays off.
 */
async function startReporter(
  name: string,
  load: () => Promise<ReporterModule>,
  env: Record<string, unknown>,
): Promise<ErrorReporter | null> {
  let reporter: ErrorReporter | null;
  try {
    const { createErrorReporter } = await load();
    reporter = await createErrorReporter({
      release: consoleRelease(),
      env,
      scrub: scrubErrorReport,
    });
  } catch (err) {
    console.warn(`Error reporting disabled: ${name} did not start`, err);
    return null;
  }
  if (!reporter) {
    console.warn(
      `Error reporting disabled: ${name} selected but ${NOT_CONFIGURED[name] ?? "not configured"}`,
    );
    return null;
  }
  return reporter;
}
