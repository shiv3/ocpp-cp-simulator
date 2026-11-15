/**
 * Browser WebSocket cannot set an `Authorization: Basic` header, so when this
 * module is loaded in a browser we fall back to a URL query parameter that
 * many CSMS implementations accept (e.g. `ocpp_ws_secret`). CLI runtimes (Bun
 * / Node `ws`) send the credentials as a real HTTP Basic header instead.
 */
import { isOcpp2Version } from "../../domain/types/OcppVersion";
import type { WsClientOptions } from "../../shared/WsClientOptions";
import {
  OCPP_WEBSOCKET_PROTOCOL_16,
  OCPP_WEBSOCKET_PROTOCOL_201,
  ocppVersionToSubprotocol,
} from "./profile/subprotocols";
import type { OcppSecurityProfile } from "@ocpp-cp-simulator/contracts/securityProfile";
import type { OcppTlsOptions } from "../../domain/transport/ConnectionSecurity";
import { peerChainRootPem } from "./ws/peerCertificate";
import {
  BufferedErrorWebSocket,
  DeferredNodeWebSocket,
  type OcppWebSocketEventHandlers,
} from "./ws/socketWrappers";

export { peerChainRootPem };

export {
  OCPP_WEBSOCKET_PROTOCOL_16,
  OCPP_WEBSOCKET_PROTOCOL_201,
  ocppVersionToSubprotocol,
};

export const OCPP_BROWSER_WS_SECRET_QUERY_PARAM = "ocpp_ws_secret";

export type { OcppSecurityProfile, OcppTlsOptions };

export interface BasicAuthSettings {
  username: string;
  password: string;
}

export class OcppSecurityProfileConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcppSecurityProfileConfigError";
  }
}

export function isBrowserRuntime(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined"
  );
}

/**
 * The socket {@link openOcppWebSocket} returns. `ping()` sends a WebSocket
 * ping frame (#406) — on Bun's native client and the `ws` package; the
 * browser `WebSocket` API has no way to send one, so there it does nothing.
 */
export type OcppSocket = WebSocket & {
  ping(): void;
  /**
   * The self-signed root, as PEM, that ended the CSMS certificate chain of
   * this open `wss://` connection (#563). Only the Node `ws` client can read
   * the chain; Bun's native client and the browser cannot, and answer
   * `undefined`.
   */
  validatingRootPem?(): string | undefined;
};

export function buildOcppWebSocketUrl(params: {
  baseUrl: string;
  chargePointId: string;
  basicAuth: BasicAuthSettings | null;
  securityProfile?: OcppSecurityProfile;
  warn?: (message: string) => void;
}): string {
  const url = new URL(params.baseUrl);
  // #277: a security profile only ever *upgrades* the transport. Profiles 2/3
  // mandate TLS (A00.FR.301+), so a `ws://` URL is promoted to `wss://` and
  // the operator is told. Profile 1 (A00.FR.201–207) says nothing about the
  // transport — A00.FR.206 even recommends carrying Basic Auth over a channel
  // secured by other means — so the configured scheme is authoritative. Before
  // #277 profile 1 silently rewrote `wss://` to `ws://`, which sent the
  // AuthorizationKey in cleartext to a TLS-terminating edge listening on :443.
  switch (params.securityProfile) {
    case 2:
    case 3:
      if (url.protocol === "ws:") {
        url.protocol = "wss:";
        params.warn?.(
          `Security profile ${params.securityProfile} requires TLS: ` +
            `connecting with wss:// instead of the configured ws:// URL.`,
        );
      }
      break;
    case 1:
      if (url.protocol === "ws:") {
        params.warn?.(
          "Security profile 1 over ws://: the AuthorizationKey is sent as " +
            "cleartext HTTP Basic credentials. Use wss:// on any network " +
            "you do not fully trust.",
        );
      }
      break;
    case 0:
    case undefined:
      break;
  }
  if (isBrowserRuntime() && params.basicAuth?.password) {
    url.searchParams.set(
      OCPP_BROWSER_WS_SECRET_QUERY_PARAM,
      params.basicAuth.password,
    );
  }
  // OCPP-J 1.6 §3.1.1: the identity is appended to the endpoint URL and "has
  // to be percent-encoded as necessary as described in [RFC3986]". The `/`
  // between endpoint and identity belongs here, so every caller (CLI, daemon,
  // web console) gets the same URL whether or not its endpoint ends in `/`.
  // encodeURIComponent keeps an identity containing `/`, `%`, `?` or `#` in one
  // path segment; the URL parser would leave a `/` as a separator and a `%`
  // raw. The Basic Auth username stays the unencoded identity.
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.pathname += encodeURIComponent(params.chargePointId);
  return url.toString();
}

