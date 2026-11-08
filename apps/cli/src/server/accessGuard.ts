import { isIP } from "node:net";

/**
 * Network-level access checks in front of the daemon's HTTP listener (#620):
 * a Host allowlist against DNS rebinding, trusted proxies for the forwarding
 * headers, a TLS requirement for non-loopback clients and a per-IP rate limit.
 *
 * Every option is off by default; a guard built from no options changes
 * nothing (see {@link isAccessGuardActive}).
 */

export interface AccessGuardOptions {
  /** Host names (`name` or `name:port`) a request may address, besides IP
   *  literals and `localhost`. Empty = no Host check. */
  readonly allowedHosts?: readonly string[];
  /** IPs or CIDRs whose forwarding headers are believed. Empty = the headers
   *  are believed from any peer when `--trust-forwarded-headers` is set. */
  readonly trustedProxies?: readonly string[];
  /** Refuse non-loopback clients that did not arrive over TLS. */
  readonly requireTls?: boolean;
  /** Requests per second one client IP may make. 0/undefined = unlimited. */
  readonly rateLimitPerIp?: number;
  /** Most client IPs the limiter tracks at once. */
  readonly rateLimitMaxIps?: number;
  /** Path exempt from the TLS and rate checks (probes). */
  readonly healthPath?: string;
  readonly now?: () => number;
}

export const DEFAULT_RATE_LIMIT_MAX_IPS = 10_000;

export function isAccessGuardActive(options: AccessGuardOptions): boolean {
  return (
    (options.allowedHosts?.length ?? 0) > 0 ||
    (options.trustedProxies?.length ?? 0) > 0 ||
    options.requireTls === true ||
    (options.rateLimitPerIp ?? 0) > 0
  );
}

// ---------------------------------------------------------------------------
// IP and CIDR matching
// ---------------------------------------------------------------------------

type Range = { family: 4 | 6; bytes: number[]; bits: number };

function parseIp(ip: string): { family: 4 | 6; bytes: number[] } | null {
  let text = ip.trim().replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const family = isIP(text);
  if (family === 4) {
    return { family: 4, bytes: text.split(".").map((p) => Number(p)) };
  }
  if (family !== 6) return null;
  // ::ffff:1.2.3.4 is an IPv4 client on a dual-stack socket.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
  if (mapped) return parseIp(mapped[1]);
  let head = text;
  let tail = "";
  const gap = text.indexOf("::");
  if (gap >= 0) {
    head = text.slice(0, gap);
    tail = text.slice(gap + 2);
  }
  const toGroups = (part: string): string[] =>
    part === "" ? [] : part.split(":");
  const headGroups = toGroups(head);
  const tailGroups = toGroups(tail);
  let groups: string[];
  if (gap >= 0) {
    const fill = 8 - headGroups.length - tailGroups.length;
    groups = [...headGroups, ...Array(fill).fill("0"), ...tailGroups];
  } else {
    groups = headGroups;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    const value = parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return { family: 6, bytes };
}

/**
 * The rate-limit bucket of a client: an IPv4 address (or an IPv4-mapped one)
 * by itself, an IPv6 address by its /64, since one subscriber holds a whole
 * /64 and could otherwise rotate addresses past the limit. Anything that is
 * not an IP is its own key.
 */
export function rateLimitKey(client: string): string {
  const ip = parseIp(client);
  if (!ip || ip.family === 4) return ip ? ip.bytes.join(".") : client;
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 2) {
    groups.push(((ip.bytes[i] << 8) | ip.bytes[i + 1]).toString(16));
  }
  return `${groups.join(":")}::/64`;
}

/** Parse `1.2.3.4`, `10.0.0.0/8`, `::1`, `fd00::/8`; null when malformed. */
export function parseTrustedProxy(entry: string): Range | null {
  const [address, prefix, ...rest] = entry.trim().split("/");
  if (rest.length > 0) return null;
  const ip = parseIp(address);
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  let bits = max;
  if (prefix !== undefined) {
    if (!/^\d+$/.test(prefix)) return null;
    bits = Number(prefix);
    if (bits > max) return null;
  }
  return { ...ip, bits };
}

function inRange(range: Range, ip: { family: 4 | 6; bytes: number[] }) {
  if (range.family !== ip.family) return false;
  let bits = range.bits;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((range.bytes[i] & mask) !== (ip.bytes[i] & mask)) return false;
  }
  return true;
}

