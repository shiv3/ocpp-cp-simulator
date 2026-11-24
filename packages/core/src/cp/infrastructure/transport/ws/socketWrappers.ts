/**
 * The two WebSocket wrappers `openOcppWebSocket` returns (buffered-error
 * wrapper around the native client, deferred Node `ws` client) and the Node
 * `ws` shapes they use. Moved verbatim from `wsUrlWithBasic.ts` (#877).
 */
import type { WsClientOptions } from "../../../shared/WsClientOptions";
import type { OcppTlsOptions } from "../../../domain/transport/ConnectionSecurity";
import { peerChainRootPem, type PeerCertificateLike } from "./peerCertificate";

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
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  readonly readyState: number;
  /** The subprotocol the server agreed to; "" before the socket opens. */
  readonly protocol?: string;
  /** The TLS socket of a `wss://` connection, once it is open. */
  readonly _socket?: {
    getPeerCertificate?(detailed: boolean): PeerCertificateLike;
  };
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
    perMessageDeflate?: boolean;
    maxPayload?: number;
    localAddress?: string;
  },
) => NodeWsLike;

type OcppEventListener = EventListener | EventListenerObject;

export interface OcppWebSocketEventHandlers {
  readonly onopen?: ((event: Event) => void) | null;
  readonly onmessage?: ((event: MessageEvent) => void) | null;
  readonly onerror?: ((event: Event) => void) | null;
  readonly onclose?: ((event: CloseEvent) => void) | null;
}

export class BufferedErrorWebSocket {
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

  /** Bun's client `WebSocket` sends a ping frame; the DOM one has no `ping`. */
  ping(): void {
    (this.socket as WebSocket & { ping?: () => void }).ping?.();
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

export class DeferredNodeWebSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private socket: NodeWsLike | null = null;
  private state: number = WebSocket.CONNECTING;
  private pendingClose: { code?: number; reason?: string } | null = null;
  private errorHandler: ((event: Event) => void) | null = null;
  private pendingErrors: Event[] = [];
  /** Why the connection could not be made, as the close should report it. */
  private connectFailure = "";
  /** A refused handshake is closed by us; ws may still close later. */
  private closeDispatched = false;
  /** Set once a non-101 response has been reported and the socket torn down. */
  private refusalHandled = false;
  /** The root that ended the server's chain, read when the socket opens. */
  private rootPem: string | undefined;

  constructor(
    url: string,
    protocols: ReadonlyArray<string>,
    headers: Record<string, string>,
    tls: OcppTlsOptions | undefined,
    handlers: OcppWebSocketEventHandlers = {},
    wsOptions: WsClientOptions | undefined = undefined,
  ) {
    this.onopen = handlers.onopen ?? null;
    this.onmessage = handlers.onmessage ?? null;
    this.onerror = handlers.onerror ?? null;
    this.onclose = handlers.onclose ?? null;
    void this.connect(url, protocols, headers, tls, wsOptions);
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

  /** The agreed subprotocol, as the native client reports it (#1132). */
  get protocol(): string {
    return this.socket?.protocol ?? "";
  }

  send(data: string): void {
    this.socket?.send(data);
  }

  ping(): void {
    this.socket?.ping();
  }

  validatingRootPem(): string | undefined {
    return this.rootPem;
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
    wsOptions: WsClientOptions | undefined,
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
        // #611: `ws` honours all three (measured); the proxy it cannot.
        ...(wsOptions?.perMessageDeflate !== undefined
          ? { perMessageDeflate: wsOptions.perMessageDeflate }
          : {}),
        ...(wsOptions?.maxPayloadBytes !== undefined
          ? { maxPayload: wsOptions.maxPayloadBytes }
          : {}),
        ...(wsOptions?.localAddress !== undefined
          ? { localAddress: wsOptions.localAddress }
          : {}),
      });
      socket.on("error", (error) => {
        // Once a refusal has been reported and terminated, ws's follow-up
        // error is about our own teardown, not about the CSMS.
        if (this.refusalHandled) return;
        this.state = WebSocket.CLOSING;
        // `ws` closes with 1006 and no reason. A failure of the connect or
        // the DNS lookup gets the reason Bun's client gives it, so everything
        // downstream sees one shape (see `neverReachedCsms`).
        const { syscall } = error as NodeJS.ErrnoException;
        if (syscall === "connect" || syscall === "getaddrinfo") {
          this.connectFailure = `Failed to connect: ${error.message}`;
        }
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
          // 1002 to match what Bun 1.4.3 reports for the same refusal; the
          // `httpStatus` above is what classifies it (closeClassification).
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
        try {
          this.rootPem = peerChainRootPem(
            socket._socket?.getPeerCertificate?.(true),
          );
        } catch {
          this.rootPem = undefined;
        }
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
          reason: reasonText || this.connectFailure,
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
