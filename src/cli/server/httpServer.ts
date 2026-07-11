import type { Server } from "bun";
import * as path from "path";
import type { CLIChargePointService } from "../service";
import type { ChargePointInitOptions } from "../types";
import type { CPRegistry } from "./CPRegistry";
import type { EventBus } from "./eventBus";
import type { Lifecycle } from "./lifecycle";
import type { Database } from "../../cp/domain/persistence/Database";
import {
  isOcppVersion,
  isSoapVersion,
} from "../../cp/domain/types/OcppVersion";
import { soapFaultResponse } from "../../cp/infrastructure/transport/soap/OCPPSoapServer";

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

  let file = Bun.file(resolved);
  let servedFallback = false;
  if (!(await file.exists())) {
    // SPA fallback: only for "looks like a page" requests (no extension on
    // the last path segment). Asset requests for missing files should
    // honestly 404 so the browser doesn't render HTML for a JS bundle.
    const last = pathname.split("/").pop() ?? "";
    if (last.includes(".")) return null;
    file = Bun.file(path.join(absoluteRoot, "index.html"));
    if (!(await file.exists())) return null;
    servedFallback = true;
  }
  const res = new Response(file);
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

const COMMON_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

export const DEFAULT_SOAP_PATH = "/ocpp/soap";
export const MAX_SOAP_REQUEST_BODY_BYTES = 256 * 1024;

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
  | { kind: "same-origin"; trustForwardedHeaders?: boolean };

function pickAllowedOrigin(req: Request, policy: CorsPolicy): string | null {
  if (policy.kind === "any") return "*";
  const origin = req.headers.get("origin");
  if (!origin) return null;
  if (policy.kind === "allowlist") {
    return policy.origins.includes(origin) ? origin : null;
  }
  // same-origin: echo back Origin iff it matches the request's host.
  return isSameOriginRequest(req, origin, policy.trustForwardedHeaders === true)
    ? origin
    : null;
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
  trustForwarded: boolean,
): boolean {
  try {
    const originUrl = new URL(origin);
    const reqUrl = new URL(req.url);
    if (originsEqual(originUrl, reqUrl)) return true;
    if (trustForwarded) {
      const forwarded = forwardedOrigin(req);
      if (forwarded && originsEqual(originUrl, new URL(forwarded))) return true;
    }
    return false;
  } catch {
    return false;
  }
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
function isOriginAllowed(req: Request, policy: CorsPolicy): boolean {
  if (policy.kind === "any") return true;
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser caller (curl / CLI / server-to-server)
  if (policy.kind === "allowlist") return policy.origins.includes(origin);
  // same-origin: only the simulator's own served origin can call the daemon
  // (optionally including the proxy-reported public origin).
  return isSameOriginRequest(
    req,
    origin,
    policy.trustForwardedHeaders === true,
  );
}

function applyCors(res: Response, req: Request, policy: CorsPolicy): Response {
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

function forbidden(): Response {
  return new Response("origin not allowed", { status: 403 });
}

interface SoapChargePointServiceRoute {
  readonly cpId: string;
  readonly service?: CLIChargePointService;
}

function matchSoapChargePointService(
  pathname: string,
  registry: CPRegistry,
): SoapChargePointServiceRoute | null {
  const match = /^(.*)\/([^/]+)\/ChargePointService$/.exec(pathname);
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
    const match = /^(.*)\/([^/]+)\/ChargePointService$/.exec(pathname);
    if (!match) return null;
    return decodeURIComponent(match[2]) === cpId
      ? normalizeSoapPath(match[1] || "/")
      : null;
  } catch {
    return null;
  }
}

function normalizeSoapPath(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
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
    server: Server<Record<string, unknown>>,
  ) => Response | Promise<Response | undefined> | undefined;
}