export function isLoopbackIp(address: string | null | undefined): boolean {
  if (!address) return false;
  const ip = parseIp(address);
  if (!ip) return address === "localhost";
  if (ip.family === 4) return ip.bytes[0] === 127;
  return ip.bytes.slice(0, 15).every((b) => b === 0) && ip.bytes[15] === 1;
}

// ---------------------------------------------------------------------------
// Forwarded headers
// ---------------------------------------------------------------------------

export interface ForwardedInfo {
  readonly proto: string | null;
  readonly host: string | null;
  readonly forClients: readonly string[];
}

function firstValue(header: string | null): string | null {
  if (!header) return null;
  const first = header.split(",")[0]?.trim() ?? "";
  return first.length > 0 ? first : null;
}

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}

/** The first element of an RFC 7239 `Forwarded` header, plus every `for=`. */
function parseForwardedHeader(header: string | null): {
  proto: string | null;
  host: string | null;
  forClients: string[];
} {
  const result = {
    proto: null as string | null,
    host: null as string | null,
    forClients: [] as string[],
  };
  if (!header) return result;
  const elements = header.split(",");
  elements.forEach((element, index) => {
    for (const pair of element.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const key = pair.slice(0, eq).trim().toLowerCase();
      const value = unquote(pair.slice(eq + 1).trim());
      if (key === "for") result.forClients.push(value);
      if (index === 0 && key === "proto") result.proto = value.toLowerCase();
      if (index === 0 && key === "host") result.host = value;
    }
  });
  return result;
}

/**
 * The values the forwarding headers of `headers` claim, or a conflict when
 * `Forwarded` and `X-Forwarded-*` disagree on the protocol or the host. A
 * client that can set both and have them disagree is probing which one the
 * daemon believes, so the request is refused rather than resolved by a guess.
 */
export function readForwarded(
  headers: Headers,
): { ok: true; info: ForwardedInfo } | { ok: false; reason: string } {
  const standard = parseForwardedHeader(headers.get("forwarded"));
  const xProto = firstValue(headers.get("x-forwarded-proto"))?.toLowerCase();
  const xHost = firstValue(headers.get("x-forwarded-host"));
  if (standard.proto && xProto && standard.proto !== xProto) {
    return {
      ok: false,
      reason: "Forwarded and X-Forwarded-Proto disagree",
    };
  }
  if (
    standard.host &&
    xHost &&
    standard.host.toLowerCase() !== xHost.toLowerCase()
  ) {
    return { ok: false, reason: "Forwarded and X-Forwarded-Host disagree" };
  }
  const xFor = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (standard.forClients.length > 0 && xFor.length > 0) {
    const a = standard.forClients.map(stripPort).join(",");
    const b = xFor.map(stripPort).join(",");
    if (a !== b) {
      return {
        ok: false,
        reason: "Forwarded and X-Forwarded-For disagree",
      };
    }
  }
  return {
    ok: true,
    info: {
      proto: standard.proto ?? xProto ?? null,
      host: standard.host ?? xHost ?? null,
      forClients: standard.forClients.length > 0 ? standard.forClients : xFor,
    },
  };
}

function stripPort(address: string): string {
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracket) return bracket[1].toLowerCase();
  if (/^[^:]+:\d+$/.test(address)) return address.split(":")[0].toLowerCase();
  return address.toLowerCase();
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export interface GuardDecision {
  /** Set when the request must be answered without being dispatched. */
  readonly refuse?: { status: number; message: string; retryAfter?: number };
  /** False when the forwarding headers must be ignored for this request. */
  readonly forwardedTrusted: boolean;
}

export interface AccessGuard {
  check(req: Request, peerAddress: string | null): GuardDecision;
  /** Client IPs the rate limiter is tracking right now. */
  trackedIps(): number;
  /** True when the forwarding headers are only believed from listed proxies. */
  readonly restrictsForwardedHeaders: boolean;
}

interface Bucket {
  tokens: number;
  last: number;
}

/** Request identity for CORS: the forwarded headers count only when trusted. */
const untrustedForwarded = new WeakSet<Request>();
export function forwardedHeadersTrusted(req: Request): boolean {
  return !untrustedForwarded.has(req);
}

