import { isIP } from "node:net";
import { forwardedHeadersTrusted } from "./accessGuard";

const COMMON_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

export type CorsPolicy =
  | { kind: "any" }
  | { kind: "allowlist"; origins: ReadonlyArray<string> }
  /**
   * "same-origin": browsers with a cross-site Origin header are rejected.
   * Requests with no Origin (curl, CLI clients, server-to-server) and
   * same-origin browser requests (Origin matches the request's Host) are
   * allowed. Used as the safe default when the daemon binds to 0.0.0.0
   * without an explicit `--cors-origin`, so a LAN-exposed daemon doesn't
   * silently accept daemon control calls from any third-party page in the
   * operator's browser.
   *
   * `trustForwardedHeaders` (set by `--trust-forwarded-headers`): when the
   * daemon runs behind a reverse proxy its own request URL is the internal
   * address, so a browser Origin of the public URL never matches. With this
   * flag the same-origin check ALSO accepts an Origin equal to
   * `${X-Forwarded-Proto}://${X-Forwarded-Host}`. Only enable it when a
   * trusted proxy sets those headers — if the daemon is reachable directly,
   * a client can spoof them to forge an allowed origin.
   */
  | {
      kind: "same-origin";
      trustForwardedHeaders?: boolean;
      /**
       * DNS-rebinding guard (set while the daemon runs behavior code): the
       * request's own Host must be an IP literal, `localhost`, or one of
       * these names. A page on `evil.example` that rebinds its name to the
       * daemon has Origin == Host == `evil.example:port`, so equality of the
       * two proves nothing; the name itself is what has to be known.
       */
      allowedHosts?: ReadonlyArray<string>;
    };

function pickAllowedOrigin(req: Request, policy: CorsPolicy): string | null {
  if (policy.kind === "any") return "*";
  const origin = req.headers.get("origin");
  if (!origin) return null;
  if (policy.kind === "allowlist") {
    return policy.origins.includes(origin) ? origin : null;
  }
  // same-origin: echo back Origin iff it matches the request's host.
  return isSameOriginRequest(req, origin, policy) ? origin : null;
}

/**
 * True when the request's Origin header points at the same scheme+host+port
 * as the request itself. Used by the "same-origin" CORS policy.
 *
 * When `trustForwarded` is set, the Origin is also accepted if it matches the
 * proxy-reported public URL (`X-Forwarded-Proto` + `X-Forwarded-Host`), so the
 * daemon works behind a reverse proxy where its own request URL is the
 * internal address. Caller must only pass `true` when a trusted proxy sets
 * those headers (see CorsPolicy docs).
 */
function isSameOriginRequest(
  req: Request,
  origin: string,
  policy: Extract<CorsPolicy, { kind: "same-origin" }>,
): boolean {
  const trustForwarded = policy.trustForwardedHeaders === true;
  try {
    const originUrl = new URL(origin);
    const reqUrl = new URL(req.url);
    if (originsEqual(originUrl, reqUrl)) {
      if (!policy.allowedHosts) return true;
      if (isKnownHost(reqUrl.hostname, policy.allowedHosts)) return true;
    }
    if (trustForwarded) {
      const forwarded = forwardedOrigin(req);
      if (forwarded && originsEqual(originUrl, new URL(forwarded))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** An IP literal, `localhost` or an allowed name: not a name an attacker can rebind. */
function isKnownHost(
  hostname: string,
  allowed: ReadonlyArray<string>,
): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return allowed.some((name) => name.toLowerCase() === host);
}

function originsEqual(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

/**
 * Reconstruct the public origin from a reverse proxy's forwarding headers,
 * or null when either is absent. Each header may carry a comma-separated
 * chain (`client, proxy1, proxy2`); the first entry is the value the
 * outermost proxy saw, i.e. the public URL.
 */
function forwardedOrigin(req: Request): string | null {
  // #620: a peer that is not a listed `--trusted-proxy` has its forwarding
  // headers ignored.
  if (!forwardedHeadersTrusted(req)) return null;
  const proto = firstForwardedValue(req.headers.get("x-forwarded-proto"));
  const host = firstForwardedValue(req.headers.get("x-forwarded-host"));
  if (!proto || !host) return null;
  return `${proto}://${host}`;
}

function firstForwardedValue(header: string | null): string | null {
  if (!header) return null;
  const first = header.split(",")[0]?.trim() ?? "";
  return first.length > 0 ? first : null;
}

/**
 * Returns true when the request's Origin header is acceptable under the policy.
 *
 * - "any" policy: always true (open CORS).
 * - "allowlist": true iff Origin is in the list, OR no Origin header is present.
 *   The latter exemption is intentional: non-browser callers (curl, fetch from
 *   server code, the cp-sim CLI) don't send Origin, and the allowlist exists to
 *   block cross-site browser requests, not to authenticate.
 */
export function isOriginAllowed(req: Request, policy: CorsPolicy): boolean {
  if (policy.kind === "any") return true;
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser caller (curl / CLI / server-to-server)
  if (policy.kind === "allowlist") return policy.origins.includes(origin);
  // same-origin: only the simulator's own served origin can call the daemon
  // (optionally including the proxy-reported public origin).
  return isSameOriginRequest(req, origin, policy);
}

export function applyCors(
  res: Response,
  req: Request,
  policy: CorsPolicy,
): Response {
  const allow = pickAllowedOrigin(req, policy);
  if (allow) {
    res.headers.set("access-control-allow-origin", allow);
    if (allow !== "*") res.headers.set("vary", "Origin");
  }
  for (const [k, v] of Object.entries(COMMON_CORS_HEADERS)) {
    res.headers.set(k, v);
  }
  return res;
}

export function forbidden(): Response {
  return new Response("origin not allowed", { status: 403 });
}