export interface SocketIoRoute {
  matches(pathname: string): boolean;
  handleRequest(
    req: Request,
    server: Server<Record<string, unknown>>,
  ): Response | Promise<Response>;
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
  /** Optional socket.io/Engine.IO route mounted on the same Bun listener. */
  socketIo?: SocketIoRoute | null;
}): HttpHandlers {
  const cors: CorsPolicy = deps.cors ?? { kind: "any" };
  const staticDir = deps.staticDir ?? null;
  const healthPath = deps.healthPath ?? "/v1/healthz";
  const webConsoleBasicAuth = deps.webConsoleBasicAuth ?? null;
  const socketIo = deps.socketIo ?? null;

  return {
    fetch(req, server) {
      const url = new URL(req.url);
      // Optional Basic Auth gate. Runs *before* CORS so an attacker without
      // creds can't probe internal endpoints via a same-origin request.
      // The health path is intentionally exempt so k8s probes / external
      // load balancers / browser auto-detect can keep working unprompted.
      if (webConsoleBasicAuth !== null) {
        const socketIoRequest = socketIo?.matches(url.pathname) ?? false;
        if (url.pathname !== healthPath && !socketIoRequest) {
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
    _server: Server<Record<string, unknown>>,
  ): Response | Promise<Response> {
    const url = new URL(req.url);

    // GET <healthPath>  (default /v1/healthz; configurable via --health-path)
    if (req.method === "GET" && url.pathname === healthPath) {
      return Response.json({ ok: true });
    }

    const soapRoute = matchSoapChargePointService(url.pathname, deps.registry);
    if (soapRoute) {
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
      if (
        contentLength !== null &&
        contentLength > MAX_SOAP_REQUEST_BODY_BYTES
      ) {
        return soapFaultResponse("SOAP request body is too large", 413);
      }

      // OCPP 1.5 SOAP has no per-message authentication field. This callback
      // endpoint relies on the daemon's existing HTTP Basic-auth gate when
      // enabled, or an operator-controlled trusted network boundary otherwise;
      // do not add a non-standard shared secret to the SOAP payload.
      return readTextWithLimit(req, MAX_SOAP_REQUEST_BODY_BYTES).then(
        (body) => {
          if (body === null) {
            return soapFaultResponse("SOAP request body is too large", 413);
          }
          return (
            service.handleSoapChargePointServiceRequest(soapRoute.cpId, body) ??
            soapFaultResponse(
              `Charge point is not configured for OCPP 1.5 SOAP: ${soapRoute.cpId}`,
              400,
            )
          );
        },
      );
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseCreateBody(body: unknown): ChargePointInitOptions {
  if (!isRecord(body)) throw new Error("body must be an object");
  const cpId = body.cpId;
  if (typeof cpId !== "string" || cpId.length === 0) {
    throw new Error("cpId is required (string)");
  }
  const wsUrl = body.wsUrl;
  if (typeof wsUrl !== "string" || wsUrl.length === 0) {
    throw new Error("wsUrl is required (string)");
  }
  const centralSystemUrl =
    typeof body.centralSystemUrl === "string" &&
    body.centralSystemUrl.length > 0
      ? body.centralSystemUrl
      : wsUrl;
  const soapCallbackUrl =
    typeof body.soapCallbackUrl === "string" && body.soapCallbackUrl.length > 0
      ? body.soapCallbackUrl
      : undefined;
  const soapPath =
    typeof body.soapPath === "string" && body.soapPath.startsWith("/")
      ? normalizeSoapPath(body.soapPath)
      : undefined;
  const connectors =
    typeof body.connectors === "number" && Number.isInteger(body.connectors)
      ? body.connectors
      : 1;
  if (connectors < 1) {
    throw new Error("connectors must be >= 1");
  }
  const vendor =
    typeof body.vendor === "string" ? body.vendor : "Server-Vendor";
  const model = typeof body.model === "string" ? body.model : "Server-Model";
  let ocppVersion = "OCPP-1.6J";
  if (Object.prototype.hasOwnProperty.call(body, "ocppVersion")) {
    if (typeof body.ocppVersion !== "string") {
      throw new Error("ocppVersion must be a string");
    }
    if (isOcppVersion(body.ocppVersion)) {
      ocppVersion = body.ocppVersion;
    } else {
      throw new Error("ocppVersion must be a supported OCPP version");
    }
  }
  if (isSoapVersion(ocppVersion) && !soapCallbackUrl) {
    throw new Error("soapCallbackUrl is required for OCPP SOAP versions");
  }
  let basicAuth: ChargePointInitOptions["basicAuth"] = null;
  if (isRecord(body.basicAuth)) {
    const username = body.basicAuth.username;
    const password = body.basicAuth.password;
    if (typeof username === "string" && typeof password === "string") {
      basicAuth = { username, password };
    }
  }
  let securityProfile: ChargePointInitOptions["securityProfile"];
  if (Object.prototype.hasOwnProperty.call(body, "securityProfile")) {
    const value = body.securityProfile;
    if (value === 0 || value === 1 || value === 2 || value === 3) {
      securityProfile = value;
    } else {
      throw new Error("securityProfile must be 0, 1, 2, or 3");
    }
  }
  const authorizationKey =
    typeof body.authorizationKey === "string"
      ? body.authorizationKey
      : undefined;
  const cpoName = typeof body.cpoName === "string" ? body.cpoName : undefined;
  const tlsCaPath =
    typeof body.tlsCaPath === "string" ? body.tlsCaPath : undefined;
  const tlsCertPath =
    typeof body.tlsCertPath === "string" ? body.tlsCertPath : undefined;
  const tlsKeyPath =
    typeof body.tlsKeyPath === "string" ? body.tlsKeyPath : undefined;
  let tls: ChargePointInitOptions["tls"];
  if (isRecord(body.tls)) {
    tls = {
      ...(typeof body.tls.ca === "string" ? { ca: body.tls.ca } : {}),
      ...(typeof body.tls.cert === "string" ? { cert: body.tls.cert } : {}),
      ...(typeof body.tls.key === "string" ? { key: body.tls.key } : {}),
      ...(typeof body.tls.rejectUnauthorized === "boolean"
        ? { rejectUnauthorized: body.tls.rejectUnauthorized }
        : {}),
      ...(typeof body.tls.serverName === "string"
        ? { serverName: body.tls.serverName }
        : {}),
    };
  }
  const bn = isRecord(body.bootNotification) ? body.bootNotification : null;
  const bootNotification: ChargePointInitOptions["bootNotification"] = bn
    ? {
        ...(typeof bn.firmwareVersion === "string"
          ? { firmwareVersion: bn.firmwareVersion }
          : {}),
        ...(typeof bn.chargePointSerialNumber === "string"
          ? { chargePointSerialNumber: bn.chargePointSerialNumber }
          : {}),
        ...(typeof bn.chargeBoxSerialNumber === "string"
          ? { chargeBoxSerialNumber: bn.chargeBoxSerialNumber }
          : {}),
        ...(typeof bn.meterSerialNumber === "string"
          ? { meterSerialNumber: bn.meterSerialNumber }
          : {}),
        ...(typeof bn.meterType === "string"
          ? { meterType: bn.meterType }
          : {}),
        ...(typeof bn.iccid === "string" ? { iccid: bn.iccid } : {}),
        ...(typeof bn.imsi === "string" ? { imsi: bn.imsi } : {}),
      }
    : undefined;
  return {
    cpId,
    wsUrl,
    centralSystemUrl,
    connectors,
    vendor,
    model,
    basicAuth,
    ocppVersion,
    ...(soapCallbackUrl ? { soapCallbackUrl } : {}),
    ...(soapPath ? { soapPath } : {}),
    securityProfile,
    authorizationKey,
    cpoName,
    tls,
    tlsCaPath,
    tlsCertPath,
    tlsKeyPath,
    ...(bootNotification ? { bootNotification } : {}),
  };
}