/**
 * Derive the HTTP Basic Auth password from a configured `AuthorizationKey`
 * (OCPP 1.6 Security Whitepaper / OCTT TC_085_CS). The whitepaper stores the
 * key in one of two shapes, and the value that goes on the wire is the
 * **non-hex** form:
 *
 * - **32–40 chars** ⇒ hex representation of a 16–20 byte password. Decode the
 *   hex to those bytes before base64-ing `cpId:password`.
 * - **16–20 chars** ⇒ already plaintext UTF-8; use as-is.
 *
 * Any other shape is returned unchanged — best effort. The CLI enforces
 * hex-ness (but not length), while daemon/browser configs are not
 * length-validated, so a value outside both ranges is passed through rather
 * than guessed at. Only the AuthorizationKey copy served over OCPP
 * (Get/ChangeConfiguration) keeps the hex form; this transform applies solely
 * to the Basic credential.
 */
export function authorizationKeyToBasicPassword(
  authorizationKey: string,
): string {
  const isEvenLengthHex =
    /^[0-9a-fA-F]+$/.test(authorizationKey) &&
    authorizationKey.length % 2 === 0;
  if (
    isEvenLengthHex &&
    authorizationKey.length >= 32 &&
    authorizationKey.length <= 40
  ) {
    let decoded = "";
    for (let i = 0; i < authorizationKey.length; i += 2) {
      decoded += String.fromCharCode(
        parseInt(authorizationKey.slice(i, i + 2), 16),
      );
    }
    return decoded;
  }
  return authorizationKey;
}

export function buildOcppBasicAuthorization(
  basicAuth: BasicAuthSettings,
): string {
  return `Basic ${btoa(`${basicAuth.username}:${basicAuth.password}`)}`;
}

// Bun/Node `ws` accept `{ protocols, headers }` as the 2nd arg, but the DOM
// lib's WebSocket constructor does not. The whole module compiles under both
// tsconfigs (CLI=bun-types, app=DOM), so cast through a local type.
type WebSocketWithHeaders = new (
  url: string,
  options: {
    protocols?: string | string[];
    headers?: Record<string, string>;
    tls?: OcppTlsOptions;
    perMessageDeflate?: boolean;
    proxy?: string;
  },
) => WebSocket;

export interface OcppWebSocketConnectOptions {
  readonly url: string;
  readonly protocols: ReadonlyArray<string>;
  readonly headers: Record<string, string>;
  readonly tls?: OcppTlsOptions;
  /** #611: the client options the runtime must honour at the handshake. */
  readonly ws?: WsClientOptions;
  readonly useNodeWsFallback: boolean;
}

export function isBunRuntime(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
  );
}

function isNodeRuntime(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { process?: { versions?: { node?: string } } })
      .process?.versions?.node === "string"
  );
}

/** Which mechanism currently governs Basic Auth for a charge point. */
export type BasicAuthSource = "security-profile" | "legacy" | "none";

/**
 * #178 item F — single source of truth for Basic Auth.
 *
 * Before this change, a charge point could carry Basic Auth credentials in
 * two independent places: the legacy Optional-Settings toggle
 * (`basicAuthEnabled`/`Username`/`Password`) and the 1.6+ Security Profile
 * (`securityProfile` + `authorizationKey`). Both were read here, with
 * Security Profile 1/2 always winning and profile 0/undefined falling back
 * to the legacy fields.
 *
 * This classifier makes that precedence explicit and reusable outside the
 * connect path (the ChargePointConfigModal UI uses it to decide what to
 * tell the operator), without ever needing the plaintext password — it's a
 * shape classification, not a value transformation.
 *
 * `securityProfile` 0/undefined intentionally still defers to the legacy
 * flag rather than being auto-promoted to profile 1: OCPP's security-profile
 * model forces the wire username to the charge point id, which a legacy
 * config's custom username may not match, so an automatic promotion would
 * silently change on-wire identity (and could brick a saved config whose
 * daemon-side `authorizationKey` was never set). This fallback is what
 * keeps a config saved before #178 authenticating unchanged — it is the
 * "migration": legacy configs keep working via the same single resolver
 * every other config goes through, forever, without needing their stored
 * shape rewritten. Operators can opt into an explicit profile-1 conversion
 * themselves via the Security Profile selector.
 */
