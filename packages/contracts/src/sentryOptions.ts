/**
 * The SDK-free part of the built-in Sentry adapters (#794): the CLI/daemon's
 * `@sentry/bun` one and the console's `@sentry/react` one. Plain data, so this
 * package stays free of the SDK.
 */
export interface SentryConfig {
  readonly dsn: string;
  readonly release: string;
  readonly environment?: string;
}

/** `null` (Sentry selected but not configured) unless `dsn` is a non-blank string. */
export function resolveSentryConfig(input: {
  dsn: unknown;
  environment: unknown;
  release: string;
}): SentryConfig | null {
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
 * variables.
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
