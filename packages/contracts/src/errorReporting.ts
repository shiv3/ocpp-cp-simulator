import { isPlainObject, redactSensitiveValue } from "./redaction";

/**
 * Opt-in error reporting (#794). The web console and the CLI/daemon each wire
 * a Sentry SDK, but only when the operator supplies a DSN: nothing is ever
 * hard-coded, and without one the SDK is not even loaded. These helpers are
 * the SDK-free part both apps share.
 */
export interface ErrorReportingConfig {
  readonly dsn: string;
  readonly release: string;
  readonly environment?: string;
}

/** `null` (reporting off) unless `dsn` is a non-blank string. */
export function resolveErrorReportingConfig(input: {
  dsn: unknown;
  environment: unknown;
  release: string;
}): ErrorReportingConfig | null {
  const dsn = typeof input.dsn === "string" ? input.dsn.trim() : "";
  if (!dsn) return null;
  const environment =
    typeof input.environment === "string" ? input.environment.trim() : "";
  return environment
    ? { dsn, release: input.release, environment }
    : { dsn, release: input.release };
}

/**
 * The Sentry SDK's `dataCollection` option (v11, which replaced
 * `sendDefaultPii`) with every optional category off: its defaults collect
 * user fields, cookies, HTTP headers and bodies, query strings and local
 * variables. Plain data, so this package stays free of the SDK.
 */
export function restrictedDataCollection() {
  return {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [] as never[],
    urlQueryParams: false,
    stackFrameVariables: false,
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    mcp: { inputs: false, outputs: false },
  };
}

/** Request headers that carry credentials, compared lower-cased. */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

/**
 * Run an event or a breadcrumb through the redaction the trace and log
 * writers use (CSMS `user:pass@` URLs, bearer tokens, OCPP secrets such as
 * `AuthorizationKey`), then drop the request's cookies and credential
 * headers, which that redaction does not name.
 */
export function scrubErrorReport<T>(report: T): T {
  const scrubbed = redactSensitiveValue(report);
  if (!isPlainObject(scrubbed) || !isPlainObject(scrubbed.request))
    return scrubbed as T;
  const { cookies: _cookies, ...request } = scrubbed.request;
  if (isPlainObject(request.headers)) {
    request.headers = Object.fromEntries(
      Object.entries(request.headers).filter(
        ([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase()),
      ),
    );
  }
  return { ...scrubbed, request } as T;
}