export function createAccessGuard(options: AccessGuardOptions): AccessGuard {
  const allowedHosts = (options.allowedHosts ?? []).map((h) =>
    h.trim().toLowerCase(),
  );
  const proxies: Range[] = [];
  for (const entry of options.trustedProxies ?? []) {
    const range = parseTrustedProxy(entry);
    if (!range) throw new Error(`invalid --trusted-proxy "${entry}"`);
    proxies.push(range);
  }
  const requireTls = options.requireTls === true;
  const rate = options.rateLimitPerIp ?? 0;
  const maxIps = Math.max(
    1,
    options.rateLimitMaxIps ?? DEFAULT_RATE_LIMIT_MAX_IPS,
  );
  const now = options.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  const isTrustedProxy = (address: string | null): boolean => {
    if (proxies.length === 0) return false;
    const ip = address ? parseIp(address) : null;
    return ip !== null && proxies.some((range) => inRange(range, ip));
  };

  /** The client behind the trusted proxies: the right-most `for` that is not
   *  itself a trusted proxy, else the peer. */
  const clientIp = (
    peer: string | null,
    forClients: readonly string[],
  ): string | null => {
    if (!isTrustedProxy(peer)) return peer;
    for (let i = forClients.length - 1; i >= 0; i--) {
      const candidate = stripPort(forClients[i]);
      if (!isTrustedProxy(candidate)) return candidate;
    }
    return peer;
  };

  const hostAllowed = (hostHeader: string | null): boolean => {
    if (!hostHeader) return false;
    const host = hostHeader.trim().toLowerCase();
    if (allowedHosts.includes(host)) return true;
    const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (isIP(name) !== 0) return true;
    if (name === "localhost" || name.endsWith(".localhost")) return true;
    return allowedHosts.includes(name);
  };

  const take = (key: string): number | null => {
    const t = now();
    let bucket = buckets.get(key);
    if (bucket) {
      buckets.delete(key); // re-inserted below: Map order = least recent first
      bucket.tokens = Math.min(
        rate,
        bucket.tokens + ((t - bucket.last) / 1000) * rate,
      );
      bucket.last = t;
    } else {
      bucket = { tokens: rate, last: t };
    }
    buckets.set(key, bucket);
    while (buckets.size > maxIps) {
      const oldest = buckets.keys().next().value as string;
      buckets.delete(oldest);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return null;
    }
    return Math.max(1, Math.ceil((1 - bucket.tokens) / rate));
  };

  return {
    restrictsForwardedHeaders: proxies.length > 0,
    trackedIps: () => buckets.size,
    check(req, peerAddress) {
      const path = new URL(req.url).pathname;
      const exempt = path === (options.healthPath ?? "/v1/healthz");
      const fromProxy = isTrustedProxy(peerAddress);
      // Forwarding headers are believed from a listed proxy only. Without a
      // list the daemon behaves as before: `--trust-forwarded-headers` alone
      // believes every peer.
      const forwardedTrusted = proxies.length === 0 || fromProxy;
      let forwarded: ForwardedInfo | null = null;
      if (proxies.length > 0 && fromProxy) {
        const read = readForwarded(req.headers);
        if (!read.ok) {
          return {
            refuse: { status: 400, message: read.reason },
            forwardedTrusted,
          };
        }
        forwarded = read.info;
      }

      if (allowedHosts.length > 0) {
        // Behind a trusted proxy the name the client typed is the forwarded
        // host; otherwise it is the Host the request itself carries.
        const hostHeader =
          forwarded?.host ?? req.headers.get("host") ?? new URL(req.url).host;
        if (!hostAllowed(hostHeader)) {
          return {
            refuse: { status: 403, message: "host not allowed" },
            forwardedTrusted,
          };
        }
      }

      const client = clientIp(peerAddress, forwarded?.forClients ?? []);

      if (requireTls && !exempt) {
        // Direct loopback callers (the bundled CLI, a local probe) are not on
        // a network that needs encrypting. A request from a trusted proxy is
        // never "direct", even from a loopback peer: it must carry
        // `proto=https`, or a plain-HTTP client of a same-host proxy (which
        // may send no forwarding headers, or a forged loopback `for`) would
        // pass. Everything else must have been carried over TLS, as far as a
        // trusted proxy says.
        const local = !fromProxy && isLoopbackIp(peerAddress);
        const secure = forwarded?.proto === "https";
        if (!local && !secure) {
          return {
            refuse: { status: 403, message: "TLS required" },
            forwardedTrusted,
          };
        }
      }

      if (rate > 0 && !exempt) {
        const wait = take(client ? rateLimitKey(client) : "unknown");
        if (wait !== null) {
          return {
            refuse: {
              status: 429,
              message: "rate limit exceeded",
              retryAfter: wait,
            },
            forwardedTrusted,
          };
        }
      }
      return { forwardedTrusted };
    },
  };
}

/** Mark `req` so CORS ignores its forwarding headers (see the guard). */
export function markForwardedUntrusted(req: Request): void {
  untrustedForwarded.add(req);
}
