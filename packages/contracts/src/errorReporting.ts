import { isPlainObject, redactSensitiveValue } from "./redaction";

/**
 * Opt-in error reporting (#794), vendor-neutral. The CLI/daemon and the web
 * console each own the process- or page-level part (which errors are caught,
 * flushing before an exit, the React root hooks) and hand every error to an
 * {@link ErrorReporter}. An adapter (Sentry is the first built-in one)
 * implements that interface for one vendor and is loaded only when the
 * operator selects it: nothing is hard-coded, and without a selection no
 * vendor SDK is loaded at all. This module is the SDK-free contract both
 * apps and every adapter share.
 */

/** Where and how an error was caught. */
export interface ErrorReportContext {
  /** Where the error was caught: "fatal" | "unhandledRejection" | "uncaughtException" | "react.uncaught" | "react.caught" | "react.recoverable" */
  readonly mechanism: string;
  /** `false` when nothing in the app handled the error (it ends the process or the React root). */
  readonly handled: boolean;
  /** React's component stack, for the React root hooks. */
  readonly componentStack?: string;
}

/** One vendor's error sink, as the apps see it. */
export interface ErrorReporter {
  /** Never throws. */
  captureException(error: unknown, context: ErrorReportContext): void;
  /** Resolves true when everything queued was sent within the timeout. */
  flush(timeoutMs: number): Promise<boolean>;
}

/** What an app hands an adapter's {@link ErrorReporterFactory}. */
export interface ErrorReporterInit {
  /** The build's own version (`packages/contracts/src/buildVersion.ts`). */
  readonly release: string;
  /** Vendor settings come from the vendor's own variables (SENTRY_DSN, DD_*, ...). */
  readonly env: Readonly<Record<string, unknown>>;
  /** Adapters MUST run every outgoing event and breadcrumb through this (beforeSend or the SDK's equivalent). */
  readonly scrub: <T>(report: T) => T;
}

/** Resolves to null when the adapter is selected but not configured (e.g. no DSN). May reject; the caller treats that as "reporting off". */
export type ErrorReporterFactory = (
  init: ErrorReporterInit,
) => Promise<ErrorReporter | null>;

/**
 * The selected adapter (`OCPP_SIM_ERROR_REPORTER`, `VITE_ERROR_REPORTER`):
 * a built-in name or, on the CLI, a module specifier. `null` (reporting off)
 * unless it is a non-blank string.
 */
export function resolveErrorReporterName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name || null;
}

/** Headers that carry credentials, compared lower-cased. */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

/**
 * Drop every member named after a credential header, at any depth: the
 * request's headers, but also a header map logged into a breadcrumb's
 * `data.arguments`.
 */
function dropCredentialHeaders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropCredentialHeaders);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase()))
      .map(([name, nested]) => [name, dropCredentialHeaders(nested)]),
  );
}

/**
 * Replace a reference back to one of its own ancestors with `"[Circular]"`.
 * Sentry normalizes an event before `beforeSend`, but hands
 * `beforeBreadcrumb` the raw console arguments, which may be cyclic. Only
 * the current path counts, so an object shared by two siblings is kept (and
 * redacted) in both places.
 */
function breakCycles(value: unknown, ancestors = new Set<object>()): unknown {
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? value.map((item) => breakCycles(item, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([name, nested]) => [
          name,
          breakCycles(nested, ancestors),
        ]),
      );
  ancestors.delete(value);
  return copy;
}

/**
 * The scrubber every adapter receives as {@link ErrorReporterInit.scrub}.
 * Run an event or a breadcrumb through the redaction the trace and log
 * writers use (CSMS `user:pass@` URLs, bearer tokens, OCPP secrets such as
 * `AuthorizationKey`), then drop the request's cookies and every member
 * named after a credential header, which that redaction does not name.
 */
export function scrubErrorReport<T>(report: T): T {
  const scrubbed = dropCredentialHeaders(
    redactSensitiveValue(breakCycles(report)),
  );
  if (!isPlainObject(scrubbed) || !isPlainObject(scrubbed.request))
    return scrubbed as T;
  const { cookies: _cookies, ...request } = scrubbed.request;
  return { ...scrubbed, request } as T;
}
