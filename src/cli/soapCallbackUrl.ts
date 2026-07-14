/**
 * SOAP ChargePointService callback-URL resolution (issue #183).
 *
 * SOAP-based OCPP (1.2 / 1.5 / 1.6S) requires the charge point to advertise a
 * callback endpoint — the `wsa:From` address the CSMS calls back on:
 *
 *     {publicBase}{soapPath}/{cpId}/ChargePointService
 *
 * The effective URL is resolved by precedence, so the explicit flag always wins
 * and additional providers can be layered underneath without touching callers:
 *
 *   1. explicit  --soap-callback-url <url>       → used verbatim
 *   2.           --soap-public-base-url <base>   → derived from the base origin
 *   3. (future)  --soap-tunnel ngrok             → provider yields a base, then (2)
 *   4. none                                       → null (caller: local-only / error)
 *
 * Only steps 1–2 are implemented here. A tunnel provider (ngrok, Cloudflare
 * Tunnel, …) is intentionally out of scope: it will resolve to a public base
 * URL and then reuse buildSoapCallbackUrl(), keeping this precedence intact.
 */

const SOAP_SERVICE_SUFFIX = "ChargePointService";

export interface SoapCallbackUrlInput {
  /** --soap-callback-url: the full callback URL, used verbatim when present. */
  readonly explicitCallbackUrl?: string | null;
  /** --soap-public-base-url: public origin, optionally with a path prefix. */
  readonly publicBaseUrl?: string | null;
  /**
   * Charge-point id that identifies the callback route segment. May be null in
   * daemon-only mode, in which case no URL is derived from the public base.
   */
  readonly cpId: string | null;
  /** Base path reserved for the SOAP callback server, e.g. "/ocpp/soap". */
  readonly soapPath: string;
}

/** True when `value` parses as an absolute http(s) URL. */
export function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * Build the full SOAP callback URL a CP advertises, given a public base URL.
 * `publicBaseUrl` is an absolute http(s) URL (origin, optionally with a path
 * prefix); a trailing slash is tolerated. The cpId is percent-encoded so the
 * server's `decodeURIComponent(segment) === cpId` route match holds. Throws if
 * `publicBaseUrl` is not a valid http(s) URL.
 */
export function buildSoapCallbackUrl(
  publicBaseUrl: string,
  cpId: string,
  soapPath: string,
): string {
  if (!isHttpUrl(publicBaseUrl)) {
    throw new Error(
      `Invalid SOAP public base URL: ${publicBaseUrl} (expected an absolute http(s) URL)`,
    );
  }
  const base = publicBaseUrl.replace(/\/+$/, "");
  const path = normalizeSoapPath(soapPath);
  const prefix = path === "/" ? "" : path;
  const segment = encodeURIComponent(cpId);
  return `${base}${prefix}/${segment}/${SOAP_SERVICE_SUFFIX}`;
}

/**
 * Resolve the effective SOAP callback URL by precedence (see module doc).
 * Returns null when neither an explicit URL nor a usable public base is
 * configured — the caller decides whether that is an error (SOAP) or a no-op
 * (JSON). A blank cpId also yields null: there is no callback route to build.
 */
export function resolveSoapCallbackUrl(
  input: SoapCallbackUrlInput,
): string | null {
  const explicit = input.explicitCallbackUrl?.trim();
  if (explicit) return explicit;
  const base = input.publicBaseUrl?.trim();
  if (base && input.cpId) {
    return buildSoapCallbackUrl(base, input.cpId, input.soapPath);
  }
  return null;
}

/** Mirror httpServer.normalizeSoapPath: ensure a leading slash, strip trailing. */
function normalizeSoapPath(value: string): string {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  const trimmed = withLeading.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}
