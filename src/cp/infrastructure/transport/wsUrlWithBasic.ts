/**
 * Browser WebSocket cannot set an `Authorization: Basic` header, so when this
 * module is loaded in a browser we fall back to a URL query parameter that
 * many CSMS implementations accept (e.g. `ocpp_ws_secret`). CLI runtimes (Bun
 * / Node `ws`) send the credentials as a real HTTP Basic header instead.
 */
import {
  OCPP_WEBSOCKET_PROTOCOL_16,
  OCPP_WEBSOCKET_PROTOCOL_201,
  ocppVersionToSubprotocol,
} from "./profile/subprotocols";

export {
  OCPP_WEBSOCKET_PROTOCOL_16,
  OCPP_WEBSOCKET_PROTOCOL_201,
  ocppVersionToSubprotocol,
};

export const OCPP_BROWSER_WS_SECRET_QUERY_PARAM = "ocpp_ws_secret";

export type OcppSecurityProfile = 0 | 1 | 2 | 3;

export interface OcppTlsOptions {
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
  readonly rejectUnauthorized?: boolean;
  readonly serverName?: string;
}

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
  url.pathname += params.chargePointId;
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
  },
) => WebSocket;

/** The `http.IncomingMessage` shape `ws` hands to `unexpected-response`. */
interface NodeIncomingMessageLike {
  readonly statusCode?: number;
  readonly headers?: Record<string, string | undefined>;
}

interface NodeWsLike {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number, reason: unknown) => void): void;
  on(
    event: "unexpected-response",
    listener: (request: unknown, response: NodeIncomingMessageLike) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  readonly readyState: number;
}

type NodeWsConstructor = new (
  url: string,
  protocols: string | string[],
  options: {
    headers?: Record<string, string>;
    ca?: string;
    cert?: string;
    key?: string;
    rejectUnauthorized?: boolean;
    servername?: string;
  },
) => NodeWsLike;

type OcppEventListener = EventListener | EventListenerObject;

interface OcppWebSocketEventHandlers {
  readonly onopen?: ((event: Event) => void) | null;
  readonly onmessage?: ((event: MessageEvent) => void) | null;
  readonly onerror?: ((event: Event) => void) | null;
  readonly onclose?: ((event: CloseEvent) => void) | null;
}

export interface OcppWebSocketConnectOptions {
  readonly url: string;
  readonly protocols: ReadonlyArray<string>;
  readonly headers: Record<string, string>;
  readonly tls?: OcppTlsOptions;
  readonly useNodeWsFallback: boolean;
}

