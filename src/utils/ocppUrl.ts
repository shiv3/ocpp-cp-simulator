/**
 * Bidirectional helpers between the "Full WebSocket URL" Settings field and
 * the per-CP form fields (wsURL + basic auth username/password).
 *
 * Pasting a `wss://user:pass@host/path` URL splits the basic auth out of the
 * URL and back into the dedicated form fields. Rendering the field goes the
 * other way: when basic auth is enabled, the username/password are embedded
 * back into the URL's userinfo so the displayed URL is a complete, ready-to-
 * paste connection string.
 */

export interface OcppUrlBasicAuth {
  enabled: boolean;
  username: string;
  password: string;
}

export interface ParsedOcppUrl {
  wsURL: string;
  basicAuthEnabled: boolean;
  basicAuthUsername: string;
  basicAuthPassword: string;
}

const VALID_PROTOCOLS = new Set(["ws:", "wss:"]);

/** Compose the displayed full URL from the form fields. */
export function buildFullOcppUrl(
  wsURL: string,
  basicAuth: OcppUrlBasicAuth,
): string {
  const base = wsURL.trim();
  if (!base) return "";

  try {
    const url = new URL(base);
    if (basicAuth.enabled && (basicAuth.username || basicAuth.password)) {
      url.username = encodeURIComponent(basicAuth.username);
      url.password = encodeURIComponent(basicAuth.password);
    } else {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    // Not a parseable URL yet — show the raw text so the user can keep typing.
    return base;
  }
}

/**
 * Split a pasted/typed full URL back into the form fields. Returns `null`
 * when the input isn't a syntactically valid ws://wss:// URL.
 */
export function parseFullOcppUrl(fullUrl: string): ParsedOcppUrl | null {
  const trimmed = fullUrl.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!VALID_PROTOCOLS.has(url.protocol)) return null;

  const username = url.username ? decodeURIComponent(url.username) : "";
  const password = url.password ? decodeURIComponent(url.password) : "";
  url.username = "";
  url.password = "";

  return {
    wsURL: url.toString(),
    basicAuthEnabled: !!(username || password),
    basicAuthUsername: username,
    basicAuthPassword: password,
  };
}
