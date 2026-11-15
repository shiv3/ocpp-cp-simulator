import * as path from "path";
import type { CLIChargePointService } from "../service";
import type { CPRegistry } from "./CPRegistry";
import type { EventBus } from "./eventBus";
import type { Lifecycle } from "./lifecycle";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import { soapFaultResponse } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/soap/OCPPSoapServer";
import {
  DEFAULT_SOAP_PATH,
  SOAP_CHARGE_POINT_SERVICE_ROUTE,
  normalizeSoapPath,
} from "../soapPath";
import { markForwardedUntrusted, type AccessGuard } from "./accessGuard";
import {
  RPC_RATE_PER_SEC,
  INFLIGHT_CAP,
} from "@ocpp-cp-simulator/contracts/limits";
import { appVersion } from "../appVersion";
import {
  applyCors,
  forbidden,
  isOriginAllowed,
  type CorsPolicy,
} from "./httpCors";
import { runtime, type RuntimeServer } from "../runtime";

/**
 * Serve files out of a directory as a 404 fallback for the HTTP router.
 * SPA-friendly: requests with no file extension (`/`, `/settings`, ...)
 * that don't match a real file fall back to `index.html` so the React
 * router can take over.
 *
 * Returns null when there's no match — the caller emits the 404.
 */
async function serveStatic(
  req: Request,
  staticDir: string,
): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;

  const url = new URL(req.url);
  let pathname = decodeURIComponent(url.pathname);
  pathname = pathname.replace(/^\/+/, "");
  // Reject traversal attempts.
  if (pathname.split("/").some((seg) => seg === "..")) return null;
  if (pathname === "") pathname = "index.html";

  const absoluteRoot = path.resolve(staticDir);
  const resolved = path.resolve(absoluteRoot, pathname);
  // Belt-and-braces: even if a path slips past the segment check, ensure
  // the resolved path stays under the static root.
  if (
    resolved !== absoluteRoot &&
    !resolved.startsWith(absoluteRoot + path.sep)
  ) {
    return null;
  }

  let file = runtime.file(resolved);
  let servedFallback = false;
  if (!(await file.exists())) {
    // SPA fallback: only for "looks like a page" requests (no extension on
    // the last path segment). Asset requests for missing files should
    // honestly 404 so the browser doesn't render HTML for a JS bundle.
    const last = pathname.split("/").pop() ?? "";
    if (last.includes(".")) return null;
    file = runtime.file(path.join(absoluteRoot, "index.html"));
    if (!(await file.exists())) return null;
    servedFallback = true;
  }
  const res = await file.response();
  res.headers.set("cache-control", cacheControlFor(pathname, servedFallback));
  return res;
}

/**
 * Cache-Control for a statically served file (issue #79).
 *
 * - Vite emits content hashes into `/assets/*` filenames, so the bytes for a
 *   given URL never change: cache them forever and skip revalidation.
 * - The HTML entry point and any SPA fallback (a deep link rewritten to
 *   index.html) are the bootstrap document that references the current hashed
 *   bundles; it must always be re-fetched or a stale shell pins old assets.
 *   Everything else served from the static root (favicon, manifest, …) is
 *   un-hashed too, so default it to no-store as well — conservative, and it
 *   keeps a CDN from edge-caching auth-gated files by extension.
 */