export function classifyBasicAuthSource(params: {
  readonly securityProfile?: OcppSecurityProfile;
  readonly legacyBasicAuthEnabled: boolean;
}): BasicAuthSource {
  if (params.securityProfile === 1 || params.securityProfile === 2) {
    return "security-profile";
  }
  if (params.securityProfile === 3) return "none";
  return params.legacyBasicAuthEnabled ? "legacy" : "none";
}

function resolveBasicAuth(params: {
  chargePointId: string;
  basicAuth: BasicAuthSettings | null;
  securityProfile?: OcppSecurityProfile;
  authorizationKey?: string;
  ocppVersion?: string;
}): BasicAuthSettings | null {
  const source = classifyBasicAuthSource({
    securityProfile: params.securityProfile,
    legacyBasicAuthEnabled: params.basicAuth !== null,
  });
  if (source === "none") return null;
  if (source === "security-profile") {
    if (!params.authorizationKey) {
      throw new OcppSecurityProfileConfigError(
        `OCPP security profile ${params.securityProfile} requires ` +
          "authorizationKey to derive HTTP Basic Auth.",
      );
    }
    return {
      username: params.chargePointId,
      // #260: the 1.6 AuthorizationKey is stored hex; the Basic header
      // carries its decoded (non-hex) form per TC_085_CS. On 2.x the key is
      // SecurityCtrlr.BasicAuthPassword and goes on the wire as-is (#704).
      password: isOcpp2Version(params.ocppVersion ?? "")
        ? params.authorizationKey
        : authorizationKeyToBasicPassword(params.authorizationKey),
    };
  }
  return params.basicAuth; // "legacy"
}

function stripAuthorizationHeader(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) => key.toLowerCase() !== "authorization",
    ),
  );
}

function normalizeTlsOptions(
  tls: OcppTlsOptions | undefined,
  securityProfile: OcppSecurityProfile | undefined,
  warn: ((message: string) => void) | undefined,
): OcppTlsOptions | undefined {
  if (!tls && securityProfile !== 2 && securityProfile !== 3) return undefined;
  const normalized: OcppTlsOptions = {
    ...(tls ?? {}),
    rejectUnauthorized: tls?.rejectUnauthorized ?? true,
  };
  if (normalized.rejectUnauthorized === false) {
    warn?.(
      "TLS server certificate verification is disabled by explicit override; use only in local development.",
    );
  }
  return normalized;
}

export function buildOcppWebSocketConnectOptions(params: {
  baseUrl: string;
  chargePointId: string;
  basicAuth: BasicAuthSettings | null;
  extraHeaders?: Record<string, string>;
  extraSubprotocols?: ReadonlyArray<string>;
  ocppVersion?: string;
  securityProfile?: OcppSecurityProfile;
  authorizationKey?: string;
  tls?: OcppTlsOptions;
  ws?: WsClientOptions;
  warn?: (message: string) => void;
}): OcppWebSocketConnectOptions {
  const basicAuth = resolveBasicAuth(params);
  const url = buildOcppWebSocketUrl({
    baseUrl: params.baseUrl,
    chargePointId: params.chargePointId,
    basicAuth,
    securityProfile: params.securityProfile,
    warn: params.warn,
  });
  const versionProtocol = ocppVersionToSubprotocol(params.ocppVersion ?? "");
  const protocols = [
    versionProtocol,
    ...(params.extraSubprotocols ?? []),
  ] as const;
  const mustControlAuthorization =
    params.securityProfile === 1 ||
    params.securityProfile === 2 ||
    params.securityProfile === 3;
  const headers: Record<string, string> = mustControlAuthorization
    ? stripAuthorizationHeader(params.extraHeaders ?? {})
    : { ...(params.extraHeaders ?? {}) };
  if (!isBrowserRuntime() && basicAuth?.password) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "authorization") delete headers[key];
    }
    headers.Authorization = buildOcppBasicAuthorization(basicAuth);
  }
  const tls = normalizeTlsOptions(
    params.tls,
    params.securityProfile,
    params.warn,
  );

  return {
    url,
    protocols,
    headers,
    tls,
    ...(params.ws ? { ws: params.ws } : {}),
    useNodeWsFallback:
      isNodeRuntime() && !isBunRuntime() && !isBrowserRuntime(),
  };
}