function isBunRuntime(): boolean {
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
      // #260: the AuthorizationKey is stored hex; the Basic header carries its
      // decoded (non-hex) form per TC_085_CS.
      password: authorizationKeyToBasicPassword(params.authorizationKey),
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
 * measured on Bun 1.4: every one of those three cases produces exactly
 * `code=1002, reason=Expected 101 status code` and an error event whose only
 * own property is `isTrusted`. Since the daemon and the published image run
 * under Bun, the status simply does not exist on the path that matters.
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
  const headers: Record<string, string> = {
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
      // Same trust decisions as the handshake: a private-CA station whose
      // probe verified against the public roots would report a lie.
      ...(options.tls ? { tls: options.tls } : {}),
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

class BufferedErrorWebSocket {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  private errorHandler: ((event: Event) => void) | null;
  private pendingErrors: Event[] = [];

  constructor(
    private readonly socket: WebSocket,
    handlers: OcppWebSocketEventHandlers = {},
  ) {
    this.onopen = handlers.onopen ?? null;
    this.onmessage = handlers.onmessage ?? null;
    this.onclose = handlers.onclose ?? null;
    this.errorHandler = handlers.onerror ?? null;

    socket.addEventListener("open", (event) => {
      this.onopen?.(event);
    });
    socket.addEventListener("message", (event) => {
      this.onmessage?.(event);
    });
    socket.addEventListener("error", (event) => {
      this.dispatchError(event);
    });
    socket.addEventListener("close", (event) => {
      this.onclose?.(event);
    });
  }

  get onerror(): ((event: Event) => void) | null {
    return this.errorHandler;
  }

  set onerror(handler: ((event: Event) => void) | null) {
    this.errorHandler = handler;
    if (!handler || this.pendingErrors.length === 0) return;

    const pendingErrors = this.pendingErrors;
    this.pendingErrors = [];
    for (const event of pendingErrors) {
      handler(event);
    }
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  get url(): string {
    return this.socket.url;
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  get extensions(): string {
    return this.socket.extensions;
  }

  get binaryType(): WebSocket["binaryType"] {
    return this.socket.binaryType;
  }

  set binaryType(value: WebSocket["binaryType"]) {
    this.socket.binaryType = value;
  }

  send(data: Parameters<WebSocket["send"]>[0]): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  addEventListener(
    type: string,
    listener: OcppEventListener | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (!listener) return;
    this.socket.addEventListener(type, listener, options);
  }

  removeEventListener(
    type: string,
    listener: OcppEventListener | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (!listener) return;
    this.socket.removeEventListener(type, listener, options);
  }

  dispatchEvent(event: Event): boolean {
    return this.socket.dispatchEvent(event);
  }

  private dispatchError(event: Event): void {
    if (!this.errorHandler) {
      this.pendingErrors.push(event);
      return;
    }
    this.errorHandler(event);
  }
}

class DeferredNodeWebSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private socket: NodeWsLike | null = null;
  private state: number = WebSocket.CONNECTING;
  private pendingClose: { code?: number; reason?: string } | null = null;
  private errorHandler: ((event: Event) => void) | null = null;
  private pendingErrors: Event[] = [];
  /** A refused handshake is closed by us; ws may still close later. */
  private closeDispatched = false;
  /** Set once a non-101 response has been reported and the socket torn down. */
  private refusalHandled = false;

  constructor(
    url: string,
    protocols: ReadonlyArray<string>,
    headers: Record<string, string>,
    tls: OcppTlsOptions | undefined,
    handlers: OcppWebSocketEventHandlers = {},
  ) {
    this.onopen = handlers.onopen ?? null;
    this.onmessage = handlers.onmessage ?? null;
    this.onerror = handlers.onerror ?? null;
    this.onclose = handlers.onclose ?? null;
    void this.connect(url, protocols, headers, tls);
  }

  get onerror(): ((event: Event) => void) | null {
    return this.errorHandler;
  }

  set onerror(handler: ((event: Event) => void) | null) {
    this.errorHandler = handler;
    if (!handler || this.pendingErrors.length === 0) return;

    const pendingErrors = this.pendingErrors;
    this.pendingErrors = [];
    for (const event of pendingErrors) {
      handler(event);
    }
  }

  get readyState(): number {
    return this.socket?.readyState ?? this.state;
  }

  send(data: string): void {
    this.socket?.send(data);
  }

  close(code?: number, reason?: string): void {
    if (this.socket) {
      this.socket.close(code, reason);
      return;
    }
    this.pendingClose = { code, reason };
    this.state = WebSocket.CLOSING;
  }

  private async connect(
    url: string,
    protocols: ReadonlyArray<string>,
    headers: Record<string, string>,
    tls: OcppTlsOptions | undefined,
  ): Promise<void> {
    try {
      const wsModule = (await import(/* @vite-ignore */ "ws")) as unknown as {
        WebSocket?: NodeWsConstructor;
        default?: NodeWsConstructor;
      };
      const NodeWebSocket = wsModule.WebSocket ?? wsModule.default;
      if (!NodeWebSocket) {
        throw new Error("ws WebSocket export not found");
      }
      const socket = new NodeWebSocket(url, [...protocols], {
        headers,
        ...(tls?.ca !== undefined ? { ca: tls.ca } : {}),
        ...(tls?.cert !== undefined ? { cert: tls.cert } : {}),
        ...(tls?.key !== undefined ? { key: tls.key } : {}),
        ...(tls?.rejectUnauthorized !== undefined
          ? { rejectUnauthorized: tls.rejectUnauthorized }
          : {}),
        ...(tls?.serverName !== undefined
          ? { servername: tls.serverName }
          : {}),
      });
      socket.on("error", (error) => {
        // Once a refusal has been reported and terminated, ws's follow-up
        // error is about our own teardown, not about the CSMS.
        if (this.refusalHandled) return;
        this.state = WebSocket.CLOSING;
        this.dispatchError({
          type: "error",
          error,
          message: error.message,
        } as unknown as Event);
      });
      // #288: on a non-101 response `ws` hands over the whole HTTP reply
      // before it errors. Forward the status (and a redirect's target) so the
      // Node path names the cause without needing the probe that the Bun path
      // has to make. `ws`'s own error message is "Unexpected server response:
      // 401", which carries the status but not the Location.
      //
      // ATTACHING THIS LISTENER TAKES OWNERSHIP OF THE FAILED HANDSHAKE.
      // Verified against ws directly: with a listener attached, only this
      // event fires -- no `error`, no `close`, and readyState stays
      // CONNECTING; without one, ws emits `error` + `close(1006)` itself. So
      // the socket has to be finished here, or the reconnect loop never
      // starts and connect() hangs to its 30 s timeout.
      socket.on(
        "unexpected-response",
        (request: unknown, response: NodeIncomingMessageLike) => {
          const location = response.headers?.location;
          this.dispatchError({
            type: "error",
            message: `Unexpected server response: ${response.statusCode}`,
            httpStatus: response.statusCode,
            ...(location ? { httpLocation: location } : {}),
          } as unknown as Event);
          // terminate() is what actually ends it: destroying the request
          // alone leaves ws reporting CONNECTING (measured), and this
          // wrapper's readyState reads through to ws. It costs one extra
          // "closed before the connection was established" error from ws,
          // which `refusalHandled` swallows -- the status above is the line
          // worth reading.
          this.refusalHandled = true;
          void request;
          socket.terminate();
          this.state = WebSocket.CLOSED;
          // 1002 to match what the Bun client reports for the same refusal,
          // so everything downstream sees one shape.
          this.dispatchCloseOnce({
            type: "close",
            code: 1002,
            reason: `Unexpected server response: ${response.statusCode}`,
            wasClean: false,
          } as CloseEvent);
        },
      );
      this.socket = socket;
      if (this.pendingClose) {
        socket.close(this.pendingClose.code, this.pendingClose.reason);
      }
      socket.on("open", () => {
        this.state = WebSocket.OPEN;
        this.onopen?.({ type: "open" } as Event);
      });
      socket.on("message", (data) => {
        this.onmessage?.({ type: "message", data } as MessageEvent);
      });
      socket.on("close", (code, reason) => {
        this.state = WebSocket.CLOSED;
        const reasonText =
          typeof reason === "string"
            ? reason
            : reason instanceof Uint8Array
              ? new TextDecoder().decode(reason)
              : "";
        this.dispatchCloseOnce({
          type: "close",
          code,
          reason: reasonText,
          wasClean: code === 1000,
        } as CloseEvent);
      });
    } catch (error) {
      this.state = WebSocket.CLOSED;
      const err =
        error instanceof Error ? error : new Error(String(error ?? "error"));
      this.dispatchError({
        type: "error",
        error: err,
        message: err.message,
      } as unknown as Event);
      this.onclose?.({
        type: "close",
        code: 1006,
        reason: err.message,
        wasClean: false,
      } as CloseEvent);
    }
  }

  private dispatchError(event: Event): void {
    if (!this.errorHandler) {
      this.pendingErrors.push(event);
      return;
    }
    this.errorHandler(event);
  }

  /** Exactly one close reaches the consumer, whoever noticed first. */
  private dispatchCloseOnce(event: CloseEvent): void {
    if (this.closeDispatched) return;
    this.closeDispatched = true;
    this.onclose?.(event);
  }
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
  warn?: (message: string) => void;
  /** #288: hands back the options this handshake is about to use, so a later
   *  refusal probe replays the same request instead of a reconstruction of it. */
  onConnectOptions?: (options: OcppWebSocketConnectOptions) => void;
  onopen?: ((event: Event) => void) | null;
  onmessage?: ((event: MessageEvent) => void) | null;
  onerror?: ((event: Event) => void) | null;
  onclose?: ((event: CloseEvent) => void) | null;
}): WebSocket {
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
    ) as unknown as WebSocket;
  }
  if (!isBrowserRuntime() && (hasHeaders || connectOptions.tls)) {
    return new BufferedErrorWebSocket(
      new (WebSocket as unknown as WebSocketWithHeaders)(connectOptions.url, {
        protocols: [...connectOptions.protocols],
        ...(hasHeaders ? { headers: connectOptions.headers } : {}),
        ...(connectOptions.tls ? { tls: connectOptions.tls } : {}),
      }),
      handlers,
    ) as unknown as WebSocket;
  }
  return new BufferedErrorWebSocket(
    new WebSocket(connectOptions.url, [...connectOptions.protocols]),
    handlers,
  ) as unknown as WebSocket;
}