function cacheControlFor(pathname: string, servedFallback: boolean): string {
  if (!servedFallback && pathname.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "no-store";
}

export const MAX_SOAP_REQUEST_BODY_BYTES = 256 * 1024;
export const MAX_MCP_REQUEST_BODY_BYTES = 1024 * 1024;

interface SoapChargePointServiceRoute {
  readonly cpId: string;
  readonly service?: CLIChargePointService;
}

function matchSoapChargePointService(
  pathname: string,
  registry: CPRegistry,
): SoapChargePointServiceRoute | null {
  const match = SOAP_CHARGE_POINT_SERVICE_ROUTE.exec(pathname);
  if (!match) return null;
  const basePath = normalizeSoapPath(match[1] || "/");
  try {
    const cpId = decodeURIComponent(match[2]);
    const service = registry.get(cpId);
    if (!service) {
      return basePath === DEFAULT_SOAP_PATH ? { cpId } : null;
    }
    return soapBasePathsForService(service).has(basePath)
      ? { cpId, service }
      : null;
  } catch {
    return null;
  }
}

function soapBasePathsForService(
  service: CLIChargePointService,
): ReadonlySet<string> {
  const init = service.getInit();
  const paths = new Set<string>([
    normalizeSoapPath(init.soapPath ?? DEFAULT_SOAP_PATH),
  ]);
  const callbackBasePath = soapCallbackBasePath(
    init.soapCallbackUrl,
    init.cpId,
  );
  if (callbackBasePath) paths.add(callbackBasePath);
  return paths;
}

function soapCallbackBasePath(
  callbackUrl: string | undefined,
  cpId: string,
): string | null {
  if (!callbackUrl) return null;
  try {
    const pathname = new URL(callbackUrl).pathname;
    const match = SOAP_CHARGE_POINT_SERVICE_ROUTE.exec(pathname);
    if (!match) return null;
    return decodeURIComponent(match[2]) === cpId
      ? normalizeSoapPath(match[1] || "/")
      : null;
  } catch {
    return null;
  }
}

function isRegisteredSoapService(service: CLIChargePointService): boolean {
  const init = service.getInit();
  return isSoapVersion(init.ocppVersion) && Boolean(init.soapCallbackUrl);
}

function declaredContentLength(req: Request): number | null {
  const raw = req.headers.get("content-length");
  if (raw === null) return null;
  const value = raw.trim();
  if (!/^(0|[1-9]\d*)$/.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

async function readTextWithLimit(
  req: Request,
  maxBytes: number,
): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (done) break;
    const value = chunk.value;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

async function readArrayBufferWithLimit(
  req: Request,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (done) break;
    const value = chunk.value;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  if (chunks.length === 0) return new ArrayBuffer(0);
  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

/**
 * Default every response to `Cache-Control: no-store` unless the handler set
 * one explicitly (issue #79). serveStatic already stamps build assets as
 * immutable and HTML as no-store; this catches the dynamic / auth-sensitive
 * rest — health, 404s, CORS rejections — which must never be
 * cached at a reverse-proxy edge.
 */
function applyCacheControl(res: Response): Response {
  if (!res.headers.has("cache-control")) {
    res.headers.set("cache-control", "no-store");
  }
  return res;
}

/**
 * Parse a `Authorization: Basic <base64>` header into username + password.
 * Returns null when the header is missing, not Basic, or doesn't decode.
 * Tolerates the rare `Basic` scheme written in any case.
 */
export function parseBasicAuthHeader(
  header: string | null,
): { username: string; password: string } | null {
  if (!header) return null;
  const match = /^\s*Basic\s+(\S+)\s*$/i.exec(header);
  if (!match) return null;
  let latin1: string;
  try {
    latin1 = atob(match[1]);
  } catch {
    return null;
  }
  // RFC 7617 lets clients encode credentials as UTF-8 (and we hint
  // `charset="UTF-8"` in the WWW-Authenticate header). atob produces a
  // Latin-1 string where each char carries one byte; re-decode through
  // a UTF-8 TextDecoder so non-ASCII passwords compare correctly.
  const bytes = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) bytes[i] = latin1.charCodeAt(i);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return {
    username: decoded.slice(0, idx),
    password: decoded.slice(idx + 1),
  };
}

/**
 * Constant-time comparison of supplied creds vs the configured creds.
 * Length differences are inferred from the buffer comparison itself, so
 * an attacker can still time-distinguish "wrong length" from "wrong
 * content" — that leak is fine because the realm name in
 * WWW-Authenticate already announces the server's identity. What we
 * defend against is byte-by-byte secret discovery via response timing.
 */
export function credentialsMatch(
  supplied: { username: string; password: string },
  expected: { username: string; password: string },
): boolean {
  return (
    timingSafeStringEqual(supplied.username, expected.username) &&
    timingSafeStringEqual(supplied.password, expected.password)
  );
}

function timingSafeStringEqual(a: string, b: string): boolean {
  // Buffer compare is constant-time when lengths match; if they don't,
  // we return false immediately. Pad to avoid a length-zero edge case.
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) {
    diff |= ba[i] ^ bb[i];
  }
  return diff === 0;
}

export interface HttpHandlers {
  fetch: (
    req: Request,
    server: RuntimeServer,
  ) => Response | Promise<Response | undefined> | undefined;
}

export interface SocketIoRoute {
  matches(pathname: string): boolean;
  handleRequest(
    req: Request,
    server: RuntimeServer,
  ): Response | Promise<Response>;
}

/**
 * The CSMS→CP callback route, `<soapPath>/<cpId>/ChargePointService`. Null
 * when the path is not one, so the caller falls through to its other routes.
 * Shared by the main listener and by the SOAP-only listener a tunnel forwards
 * to ({@link createSoapCallbackHandlers}), so the two cannot drift.
 */
export function handleSoapChargePointServiceRoute(
  req: Request,
  url: URL,
  registry: CPRegistry,
): Response | Promise<Response> | null {
  const soapRoute = matchSoapChargePointService(url.pathname, registry);
  if (!soapRoute) return null;
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  const service = soapRoute.service;
  if (!service) {
    return soapFaultResponse(
      `Unknown charge point for SOAP callback: ${soapRoute.cpId}`,
      404,
    );
  }
  if (!isRegisteredSoapService(service)) {
    return soapFaultResponse(
      `Charge point is not configured for OCPP SOAP: ${soapRoute.cpId}`,
      400,
    );
  }

  const contentLength = declaredContentLength(req);
  if (contentLength !== null && Number.isNaN(contentLength)) {
    return soapFaultResponse("Invalid SOAP Content-Length header", 400);
  }
  if (contentLength !== null && contentLength > MAX_SOAP_REQUEST_BODY_BYTES) {
    return soapFaultResponse("SOAP request body is too large", 413);
  }

  // OCPP SOAP has no per-message authentication field. This callback
  // endpoint relies on the daemon's existing HTTP Basic-auth gate when
  // enabled, or an operator-controlled trusted network boundary otherwise;
  // do not add a non-standard shared secret to the SOAP payload.
  return readTextWithLimit(req, MAX_SOAP_REQUEST_BODY_BYTES).then(
    async (body) => {
      if (body === null) {
        return soapFaultResponse("SOAP request body is too large", 413);
      }
      return (
        (await service.handleSoapChargePointServiceRequest(
          soapRoute.cpId,
          body,
        )) ??
        soapFaultResponse(
          `Charge point is not configured for OCPP SOAP: ${soapRoute.cpId}`,
          400,
        )
      );
    },
  );
}

/**
 * Handlers for the listener a SOAP tunnel forwards to (#183): the callback
 * route and nothing else. Every other path — socket.io, the web console, MCP,
 * health, metrics — is a 404 here, so the public tunnel exposes the CSMS→CP
 * endpoint alone; those stay on the local listeners. No Basic Auth gate: the
 * CSMS is this listener's only client and OCPP-S callbacks carry no
 * credentials, the route's charge-point identity checks are the guard.
 *
 * `registry` is read per request: the listener is bound before the tunnel and
 * the registry, which needs the tunnel's origin, comes after — until then the
 * route answers 503.
 */
export function createSoapCallbackHandlers(deps: {
  registry: () => CPRegistry | null;
}): { fetch(req: Request): Response | Promise<Response> } {
  return {
    fetch(req) {
      const url = new URL(req.url);
      const registry = deps.registry();
      if (!registry) {
        return SOAP_CHARGE_POINT_SERVICE_ROUTE.test(url.pathname)
          ? soapFaultResponse("daemon is starting", 503)
          : new Response("not found", { status: 404 });
      }
      return (
        handleSoapChargePointServiceRoute(req, url, registry) ??
        new Response("not found", { status: 404 })
      );
    },
  };
}

export function createHttpHandlers(deps: {
  registry: CPRegistry;
  bus: EventBus;
  lifecycle: Lifecycle;
  cors?: CorsPolicy;
  /** Absolute path of a directory served as a 404 fallback (SPA aware). */
  staticDir?: string | null;
  /** Retained for call-site compatibility; control RPC uses the database. */
  database?: Database | null;
  /** Absolute URL path the health-check JSON is served on. Defaults to
   *  `/v1/healthz`. */
  healthPath?: string;
  /** Optional Basic Auth gate for the HTTP web console and non-health HTTP.
   *  When set, every request except the configured `healthPath` must
   *  carry a matching `Authorization: Basic <base64(user:pass)>` header.
   *  Socket.IO transport requests are authenticated by the socket handshake.
   *  Null = no auth (default; backward compatible). */
  webConsoleBasicAuth?: { username: string; password: string } | null;
  /**
   * When set, `GET /metrics` renders the Prometheus exposition. Absent, the
   * path 404s like any other — the endpoint is opt-in.
   */
  metrics?: { render: () => string; exemptFromBasicAuth: boolean } | null;
  /** Optional socket.io/Engine.IO route mounted on the same listener. */
  socketIo?: SocketIoRoute | null;
  /** #620: Host allowlist, trusted proxies, TLS requirement and per-IP rate
   *  limit. Absent = no such checks (default). */
  accessGuard?: AccessGuard | null;
  /** Optional MCP handler for POST /mcp. Rate limiting and body cap are
   *  applied. */
  mcp?: {
    handler: (req: Request) => Promise<Response>;
    /** Rate limit (calls/sec). Defaults to RPC_RATE_PER_SEC. */
    ratePerSec?: number;
    /** Max in-flight requests. Defaults to INFLIGHT_CAP. */
    inflightCap?: number;
  } | null;
}): HttpHandlers {
  const cors: CorsPolicy = deps.cors ?? { kind: "any" };
  const staticDir = deps.staticDir ?? null;
  const healthPath = deps.healthPath ?? "/v1/healthz";
  const webConsoleBasicAuth = deps.webConsoleBasicAuth ?? null;
  const socketIo = deps.socketIo ?? null;
  const mcpConfig = deps.mcp ?? null;
  const metrics = deps.metrics ?? null;
  const accessGuard = deps.accessGuard ?? null;
  const METRICS_PATH = "/metrics";

  // Rate limiting state for MCP handler (token bucket per invocation).
  interface McpRateLimiterState {
    tokens: number;
    lastRefillMs: number;
    inFlight: number;
  }
  const mcpRatePerSec = mcpConfig?.ratePerSec ?? RPC_RATE_PER_SEC;
  const mcpInflightCap = mcpConfig?.inflightCap ?? INFLIGHT_CAP;
  const mcpLimiter: McpRateLimiterState | null = mcpConfig
    ? { tokens: mcpRatePerSec, lastRefillMs: Date.now(), inFlight: 0 }
    : null;

  return {
    fetch(req, server) {
      const url = new URL(req.url);
      // Before everything else, Basic Auth included: a refused Host, a
      // cleartext remote client or a flooding IP gets nothing to probe.
      if (accessGuard !== null) {
        const peer = server?.requestIP?.(req)?.address ?? null;
        const decision = accessGuard.check(req, peer);
        if (decision.refuse) {
          const { status, message, retryAfter } = decision.refuse;
          return new Response(message, {
            status,
            headers:
              retryAfter !== undefined
                ? { "retry-after": String(retryAfter) }
                : undefined,
          });
        }
        if (!decision.forwardedTrusted) markForwardedUntrusted(req);
      }
      // Optional Basic Auth gate. Runs *before* CORS so an attacker without
      // creds can't probe internal endpoints via a same-origin request.
      // The health path is intentionally exempt so k8s probes / external
      // load balancers / browser auto-detect can keep working unprompted.
      if (webConsoleBasicAuth !== null) {
        const socketIoRequest = socketIo?.matches(url.pathname) ?? false;
        // `/metrics` is behind the gate by default, unlike the health path.
        // Health says almost nothing and container probes need it unprompted;
        // metrics expose fleet size and traffic shape. The exemption is opt-in
        // for a trusted network, never the default.
        const metricsExempt =
          url.pathname === METRICS_PATH &&
          metrics !== null &&
          metrics.exemptFromBasicAuth;
        if (url.pathname !== healthPath && !socketIoRequest && !metricsExempt) {
          const auth = parseBasicAuthHeader(req.headers.get("authorization"));
          if (!auth || !credentialsMatch(auth, webConsoleBasicAuth)) {
            // 401 with WWW-Authenticate so browsers prompt for credentials
            // instead of just showing the 401 body. realm is shown in the
            // prompt; charset hints UTF-8 for non-ASCII passwords.
            return new Response("authentication required", {
              status: 401,
              headers: {
                "www-authenticate":
                  'Basic realm="ocpp-cp-simulator", charset="UTF-8"',
              },
            });
          }
        }
      }

      // Block disallowed browser origins BEFORE dispatching so simple-request
      // POSTs / socket upgrades / GETs don't trigger side effects under a tightened
      // --cors-origin allowlist. CORS response headers alone are not enough,
      // since simple requests bypass preflight and reach the handler regardless.
      if (!isOriginAllowed(req, cors)) {
        return applyCors(forbidden(), req, cors);
      }

      // CORS preflight — answer immediately for any path/method.
      if (req.method === "OPTIONS") {
        return applyCors(new Response(null, { status: 204 }), req, cors);
      }

      if (socketIo !== null && socketIo.matches(url.pathname)) {
        const result = socketIo.handleRequest(req, server);
        if (result instanceof Response) {
          return applyCacheControl(applyCors(result, req, cors));
        }
        return result.then((r) => applyCacheControl(applyCors(r, req, cors)));
      }

      const result = dispatch(req, server);
      if (result instanceof Response) {
        return applyCacheControl(applyCors(result, req, cors));
      }
      return result.then((r) => applyCacheControl(applyCors(r, req, cors)));
    },
  };

  function dispatch(
    req: Request,
    _server: RuntimeServer,
  ): Response | Promise<Response> {
    const url = new URL(req.url);

    // GET <healthPath>  (default /v1/healthz; configurable via --health-path)
    // `version` is additive: `ok` stays the field probes assert on. It makes
    // the endpoint answer "which build is actually running here?" without
    // needing an authenticated RPC round-trip.
    if (req.method === "GET" && url.pathname === healthPath) {
      return Response.json({ ok: true, version: appVersion() });
    }

    if (url.pathname === METRICS_PATH) {
      if (metrics === null) {
        // Reserved even when disabled. Falling through would reach the SPA
        // fallback, which answers 200 with index.html for any extension-less
        // path — so a scraper would read HTML as a successful scrape instead
        // of the documented 404.
        return new Response("metrics are not enabled", { status: 404 });
      }
      if (req.method !== "GET") {
        return new Response("method not allowed", {
          status: 405,
          headers: { allow: "GET" },
        });
      }
      return new Response(metrics.render(), {
        headers: {
          // The version parameter is what makes a scraper parse this as the
          // text exposition rather than guessing from the body.
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    const soapResponse = handleSoapChargePointServiceRoute(
      req,
      url,
      deps.registry,
    );
    if (soapResponse) return soapResponse;

    // /mcp — MCP (Model Context Protocol) Streamable HTTP endpoint.
    // Stateless, POST-only: the spec requires 405 for GET when the server
    // offers no server-initiated SSE stream (and DELETE has no session to
    // terminate). Falls through to 404 when no handler is configured.
    if (url.pathname === "/mcp" && mcpConfig && req.method !== "POST") {
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    if (url.pathname === "/mcp" && req.method === "POST" && mcpConfig) {
      const contentLength = declaredContentLength(req);
      if (contentLength !== null && Number.isNaN(contentLength)) {
        return new Response("invalid content-length header", {
          status: 400,
        });
      }
      if (
        contentLength !== null &&
        contentLength > MAX_MCP_REQUEST_BODY_BYTES
      ) {
        return new Response("request body is too large", { status: 413 });
      }

      // Check rate limit before consuming capacity.
      if (mcpLimiter) {
        const now = Date.now();
        const elapsedSeconds =
          Math.max(0, now - mcpLimiter.lastRefillMs) / 1_000;
        mcpLimiter.tokens = Math.min(
          mcpRatePerSec,
          mcpLimiter.tokens + elapsedSeconds * mcpRatePerSec,
        );
        mcpLimiter.lastRefillMs = now;

        if (mcpLimiter.tokens < 1 || mcpLimiter.inFlight >= mcpInflightCap) {
          return new Response("rate limit exceeded", { status: 429 });
        }

        mcpLimiter.tokens -= 1;
        mcpLimiter.inFlight += 1;
      }

      // Buffer the body (arrayBuffer), then reconstruct the Request.
      // The finally-decrement must cover EVERY exit — including a rejected
      // body read (client aborts mid-upload) — or inFlight pins at the cap
      // and the endpoint 429s forever.
      return readArrayBufferWithLimit(req, MAX_MCP_REQUEST_BODY_BYTES)
        .then((buffer) => {
          if (buffer === null) {
            return new Response("request body is too large", { status: 413 });
          }
          const reqWithBody = new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: buffer.byteLength > 0 ? buffer : null,
          });
          return mcpConfig.handler(reqWithBody);
        })
        .catch(() => new Response("internal error", { status: 500 }))
        .finally(() => {
          if (mcpLimiter) mcpLimiter.inFlight -= 1;
        });
    }

    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
      return new Response("not found", { status: 404 });
    }

    // Static file fallback (SPA aware). Disabled when --serve-static is
    // not configured. Note: dispatch can return a Promise, so awaiting
    // here is fine.
    if (staticDir) {
      return serveStatic(req, staticDir).then(
        (res) => res ?? new Response("not found", { status: 404 }),
      );
    }
    return new Response("not found", { status: 404 });
  }
}

export type { CorsPolicy } from "./httpCors";
export { parseCreateBody } from "./httpCreateBody";
export type { ParseCreateBodyOptions } from "./httpCreateBody";