/**
 * #288 — why the CSMS refused the upgrade, when the client will not say.
 *
 * A rejected WebSocket upgrade has one symptom and several causes: the station
 * is not registered (404), the credentials or the security profile were not
 * accepted (401), or a TLS-terminating edge answered a cleartext connection
 * with a redirect (301 + Location). Deciding between them is the difference
 * between declaring a station, fixing a password and fixing a URL scheme.
 *
 * The HTTP status is available to the `ws` client, which surfaces it through
 * `unexpected-response`. It is NOT available under Bun's native WebSocket —
 * Bun 1.4.3 closes all three with `code=1002, Expected 101 status code`; 1.4.4
 * with a blank 1006 after an error whose message alone quotes the status, and
 * neither gives the redirect target (#1033). The daemon runs under Bun.
 *
 * So it is fetched: after a refused handshake, one GET to the same URL with
 * the same headers the upgrade carried. Bun's `fetch` forwards `Upgrade`,
 * `Connection`, `Sec-WebSocket-Key/Version/Protocol` and `Authorization`
 * unchanged (measured), so the server answers the request it just refused
 * rather than a different one.
 *
 * `redirect: "manual"`, always: a 3xx is the answer, and following it would
 * send the station's Basic credentials to whatever host `Location` names.
 *
 * Returns null when the probe cannot conclude — it never turns a diagnostic
 * into a failure of its own.
 */
export interface UpgradeRefusalDetail {
  readonly status: number;
  readonly location?: string;
}

/**
 * How long the diagnostic may take before it is abandoned. A CSMS or proxy
 * that accepts the request and never answers would otherwise leave the fetch
 * pending forever, and the once-a-minute throttle only limits how often a new
 * one starts -- it would not stop them accumulating. A diagnostic that has
 * not answered in ten seconds has already lost its value.
 */
const REFUSAL_PROBE_TIMEOUT_MS = 10_000;

