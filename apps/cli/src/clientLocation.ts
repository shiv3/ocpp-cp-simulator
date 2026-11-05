import type { ClientLocation } from "./client";
import { DEFAULT_HTTP_PORT } from "./server/constants";

type BasicAuth = { username: string; password: string };

export interface ClientLocationOptions {
  /** Canonical client target / credentials. */
  httpUrl: string | null;
  httpBasicAuth: BasicAuth | null;
  /** Server-side listen flags, accepted as a deprecated client target. */
  httpHost: string;
  httpPort: number | null;
  /** Outgoing-WS credentials, accepted as deprecated client credentials. */
  basicAuth: BasicAuth | null;
}

/**
 * Resolve the target + credentials for client modes (--send / --stop /
 * --events). The canonical flags are `--http-url` and `--http-basic-auth-*`.
 *
 * For backward compatibility we still honor the server-side
 * `--http-host`/`--http-port` (as the TCP target) and the outgoing-WS
 * `--basic-auth-*` (as the client credentials) when the canonical flags are
 * absent — these are the flags people reach for intuitively — but return a
 * deprecation warning so the caller can nudge them to the right ones.
 */
export function resolveClientLocation(options: ClientLocationOptions): {
  location: ClientLocation;
  warnings: string[];
} {
  const warnings: string[] = [];
  let httpUrl = options.httpUrl;
  let basicAuth = options.httpBasicAuth;

  if (!httpUrl && options.httpPort != null) {
    const host = options.httpHost || "127.0.0.1";
    httpUrl = `http://${host}:${options.httpPort}`;
    warnings.push(
      `deprecated: derived client target ${httpUrl} from --http-port/--http-host; ` +
        "use --http-url <url> for client modes (--send/--stop/--events).",
    );
  }
  if (!httpUrl) {
    httpUrl = `http://127.0.0.1:${DEFAULT_HTTP_PORT}`;
  }

  if (!basicAuth && options.basicAuth) {
    basicAuth = options.basicAuth;
    warnings.push(
      "deprecated: using --basic-auth-user/--basic-auth-pass as the client " +
        "credentials; use --http-basic-auth-user/--http-basic-auth-pass for " +
        "client modes.",
    );
  }

  return {
    location: { httpUrl, basicAuth },
    warnings,
  };
}
