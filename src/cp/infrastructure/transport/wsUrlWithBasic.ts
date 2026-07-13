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
}): string {
  const url = new URL(params.baseUrl);
  switch (params.securityProfile) {
    case 1:
      url.protocol = "ws:";
      break;
    case 2:
    case 3:
      url.protocol = "wss:";
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

interface NodeWsLike {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number, reason: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
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
      password: params.authorizationKey,
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
        this.state = WebSocket.CLOSING;
        this.dispatchError({
          type: "error",
          error,
          message: error.message,
        } as unknown as Event);
      });
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
        this.onclose?.({
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
  onopen?: ((event: Event) => void) | null;
  onmessage?: ((event: MessageEvent) => void) | null;
  onerror?: ((event: Event) => void) | null;
  onclose?: ((event: CloseEvent) => void) | null;
}): WebSocket {
  const connectOptions = buildOcppWebSocketConnectOptions(params);
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