export async function probeUpgradeRefusal(
  options: OcppWebSocketConnectOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<UpgradeRefusalDetail | null> {
  // The browser cannot do this: it may set neither the headers nor read a
  // cross-origin status, and local mode does not talk to real CSMS anyway.
  if (isBrowserRuntime()) return null;
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    return null;
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  // `ws://user:password@host` is a supported way to carry Basic credentials,
  // and `fetch` silently DROPS userinfo rather than sending it (measured: the
  // server sees no Authorization header). Probing without them would ask a
  // different question and answer 401 for the wrong reason, so they are moved
  // into the header the handshake would have sent. An Authorization the
  // caller already set wins -- that is the one the socket used.
  const userinfo =
    url.username || url.password
      ? btoa(
          `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
        )
      : null;
  url.username = "";
  url.password = "";
  const hasAuthorization = Object.keys(options.headers).some(
    (key) => key.toLowerCase() === "authorization",
  );
  const headers: Record<string, string> = {
    ...(userinfo && !hasAuthorization
      ? { Authorization: `Basic ${userinfo}` }
      : {}),
    ...options.headers,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Version": "13",
    // A fresh key: the value is never checked by a server that refuses, and
    // reusing the socket's would mean threading it out of the client.
    "Sec-WebSocket-Key": btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    ),
  };
  if (options.protocols.length > 0) {
    headers["Sec-WebSocket-Protocol"] = options.protocols.join(", ");
  }
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(REFUSAL_PROBE_TIMEOUT_MS),
      // Same trust decisions as the handshake: a private-CA station whose
      // probe verified against the public roots would report a lie.
      ...(options.tls ? { tls: options.tls } : {}),
      // #611: through the same proxy, or the probe would answer for a path
      // the handshake did not take (Bun's fetch honours `proxy`).
      ...(options.ws?.proxy ? { proxy: options.ws.proxy } : {}),
    } as RequestInit);
    const location = response.headers.get("location");
    return {
      status: response.status,
      ...(location ? { location } : {}),
    };
  } catch {
    return null;
  }
}

/** The options Bun's native client takes in its constructor (#611). */
function bunOnlyOptions(
  ws: WsClientOptions | undefined,
): { perMessageDeflate?: boolean; proxy?: string } | undefined {
  if (!ws || (ws.perMessageDeflate === undefined && ws.proxy === undefined)) {
    return undefined;
  }
  return {
    ...(ws.perMessageDeflate !== undefined
      ? { perMessageDeflate: ws.perMessageDeflate }
      : {}),
    ...(ws.proxy !== undefined ? { proxy: ws.proxy } : {}),
  };
}

export function openOcppWebSocket(params: {
  baseUrl: string;
  chargePointId: string;
  basicAuth: BasicAuthSettings | null;
  /** Extra raw HTTP headers attached to the WebSocket upgrade request.
   *  Only emitted when running in the Bun/Node CLI runtime — the DOM
   *  WebSocket constructor doesn't accept headers. Useful for driving a
   *  header-routing proxy in front of the CSMS. */
  extraHeaders?: Record<string, string>;
  /** Extra Sec-WebSocket-Protocol tokens appended to the OCPP version
   *  subprotocol. OCPP servers pick the first recognised version token
   *  and ignore the rest, so extras are safe to add and become visible
   *  to upstream routers that match on subprotocol. */
  extraSubprotocols?: ReadonlyArray<string>;
  /** OCPP version string (e.g. "OCPP-1.6J", "OCPP-2.0.1"). Defaults to 1.6. */
  ocppVersion?: string;
  securityProfile?: OcppSecurityProfile;
  authorizationKey?: string;
  cpoName?: string;
  tls?: OcppTlsOptions;
  /** #611: handshake/compression/payload/proxy/local-address options. The
   *  caller has already checked the runtime supports them. */
  ws?: WsClientOptions;
  warn?: (message: string) => void;
  /** #288: hands back the options this handshake is about to use, so a later
   *  refusal probe replays the same request instead of a reconstruction of it. */
  onConnectOptions?: (options: OcppWebSocketConnectOptions) => void;
  onopen?: ((event: Event) => void) | null;
  onmessage?: ((event: MessageEvent) => void) | null;
  onerror?: ((event: Event) => void) | null;
  onclose?: ((event: CloseEvent) => void) | null;
}): OcppSocket {
  const connectOptions = buildOcppWebSocketConnectOptions(params);
  params.onConnectOptions?.(connectOptions);
  const hasHeaders = Object.keys(connectOptions.headers).length > 0;
  const handlers: OcppWebSocketEventHandlers = {
    onopen: params.onopen,
    onmessage: params.onmessage,
    onerror: params.onerror,
    onclose: params.onclose,
  };
  if (connectOptions.useNodeWsFallback) {
    return new DeferredNodeWebSocket(
      connectOptions.url,
      connectOptions.protocols,
      connectOptions.headers,
      connectOptions.tls,
      handlers,
      connectOptions.ws,
    ) as unknown as OcppSocket;
  }
  const bunOptions = bunOnlyOptions(connectOptions.ws);
  if (!isBrowserRuntime() && (hasHeaders || connectOptions.tls || bunOptions)) {
    return new BufferedErrorWebSocket(
      new (WebSocket as unknown as WebSocketWithHeaders)(connectOptions.url, {
        protocols: [...connectOptions.protocols],
        ...(hasHeaders ? { headers: connectOptions.headers } : {}),
        ...(connectOptions.tls ? { tls: connectOptions.tls } : {}),
        ...bunOptions,
      }),
      handlers,
    ) as unknown as OcppSocket;
  }
  return new BufferedErrorWebSocket(
    new WebSocket(connectOptions.url, [...connectOptions.protocols]),
    handlers,
  ) as unknown as OcppSocket;
}
