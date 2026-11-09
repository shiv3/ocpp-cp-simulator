import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

import {
  type ErrorReportContext,
  type ErrorReporter,
  resolveErrorReporterName,
  scrubErrorReport,
} from "@ocpp-cp-simulator/contracts/errorReporting";
import { appVersion } from "./appVersion";

/** How long a fatal exit waits for the report to leave. */
const FATAL_FLUSH_TIMEOUT_MS = 2000;

/**
 * The adapters shipped with the CLI, by the name `OCPP_SIM_ERROR_REPORTER`
 * selects them with. Each is a lazy import, so an unselected one (and its
 * vendor SDK) is never loaded. Any other value is a module specifier.
 */
export const BUILTIN_REPORTERS: Readonly<
  Record<string, () => Promise<unknown>>
> = {
  sentry: () => import("./errorReporters/sentry"),
};

/** Why a built-in adapter resolved to `null`, for the stderr line. */
const NOT_CONFIGURED: Readonly<Record<string, string>> = {
  sentry: "SENTRY_DSN is not set",
};

/** The part of `process` the core uses, injectable for tests. */
export interface ErrorReportingProcess {
  on(
    event: "unhandledRejection" | "uncaughtException",
    listener: (error: unknown) => void,
  ): unknown;
  exit(code: number): void;
  readonly stderr: { write(text: string): unknown };
}

export interface ErrorReportingDeps {
  /** Built-in adapters by name. */
  readonly builtins?: Readonly<Record<string, () => Promise<unknown>>>;
  /** Imports a module specifier that is not a built-in name. */
  readonly importModule?: (specifier: string) => Promise<unknown>;
  /** Base directory for a relative module specifier. */
  readonly cwd?: string;
  readonly process?: ErrorReportingProcess;
}

let active: ErrorReporter | null = null;
let fatalInProgress = false;

/**
 * A path (`./…`, `../…`, `/…`) resolved against `cwd`, imported by file URL;
 * anything else is a package name.
 */
function importSpecifier(specifier: string, cwd: string): Promise<unknown> {
  if (specifier.startsWith(".") || specifier.startsWith("/"))
    return import(pathToFileURL(path.resolve(cwd, specifier)).href);
  return import(specifier);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run a reporter call that should never throw, whatever adapter it is. */
function safeCapture(error: unknown, context: ErrorReportContext): void {
  try {
    active?.captureException(error, context);
  } catch {
    // A broken adapter must not change how the process fails.
  }
}

/**
 * Wait for the adapter's flush, but never past the core's own deadline: an
 * adapter whose flush ignores its timeout or never settles must not hold the
 * exit back.
 */
async function safeFlush(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FATAL_FLUSH_TIMEOUT_MS);
  });
  try {
    await Promise.race([active?.flush(FATAL_FLUSH_TIMEOUT_MS), deadline]);
  } catch {
    // Same: an exit goes ahead whatever the adapter does.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The error as the runtime would print it. A custom inspection hook may
 * throw: the report and the exit must still go ahead.
 */
function describeForStderr(error: unknown): string {
  try {
    return inspect(error);
  } catch {
    return "[error that cannot be inspected]";
  }
}

/**
 * While a reporter is active, the core takes over what the runtime does with
 * an unhandled rejection or an uncaught exception: report it, wait for the
 * report to leave (up to 2 s), print it to stderr as the runtime would and
 * exit with 1. Whichever adapter is plugged in, the process fails as it does
 * without one.
 */
function installProcessHandlers(proc: ErrorReportingProcess): void {
  const fail =
    (mechanism: "unhandledRejection" | "uncaughtException") =>
    (error: unknown): void => {
      proc.stderr.write(`${describeForStderr(error)}\n`);
      // A second failure while the first one is being flushed: printed, but
      // the exit is already on its way.
      if (fatalInProgress) return;
      fatalInProgress = true;
      safeCapture(error, { mechanism, handled: false });
      void safeFlush().finally(() => proc.exit(1));
    };
  proc.on("unhandledRejection", fail("unhandledRejection"));
  proc.on("uncaughtException", fail("uncaughtException"));
}

/**
 * Opt-in error reporting for the CLI and the daemon (#794), vendor-neutral.
 * `OCPP_SIM_ERROR_REPORTER` selects the adapter: a built-in name
 * ({@link BUILTIN_REPORTERS}) or a module specifier whose module exports
 * `createErrorReporter` (an `ErrorReporterFactory`). Unset or blank, nothing
 * is loaded and no process handler is installed. An adapter that cannot be
 * loaded or started leaves reporting off with one line on stderr, never
 * stdout (JSON Lines mode owns it). Resolves to whether reporting is on.
 */
export async function initErrorReporting(
  env: NodeJS.ProcessEnv = process.env,
  deps: ErrorReportingDeps = {},
): Promise<boolean> {
  const name = resolveErrorReporterName(env.OCPP_SIM_ERROR_REPORTER);
  if (!name) return false;
  const proc = deps.process ?? process;
  const builtins = deps.builtins ?? BUILTIN_REPORTERS;
  const disabled = (reason: string): false => {
    proc.stderr.write(`Error reporting disabled: ${reason}\n`);
    return false;
  };

  let loaded: unknown;
  try {
    const builtin = Object.hasOwn(builtins, name) ? builtins[name] : undefined;
    loaded = builtin
      ? await builtin()
      : await (deps.importModule
          ? deps.importModule(name)
          : importSpecifier(name, deps.cwd ?? process.cwd()));
  } catch (err) {
    return disabled(`cannot load ${name} (${errorMessage(err)})`);
  }

  const factory =
    loaded !== null && typeof loaded === "object"
      ? (loaded as { createErrorReporter?: unknown }).createErrorReporter
      : undefined;
  if (typeof factory !== "function")
    return disabled(`${name} does not export createErrorReporter`);

  let reporter: ErrorReporter | null;
  try {
    reporter = (await factory({
      release: appVersion(env),
      env,
      scrub: scrubErrorReport,
    })) as ErrorReporter | null;
  } catch (err) {
    return disabled(`${name} did not start (${errorMessage(err)})`);
  }
  if (!reporter)
    return disabled(
      `${name} selected but ${NOT_CONFIGURED[name] ?? "not configured"}`,
    );

  active = reporter;
  installProcessHandlers(proc);
  return true;
}

/**
 * Report an error the CLI is about to exit on, and wait for it to be sent:
 * `process.exit()` drops whatever is still queued. A no-op while reporting
 * is off.
 */
export async function reportFatalError(err: unknown): Promise<void> {
  if (!active) return;
  safeCapture(err, { mechanism: "fatal", handled: false });
  await safeFlush();
}

export function resetErrorReportingForTests(): void {
  active = null;
  fatalInProgress = false;
}
