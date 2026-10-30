import { Logger, LogType } from "../../shared/Logger";
import { encodeCallFrame } from "./callFrame";
import { redactSensitiveText } from "../../shared/redaction";
import {
  isBrowserRuntime,
  openOcppWebSocket,
  probeUpgradeRefusal,
  type OcppSocket,
} from "./wsUrlWithBasic";
import type { SupervisionUrlPool } from "./SupervisionUrlPool";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
  OcppWebSocketConnectOptions,
} from "./wsUrlWithBasic";
import {
  OCPPAction,
  OCPPErrorCode,
  OCPPMessageType,
} from "../../domain/types/OcppTypes";
import type {
  AuthorizeRequestV16,
  BootNotificationRequestV16,
  CertificateSignedResponseV16,
  HeartbeatRequestV16,
  MeterValuesRequestV16,
  SecurityEventNotificationRequestV16,
  SignCertificateRequestV16,
  StartTransactionRequestV16,
  StatusNotificationRequestV16,
  StopTransactionRequestV16,
  ChangeConfigurationResponseV16,
  GetConfigurationResponseV16,
  GetDiagnosticsResponseV16,
  RemoteStartTransactionResponseV16,
  RemoteStopTransactionResponseV16,
  ResetResponseV16,
  TriggerMessageResponseV16,
  UnlockConnectorResponseV16,
} from "../../../ocpp";
import {
  NetworkSimController,
  type ControllerHost,
  type GenerationToken,
  type CloseCause,
  type Settlement,
  type ResolvedNetworkSimConfig,
  type DisconnectRuleType,
} from "./network-sim";
import type { NetworkFaultInjected } from "../../domain/charge-point/ChargePointEvents";
import { EventEmitter } from "../../shared/EventEmitter";

/** #448: what the transport reports to observers (the charge point). A
 *  throwing listener is caught by the emitter, never by the transport. */
export interface TransportObserverEvents {
  /** A network-sim disconnect rule fired; emitted before the close. */
  simulatedDisconnect: NetworkFaultInjected;
  /** A reconnect was scheduled; emitted once the close that caused it has
   *  been handed to the `onclose` callback. */
  reconnectScheduled: { attempt: number; delayMs: number };
  /** #393: the current generation ended, whatever the cause (a close, a
   *  disconnect, a reset, a simulated drop), or the transport was disposed.
   *  Emitted once per generation, before any replacement socket opens. */
  closed: { cause: CloseCause | "disposed" };
  /** #537 A02.FR.10: a connection opened with the previous client
   *  certificate while the renewed one was unconfirmed; the renewed one is
   *  discarded (A02.FR.29 reports it). */
  renewedClientCertificateDiscarded: Record<string, never>;
}

/**
 * #393: sees every well-shaped incoming frame (an array of 3 to 5 elements)
 * before the message handler. Returning true consumes it: the station's
 * domain handlers never see it.
 */
export type IncomingFrameInterceptor = (frame: unknown[]) => boolean;

export type OcppMessagePayload =
  | OcppMessageRequestPayload
  | OcppMessageResponsePayload
  | OcppMessageErrorPayload;

export type OcppMessageRequestPayload =
  | AuthorizeRequestV16
  | BootNotificationRequestV16
  | HeartbeatRequestV16
  | MeterValuesRequestV16
  | SecurityEventNotificationRequestV16
  | SignCertificateRequestV16
  | StartTransactionRequestV16
  | StatusNotificationRequestV16
  | StopTransactionRequestV16;

export type OcppMessageResponsePayload =
  | CertificateSignedResponseV16
  | ChangeConfigurationResponseV16
  | GetConfigurationResponseV16
  | GetDiagnosticsResponseV16
  | RemoteStartTransactionResponseV16
  | RemoteStopTransactionResponseV16
  | ResetResponseV16
  | TriggerMessageResponseV16
  | UnlockConnectorResponseV16;

export type OcppMessageErrorPayload = {
  readonly errorCode: OCPPErrorCode;
  readonly errorDescription: string;
  readonly errorDetails?: object;
};

type MessageHandler = (
  messageType: OCPPMessageType,
  messageId: string,
  action: OCPPAction,
  payload: OcppMessagePayload,
) => void;

/** What the charge point is told about a socket's close. */
export type SocketClose = Pick<CloseEvent, "code" | "reason">;

/** A TLS client certificate chain (PEM) and its private key (PEM). */
interface ClientIdentity {
  readonly cert: string;
  readonly key: string;
}

/**
 * Reported for a socket the charge point closed itself (reset, disconnect)
 * when the next connect supersedes it before its close event lands (#478).
 * `close()` sends no status code, so the late close event mostly reads 1005
 * as well.
 */
const SUPERSEDED_CLOSE: SocketClose = { code: 1005, reason: "" };

/**
 * GenerationTokenImpl: immutable per-generation object carrying the generation number
 * and, once closed, its latched close cause. First-cause latching: the first close
 * of a generation latches its cause; later close processing for that same generation
 * must NOT overwrite it.
 */
class GenerationTokenImpl implements GenerationToken {
  private _closeCause: CloseCause | null = null;
  /** The charge point has been told this generation's socket closed (#478). */
  closeReported = false;

  constructor(readonly gen: number) {}

  get closeCause(): CloseCause | null {
    return this._closeCause;
  }

  latchCloseCause(cause: CloseCause): void {
    if (this._closeCause === null) {
      this._closeCause = cause;
    }
  }
}

export class OCPPWebSocket {
  private _ws: OcppSocket | null = null;
  private _url: string;
  private _basicAuth: { username: string; password: string } | null = null;
  private _chargePointId: string;
  private _logger: Logger;
  private _messageHandler: MessageHandler | null = null;
  private _incomingInterceptor: IncomingFrameInterceptor | null = null;
  private _pingInterval: ReturnType<typeof setInterval> | null = null;
  /** #406: `WebSocketPingInterval` in seconds; 0 sends no client ping. */
  private _pingIntervalSeconds: number = 0;
  private _reconnectAttempts: number = 0;
  private _baseReconnectDelay: number = 1000; // 1 second base delay
  private _maxReconnectDelay: number = 30000; // 30 seconds max delay
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _onOpenCallback: (() => void) | null = null;
  private _onCloseCallback:
    ((ev: SocketClose, cause: CloseCause) => void) | null = null;
  private _isManualDisconnect: boolean = false;
  /**
   * Whether the close now in flight was asked for by this charge point.
   *
   * Distinct from `_isManualDisconnect`, which additionally means "do not
   * reconnect": `disconnectInternal()` (behind `ChargePoint.reset()`) and
   * `simulateConnectionLoss()` both close the socket *and* want the reconnect
   * loop to run, so they deliberately leave that flag false. Without a second
   * flag every reset and every injected disconnect would be counted as a
   * failure of the supervision URL in use — scattering an affinity fleet off
   * its assigned nodes because of something the fleet did to itself.
   */
  private _selfRequestedClose: boolean = false;
  /** #288: the options the current handshake used, replayed by the refusal
   *  probe so it asks the question the socket asked. */
  private _lastConnectOptions: OcppWebSocketConnectOptions | null = null;
  /** When the probe last ran, so a retry loop cannot multiply the CSMS's
   *  request rate. Cleared on a successful open. */
  private _lastRefusalProbeAt: number = 0;
  /** Set when the client itself reported the HTTP status (the `ws` path),
   *  so the probe does not ask a question already answered. */
  private _refusalStatusReported: boolean = false;
  // Extra HTTP headers + Sec-WebSocket-Protocol tokens attached on each
  // upgrade. Both are CLI-only — DOM WebSocket ignores extraHeaders, but
  // the runtime fallback in openOcppWebSocket handles that.
  private _extraHeaders: Record<string, string>;
  private _extraSubprotocols: ReadonlyArray<string>;
  private _ocppVersion: string;
  private _securityProfile?: OcppSecurityProfile;
  private _authorizationKey?: string;
  private _cpoName?: string;
  private _tls?: OcppTlsOptions;
  /**
   * #537 A02.FR.08: a renewed Charging Station certificate presented in
   * place of the configured `cert` / `key`. Memory-only. `confirmed` once a
   * connection presenting it opened; until then failed attempts alternate
   * between it and `fallback` (2.1 A02.FR.28 with B10.FR.08): the identity
   * in use before it, a previously confirmed renewal or, when absent, the
   * configured one.
   */
  private _renewedClientCertificate: {
    readonly cert: string;
    readonly key: string;
    readonly fallback?: ClientIdentity;
    confirmed: boolean;
    presentNext: boolean;
  } | null = null;

  // Network simulation
  private _controller: NetworkSimController;
  private _generationCounter: number = 0;
  private _currentGeneration: GenerationTokenImpl;
  /** Generation of the last socket opened; null before the first connect. */
  private _socketToken: GenerationTokenImpl | null = null;
  private _reconnectNotBefore: number | null = null;
  /**
   * Set when the charge point was given more than one supervision URL. The
   * pool decides which one each attempt uses; `_url` stays the one currently
   * in play, so everything that reports a URL keeps reporting a single string.
   */
  private _urlPool: SupervisionUrlPool | null = null;
  private _onCloseTransactionCallback:
    ((finalized: GenerationToken) => void) | null = null;
  readonly observers = new EventEmitter<TransportObserverEvents>();
  private _pendingReconnectNotice: { attempt: number; delayMs: number } | null =
    null;
  private _disposed: boolean = false;

  constructor(
    url: string,
    chargePointId: string,
    logger: Logger,
    basicAuthSettings: { username: string; password: string } | null = null,
    extraHeaders: Record<string, string> = {},
    extraSubprotocols: ReadonlyArray<string> = [],
    ocppVersion: string = "OCPP-1.6J",
    securityProfile?: OcppSecurityProfile,
    authorizationKey?: string,
    cpoName?: string,
    tls?: OcppTlsOptions,
  ) {
    this._url = url;
    this._chargePointId = chargePointId;
    this._ocppVersion = ocppVersion;
    this._logger = logger;
    if (basicAuthSettings) {
      this._basicAuth = {
        username: basicAuthSettings.username,
        password: basicAuthSettings.password,
      };
    }
    this._extraHeaders = extraHeaders;
    this._extraSubprotocols = extraSubprotocols;
    this._securityProfile = securityProfile;
    this._authorizationKey = authorizationKey;
    this._cpoName = cpoName;
    this._tls = tls;

    // Initialize network simulation controller and current generation
    this._currentGeneration = new GenerationTokenImpl(this._generationCounter);
    const controllerHost: ControllerHost = {
      writeUpstream: (raw: string) => this.writeUpstreamPhysical(raw),
      dispatchDownstream: (raw: string) => this.dispatchIncoming(raw),
      requestSimulatedDisconnect: (reconnectDelayMs, ruleId, ruleType) =>
        this.simulateConnectionLoss(reconnectDelayMs, ruleId, ruleType),
      log: (message: string) => this._logger.info(message, LogType.NETWORK_SIM),
    };
    this._controller = new NetworkSimController(controllerHost, chargePointId);
  }

  get url(): string {
    return this._url;
  }

  /**
   * Hand the socket a set of supervision URLs to choose between.
   *
   * A setter rather than a constructor parameter: the constructor already
   * carries eleven positional arguments, and a charge point with one URL —
   * every charge point until now — should not have to pass anything.
   */
  /**
   * The PEM bundle that validates the current CSMS connection: the
   * `--tls-ca` certificates of a `wss://` connection that verifies the
   * server (#537, 1.6 whitepaper M04.FR.06). `undefined` over `ws://`,
   * without `--tls-ca` (the runtime's own trust store then validates) or
   * with verification turned off.
   */
  public connectionTrustAnchorsPem(): string | undefined {
    if (!/^wss:/i.test(this._url)) return undefined;
    if (this._tls?.rejectUnauthorized === false) return undefined;
    return this._tls?.ca;
  }

  /** Whether the CSMS link authenticates with a client certificate
   *  (security profile 3), the one a renewed certificate replaces. */
  public usesClientCertificate(): boolean {
    return this._securityProfile === 3;
  }

  /**
   * #537 A02.FR.08: presents `identity` (a renewed Charging Station
   * certificate chain and its key) from the next connection on, instead of
   * the configured client certificate. The caller reconnects. Ignored
   * unless {@link usesClientCertificate}.
   */
  public useRenewedClientCertificate(identity: ClientIdentity): void {
    if (!this.usesClientCertificate()) return;
    const previous = this._renewedClientCertificate;
    // A02.FR.28: the fallback is the certificate in use, which is a
    // renewal confirmed earlier rather than the configured one.
    const fallback = previous?.confirmed
      ? { cert: previous.cert, key: previous.key }
      : previous?.fallback;
    this._renewedClientCertificate = {
      cert: identity.cert,
      key: identity.key,
      ...(fallback ? { fallback } : {}),
      confirmed: false,
      presentNext: true,
    };
  }

  /**
   * #537: forgets every renewed identity, confirmed or not, so the next
   * connection presents the configured `cert` / `key`. Called when the
   * certificate store no longer holds the key of its Charging Station
   * certificate (a chain replaced by one signed for a caller-supplied CSR,
   * or removed). The refusal probe's replay options lose the key too.
   */
  public clearRenewedClientCertificate(): void {
    this._renewedClientCertificate = null;
    if (this._lastConnectOptions) {
      this._lastConnectOptions = {
        ...this._lastConnectOptions,
        tls: this._tls,
      };
    }
  }

  /** The TLS options of the next attempt, and whether it presents the
   *  renewed certificate. */
  private nextTlsOptions(): {
    tls: OcppTlsOptions | undefined;
    renewed: boolean;
  } {
    const renewed = this._renewedClientCertificate;
    if (renewed && (renewed.confirmed || renewed.presentNext)) {
      return { tls: this.tlsWith(renewed), renewed: true };
    }
    const fallback = renewed?.fallback;
    return {
      tls: fallback ? this.tlsWith(fallback) : this._tls,
      renewed: false,
    };
  }

  private tlsWith(identity: ClientIdentity): OcppTlsOptions {
    return { ...(this._tls ?? {}), cert: identity.cert, key: identity.key };
  }

  /** A connection opened: settles which client certificate the station
   *  keeps while the renewed one is unconfirmed (A02.FR.10). */
  private onClientCertificateOpened(presentedRenewed: boolean): void {
    const renewed = this._renewedClientCertificate;
    if (!renewed || renewed.confirmed) return;
    if (presentedRenewed) {
      renewed.confirmed = true;
      this._logger.info(
        "Connected with the renewed Charging Station certificate (A02.FR.08)",
        LogType.WEBSOCKET,
      );
      return;
    }
    // The certificate in use before the renewal stays the station's.
    const fallback = renewed.fallback;
    this._renewedClientCertificate = fallback
      ? { ...fallback, confirmed: true, presentNext: false }
      : null;
    this._logger.warn(
      "Connected with the previous client certificate after the renewed one failed; discarding the renewed certificate (A02.FR.10)",
      LogType.WEBSOCKET,
    );
    this.observers.emit("renewedClientCertificateDiscarded", {});
  }

  /** An attempt closed before it opened: the next one presents the other
   *  certificate while the renewed one is unconfirmed (A02.FR.28). */
  private onClientCertificateFailed(presentedRenewed: boolean): void {
    const renewed = this._renewedClientCertificate;
    if (!renewed || renewed.confirmed) return;
    renewed.presentNext = !presentedRenewed;
    if (presentedRenewed) {
      this._logger.warn(
        "Could not connect with the renewed Charging Station certificate; the next attempt presents the previous one (A02.FR.28)",
        LogType.WEBSOCKET,
      );
    }
  }

  public setSupervisionUrlPool(pool: SupervisionUrlPool | null): void {
    this._urlPool = pool;
    if (pool) this._url = pool.current();
  }

  public connect(
    onopen: (() => void) | null = null,
    onclose: ((ev: SocketClose, cause: CloseCause) => void) | null = null,
  ): void {
    // #478: a socket the charge point closed (reset, disconnect) fires its
    // close event asynchronously, after this new generation exists. Report it
    // now, so its `disconnected` precedes the next `connected` and its
    // teardown cannot hit the replacement; the late event then only logs.
    const superseded = this._socketToken;
    if (this._ws === null && superseded && !superseded.closeReported) {
      this.reportClose(superseded, SUPERSEDED_CLOSE);
    }
    // A connect during the reconnect backoff supersedes it: left armed, the
    // timer would open another socket over this one and orphan it.
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // Increment generation on new connection
    this._generationCounter++;
    this._currentGeneration = new GenerationTokenImpl(this._generationCounter);

    // Store callbacks for reconnection
    if (onopen) this._onOpenCallback = onopen;
    if (onclose) this._onCloseCallback = onclose;

    this._isManualDisconnect = false;
    this._selfRequestedClose = false;

    const attempt = this.nextTlsOptions();
    let opened = false;
    const onopenHandler = () => {
      opened = true;
      this.onClientCertificateOpened(attempt.renewed);
      // A working connection clears the refusal budget, so the next genuine
      // refusal is diagnosed immediately rather than waiting out the window.
      this._lastRefusalProbeAt = 0;
      this._urlPool?.onSuccess();
      this.handleOpen();
      if (this._onOpenCallback) {
        this._onOpenCallback();
      }
    };
    const onmessageHandler = (ev: MessageEvent) => {
      this._controller.receiveDownstream(ev.data.toString());
    };
    const onerrorHandler = this.handleError.bind(this);

    // Capture the current generation for this socket connection
    const socketGeneration = this._generationCounter;
    // Kept per socket: a reset's close lands after the next generation is
    // already open, and must still report its own cause (#474).
    const socketToken = this._currentGeneration;
    const oncloseHandler = (ev: CloseEvent) => {
      const closeCause = this.closeCauseOf(socketToken);
      // Logged for every socket, stale ones included: it is the only line
      // carrying the real close code of a socket a reset superseded, and the
      // CP logs no error for it.
      this._logger.info(
        `WebSocket closed: code=${ev.code}, reason=${ev.reason || "none"}, wasClean=${ev.wasClean}, cause=${closeCause}`,
        LogType.WEBSOCKET,
      );
      // Generation guard: only process close if this socket belongs to the current generation
      if (socketGeneration === this._generationCounter) {
        // Only a failed connection attempt counts, not one the station
        // closed itself before it opened.
        if (!opened && closeCause === "network") {
          this.onClientCertificateFailed(attempt.renewed);
        }
        this.handleClose(ev, closeCause);
      }
      this.reportClose(socketToken, ev);
      // #448: announced once the charge point has handled the close, so an
      // observer sees the disconnect before the reconnect it causes.
      const notice = this._pendingReconnectNotice;
      this._pendingReconnectNotice = null;
      if (notice) this.observers.emit("reconnectScheduled", notice);
    };

    // Resolving here, per attempt, is what keeps the URL list out of
    // everything downstream: the snapshot, the persisted `ws_url` and the log
    // lines all still see one string.
    if (this._urlPool) {
      this._url = this._urlPool.next();
    }

    this._ws = openOcppWebSocket({
      baseUrl: this._url,
      chargePointId: this._chargePointId,
      basicAuth: this._basicAuth,
      extraHeaders: this._extraHeaders,
      extraSubprotocols: this._extraSubprotocols,
      ocppVersion: this._ocppVersion,
      securityProfile: this._securityProfile,
      authorizationKey: this._authorizationKey,
      cpoName: this._cpoName,
      tls: attempt.tls,
      warn: (message) => this._logger.warn(message, LogType.WEBSOCKET),
      onConnectOptions: (options) => {
        this._lastConnectOptions = options;
        this._refusalStatusReported = false;
      },
      onopen: onopenHandler,
      onmessage: onmessageHandler,
      onerror: onerrorHandler,
      onclose: oncloseHandler,
    });
    this._socketToken = socketToken;
  }

  public disconnect(): void {
    if (this._disposed) {
      return;
    }

    // Drain synchronously FIRST (spec 2.6 step 1)
    this.runCloseTransaction("manual");

    // Set manual disconnect flag to prevent auto-reconnect
    this._isManualDisconnect = true;

    // Clear reconnect timer to prevent reconnection attempts
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempts = 0;

    // Clear the reconnect reservation (operator manual disconnect)
    this._reconnectNotBefore = null;

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this.stopPingInterval();
  }

  /**
   * Closes the socket WITHOUT setting _isManualDisconnect (so auto-reconnect still runs)
   * and does NOT clear the reservation. Latches cause 'internal'.
   * Used by Task 7's cause-aware reset.
   */
  public disconnectInternal(): void {
    if (this._disposed) {
      return;
    }

    this.runCloseTransaction("internal");

    // Asked for by the charge point (a reset), so it is not evidence about the
    // supervision URL — see `_selfRequestedClose`.
    this._selfRequestedClose = true;

    // Close the socket WITHOUT setting _isManualDisconnect (so auto-reconnect runs)
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this.stopPingInterval();
  }

  /**
   * Terminal disposal: closes the controller, clears the reservation, cancels timers,
   * closes the socket, and marks the transport disposed/inert.
   * Settlement reason is 'disposed' (not a latched cause).
   */
  public dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Shut down controller with reason 'disposed'
    this._controller.shutdownPipelines({ reason: "disposed" });
    this.observers.emit("closed", { cause: "disposed" });

    // Clear the reconnect reservation
    this._reconnectNotBefore = null;

    // Clear reconnect timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this.stopPingInterval();
  }

  /**
   * Register a callback invoked AFTER the close transaction drain completes.
   * This is a seam for Task 7/8/9 effect flushing.
   */
  public onCloseTransaction(cb: (finalized: GenerationToken) => void): void {
    this._onCloseTransactionCallback = cb;
  }

  public sendAction(
    messageId: string,
    action: string,
    payload: unknown,
    gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): boolean {
    // Stale generation check
    if (gen.gen !== this._currentGeneration.gen) {
      // Stale generation: sendAction returns false, onSettled does NOT fire
      return false;
    }

    // Socket-open gate: spec section 2.5 requires send-false when socket is not open
    if (!this.isConnected()) {
      return false;
    }

    return this._controller.sendUpstream(
      encodeCallFrame(messageId, action, payload),
      onSettled,
    );
  }

  public sendResult(
    messageId: string,
    payload: unknown,
    gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    // Stale generation check
    if (gen.gen !== this._currentGeneration.gen) {
      // Stale generation: settle immediately with socket_closed + old generation's cause
      const settlement: Settlement = {
        outcome: "socket_closed",
        closeCause: gen.closeCause ?? "network",
      };
      onSettled?.(settlement);
      return;
    }

    // Socket-open gate: spec section 2.5 requires settlement when socket is not open
    if (!this.isConnected()) {
      onSettled?.({
        outcome: "socket_closed",
        closeCause: this._currentGeneration.closeCause ?? "network",
      });
      return;
    }

    const message = JSON.stringify([
      OCPPMessageType.CALLRESULT,
      messageId,
      payload,
    ]);
    const accepted = this._controller.sendUpstream(message, onSettled);

    // If sendUpstream returns false (overflow/stopped), settle immediately with queue_overflow
    if (!accepted && onSettled) {
      const settlement: Settlement = { outcome: "queue_overflow" };
      try {
        onSettled(settlement);
      } catch {
        // Custody callback exception isolation
      }
    }
  }

  public sendError(
    messageId: string,
    payload: OcppMessageErrorPayload,
    gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    // Stale generation check
    if (gen.gen !== this._currentGeneration.gen) {
      // Stale generation: settle immediately with socket_closed + old generation's cause
      const settlement: Settlement = {
        outcome: "socket_closed",
        closeCause: gen.closeCause ?? "network",
      };
      onSettled?.(settlement);
      return;
    }

    // Socket-open gate: spec section 2.5 requires settlement when socket is not open
    if (!this.isConnected()) {
      onSettled?.({
        outcome: "socket_closed",
        closeCause: this._currentGeneration.closeCause ?? "network",
      });
      return;
    }

    // OCPP 1.6J CALLERROR: [4, messageId, errorCode, errorDescription, errorDetails]
    const message = JSON.stringify([
      OCPPMessageType.CALLERROR,
      messageId,
      payload.errorCode,
      payload.errorDescription,
      payload.errorDetails ?? {},
    ]);
    const accepted = this._controller.sendUpstream(message, onSettled);

    // If sendUpstream returns false (overflow/stopped), settle immediately with queue_overflow
    if (!accepted && onSettled) {
      const settlement: Settlement = { outcome: "queue_overflow" };
      try {
        onSettled(settlement);
      } catch {
        // Custody callback exception isolation
      }
    }
  }

  /**
   * #393: an expert raw text frame, written as given. Shares the network-sim
   * pipeline, the `Sent:` log line and settlement with normal traffic; the
   * same generation and socket-open gates as `sendResult`.
   */
  public sendRaw(
    raw: string,
    gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    if (gen.gen !== this._currentGeneration.gen || !this.isConnected()) {
      onSettled?.({
        outcome: "socket_closed",
        closeCause:
          (gen.gen !== this._currentGeneration.gen
            ? gen.closeCause
            : this._currentGeneration.closeCause) ?? "network",
      });
      return;
    }
    const accepted = this._controller.sendUpstream(raw, onSettled);
    if (!accepted && onSettled) {
      try {
        onSettled({ outcome: "queue_overflow" });
      } catch {
        // Custody callback exception isolation
      }
    }
  }

  /** #393: see {@link IncomingFrameInterceptor}; null removes it. */
  public setIncomingInterceptor(
    interceptor: IncomingFrameInterceptor | null,
  ): void {
    this._incomingInterceptor = interceptor;
  }

  /** True when the underlying socket is open and ready to transmit. */
  public isConnected(): boolean {
    return this._ws !== null && this._ws.readyState === WebSocket.OPEN;
  }

  /** True when a WebSocket object exists in OPEN or CONNECTING state.
   *  Used by the connection restore path to avoid kicking off a second
   *  socket while the first one is still in its async handshake. */
  public isOpenOrConnecting(): boolean {
    return (
      this._ws !== null &&
      (this._ws.readyState === WebSocket.OPEN ||
        this._ws.readyState === WebSocket.CONNECTING)
    );
  }

  /**
   * Returns the current generation token.
   * Callers read .closeCause later and must see the latched value.
   */
  public currentGeneration(): GenerationToken {
    return this._currentGeneration;
  }

  /**
   * Apply network simulation config at runtime.
   */
  public setNetworkSimConfig(resolved: ResolvedNetworkSimConfig): void {
    this._controller.applyConfig(resolved);
  }

  /**
   * Trigger a manual-disconnect rule by its id.
   * Returns { ok: true } on success, or { ok: false; error } if sim is disabled or rule is not manual-disconnect.
   */
  public triggerNetworkSimDisconnect(
    ruleId: string,
  ): { ok: true } | { ok: false; error: "sim_disabled" | "rule_not_manual" } {
    return this._controller.triggerManualDisconnect(ruleId);
  }

  /**
   * Simulate a connection loss with a delayed reconnection.
   * FIRST installs the reservation, THEN runs the close transaction,
   * THEN closes the socket WITHOUT setting _isManualDisconnect (so auto-reconnect runs).
   */
  public simulateConnectionLoss(
    reconnectDelayMs: number,
    ruleId: string = "",
    ruleType: DisconnectRuleType = "manual-disconnect",
  ): void {
    if (this._disposed) {
      return;
    }

    // Observers learn of the fault while the socket is still up, so the
    // `disconnected` that follows can be attributed to this rule.
    this.observers.emit("simulatedDisconnect", {
      ruleId,
      ruleType,
      reconnectDelayMs,
    });

    // FIRST install the reservation BEFORE draining
    this._reconnectNotBefore = Date.now() + reconnectDelayMs;

    // THEN run the close transaction for a 'simulated' cause
    this.runCloseTransaction("simulated");

    // Injected by this charge point's own fault simulator, so it is not
    // evidence about the supervision URL — see `_selfRequestedClose`.
    this._selfRequestedClose = true;

    // THEN close the socket WITHOUT setting _isManualDisconnect
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this.stopPingInterval();
  }

  /**
   * Physical send (the actual websocket.send call).
   * This is what the ControllerHost.writeUpstream calls.
   */
  private writeUpstreamPhysical(raw: string): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      // A delayed frame can reach its release after the socket dropped. Throw
      // so the pipeline settles it `write_failed` instead of `written` — a
      // frame that never hit the wire must stay in its sender's custody
      // (transaction CALLs are salvaged into PendingMessageQueue from there).
      // The send methods gate on isConnected(), so the immediate paths never
      // land here.
      this._logger.warn("WebSocket is not connected", LogType.WEBSOCKET);
      throw new Error("WebSocket is not connected");
    }
    this._ws.send(raw);
    this._logger.info(`Sent: ${raw}`, LogType.WEBSOCKET);
  }

  /**
   * Dispatch incoming message through the normal parse/validate path.
   * This is what the ControllerHost.dispatchDownstream calls after any delay.
   */
  private dispatchIncoming(raw: string): void {
    this._logger.info(`Received: ${raw}`, LogType.WEBSOCKET);
    try {
      const messageArray = JSON.parse(raw);

      // Validate message format: must be array with length 3 (CALLRESULT), 4 (CALL), or 5 (CALLERROR)
      if (
        !Array.isArray(messageArray) ||
        messageArray.length < 3 ||
        messageArray.length > 5
      ) {
        this._logger.error(
          "Invalid message format: " + messageArray,
          LogType.WEBSOCKET,
        );
        return;
      }

      if (this._incomingInterceptor?.(messageArray)) return;

      if (this._messageHandler) {
        if (messageArray.length === 3) {
          // CALLRESULT: [messageType, messageId, payload]
          const [messageType, messageId, payload] = messageArray;
          this._messageHandler(
            messageType,
            messageId,
            OCPPAction.CallResult,
            payload,
          );
        } else if (messageArray.length === 4) {
          // CALL: [messageType, messageId, action, payload]
          const [messageType, messageId, action, payload] = messageArray;
          this._messageHandler(messageType, messageId, action, payload);
        } else if (messageArray.length === 5) {
          // CALLERROR: [messageType, messageId, errorCode, errorDescription, errorDetails]
          const [
            messageType,
            messageId,
            errorCode,
            errorDescription,
            errorDetails,
          ] = messageArray;
          this._messageHandler(messageType, messageId, OCPPAction.CallResult, {
            errorCode,
            errorDescription,
            errorDetails: errorDetails ?? {},
          });
        }
      } else {
        this._logger.warn("No message handler set", LogType.WEBSOCKET);
      }
    } catch (error) {
      this._logger.error(`Error parsing message: ${error}`, LogType.WEBSOCKET);
    }
  }

  /** Whether this runtime's socket can send a ping frame (#406): Bun's
   *  client and `ws` can, the browser `WebSocket` API cannot. */
  get supportsPing(): boolean {
    return !isBrowserRuntime();
  }

  /**
   * #406: apply `WebSocketPingInterval`. Takes effect at once on an open
   * socket and on every later open; 0 stops the client-side ping.
   */
  public setPingInterval(seconds: number): void {
    if (seconds === this._pingIntervalSeconds) return;
    this._pingIntervalSeconds = seconds;
    this._logger.info(
      seconds > 0 ? `WebSocket ping every ${seconds}s` : "WebSocket ping off",
      LogType.WEBSOCKET,
    );
    this.startPingInterval();
  }

  public setMessageHandler(handler: MessageHandler): void {
    this._messageHandler = handler;
  }

  private handleOpen(): void {
    this._logger.info("WebSocket connected successfully", LogType.WEBSOCKET);

    // Reset reconnect attempts on successful connection
    if (this._reconnectAttempts > 0) {
      this._logger.info(
        `Reconnection successful after ${this._reconnectAttempts} attempt(s)`,
        LogType.WEBSOCKET,
      );
    }
    this._reconnectAttempts = 0;

    // Call controller.onSocketOpen() to arm periodic timers
    this._controller.onSocketOpen();

    this.startPingInterval();
  }

  /**
   * Close transaction: idempotent per generation.
   * Determines close cause (manual vs network), latches it on the current generation,
   * drains pipelines, invokes the close-transaction callback, and (implicitly via handleClose)
   * registers a reconnect request if applicable.
   */
  private runCloseTransaction(closeCause: CloseCause): void {
    // If the current generation's cause is already latched, this is idempotent — return
    if (this._currentGeneration.closeCause !== null) {
      return;
    }

    // Latch the cause on the current generation token
    this._currentGeneration.latchCloseCause(closeCause);

    // Drain pipelines synchronously (custody callbacks run inline)
    this._controller.shutdownPipelines({
      reason: "socket_closed",
      closeCause,
    });

    // Invoke the close-transaction callback (for Task 7/8/9 effect flushing)
    if (this._onCloseTransactionCallback) {
      try {
        this._onCloseTransactionCallback(this._currentGeneration);
      } catch {
        // Callback exception isolation
      }
    }
    this.observers.emit("closed", { cause: closeCause });
  }

  /**
   * #288 — say what the error was, not merely that there was one.
   *
   * The event carries a message on every runtime that has one to give: the
   * `ws` client's "Unexpected server response: 401", Bun's
   * "WebSocket connection to '…' failed: Expected 101 status code", a TLS
   * failure's own text. Logging only `evt.type` threw all of it away, and
   * `evt.type` is the constant string "error".
   *
   * `httpStatus` is present only on the `ws` path, which is handed the whole
   * HTTP reply before it errors. Under Bun the status is not knowable here at
   * all — {@link handleClose} probes for it instead.
   */
  private handleError(evt: Event): void {
    const detail = evt as {
      type: string;
      message?: string;
      httpStatus?: number;
      httpLocation?: string;
    };
    if (typeof detail.httpStatus === "number") {
      this._refusalStatusReported = true;
      this._logger.error(
        this.describeRefusal(detail.httpStatus, detail.httpLocation),
        LogType.WEBSOCKET,
      );
      return;
    }
    this._logger.error(
      detail.message
        ? // The client's message quotes the connection URL, which may carry
          // `user:password@host` credentials -- redact before logging.
          `WebSocket error: ${redactSensitiveText(detail.message)}`
        : `WebSocket error type: ${detail.type}`,
      LogType.WEBSOCKET,
    );
  }

  /** One sentence per HTTP status, naming the operator's next move (#288). */
  private describeRefusal(status: number, location?: string): string {
    const hint =
      status === 401 || status === 403
        ? " — credentials refused, or the CSMS considers the connection insecure for its security profile"
        : status === 404
          ? " — the CSMS does not know this charge point id"
          : status >= 300 && status < 400
            ? // The Location comes from the CSMS and may carry userinfo or a
              // secret query parameter of its own, so it is redacted like any
              // other URL that reaches the log.
              ` — the endpoint redirects${location ? ` to ${redactSensitiveText(location)}` : ""}; a cleartext ws:// to a TLS-only edge looks like this`
            : "";
    return `WebSocket upgrade refused: HTTP ${status}${hint}`;
  }

  /**
   * #288 — ask the CSMS why, when the client will not say.
   *
   * Bun's native WebSocket reports every refused upgrade identically
   * (`code=1002, Expected 101 status code`), and the daemon runs under Bun. So
   * on that close, and only that close, replay the handshake as one plain GET
   * and log the status it answers with. Gated three ways: the `ws` path has
   * already reported the status, the probe runs at most once a minute per
   * charge point, and a manual disconnect never triggers it — the reconnect
   * loop must not multiply the CSMS's request rate.
   */
  private maybeProbeRefusal(ev: CloseEvent): void {
    if (this._isManualDisconnect || this._disposed) return;
    if (this._refusalStatusReported) return;
    if (ev.code !== 1002 || !/expected 101/i.test(ev.reason ?? "")) return;
    const options = this._lastConnectOptions;
    if (!options) return;
    const now = Date.now();
    if (now - this._lastRefusalProbeAt < 60_000) return;
    this._lastRefusalProbeAt = now;
    // The probe is a round trip, and the reconnect loop may well win it. A
    // refusal logged against a charge point that is connected again reads as
    // a live problem, so the answer is dropped unless it still describes the
    // connection that asked the question.
    const probedGeneration = this._generationCounter;
    void probeUpgradeRefusal(options)
      .then((detail) => {
        if (this._disposed || !detail) return;
        if (this._generationCounter !== probedGeneration) return;
        if (this._ws?.readyState === WebSocket.OPEN) return;
        this._logger.error(
          `${this.describeRefusal(detail.status, detail.location)} (diagnostic GET after the handshake failed)`,
          LogType.WEBSOCKET,
        );
      })
      .catch(() => {
        // A diagnostic must never become a failure of its own.
      });
  }

  /**
   * Who closed a generation's socket: the cause it latched, else what
   * handleClose would latch now. dispose() latches nothing; a close after it
   * is the operator tearing the charge point down, so it reads as manual.
   */
  private closeCauseOf(token: GenerationToken): CloseCause {
    if (token.closeCause !== null) return token.closeCause;
    return this._disposed || this._isManualDisconnect ? "manual" : "network";
  }

  /** Tells the charge point a generation's socket closed, once per socket. */
  private reportClose(token: GenerationTokenImpl, ev: SocketClose): void {
    if (token.closeReported) return;
    token.closeReported = true;
    this._onCloseCallback?.(ev, this.closeCauseOf(token));
  }

  private handleClose(ev: CloseEvent, closeCause: CloseCause): void {
    this.maybeProbeRefusal(ev);
    this.stopPingInterval();

    if (this._disposed) {
      // Transport is disposed — terminal state, ignore close events
      return;
    }

    // Run the close transaction (idempotent per generation; a cause the
    // charge point latched itself is kept)
    this.runCloseTransaction(closeCause);

    // Only attempt reconnect if not manually disconnected
    if (!this._isManualDisconnect) {
      // Only a close the charge point did not ask for counts as a failure of
      // the URL in use. A reset, or an injected disconnect, says nothing about
      // the node and must not push an affinity pool off its primary.
      if (!this._selfRequestedClose) this._urlPool?.onFailure();
      this.attemptReconnect();
    }
  }

  /**
   * #406: ping frames are WebSocket control frames, not OCPP messages, so
   * they bypass the network-sim pipelines and are not logged one by one.
   */
  private startPingInterval(): void {
    this.stopPingInterval();
    const seconds = this._pingIntervalSeconds;
    if (seconds <= 0 || !this.isConnected()) return;
    this._pingInterval = setInterval(() => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      try {
        this._ws.ping();
      } catch (error) {
        this._logger.warn(
          `WebSocket ping failed: ${String(error)}`,
          LogType.WEBSOCKET,
        );
      }
    }, seconds * 1000);
  }

  private stopPingInterval(): void {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    // Clear any existing reconnect timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._reconnectAttempts++;

    // Calculate delay with exponential backoff: baseDelay * 2^(attempts - 1)
    // Example: 1s, 2s, 4s, 8s, 16s, 30s (max)
    const exponentialDelay =
      this._baseReconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    const backoffDelay = Math.min(exponentialDelay, this._maxReconnectDelay);

    // Reconnect reservation: the actual scheduled delay is the max of the exponential backoff
    // and the remaining time until reconnectNotBefore
    const reservationDelay = this._reconnectNotBefore
      ? Math.max(0, this._reconnectNotBefore - Date.now())
      : 0;
    const actualDelay = Math.max(backoffDelay, reservationDelay);

    this._logger.info(
      `Reconnecting in ${actualDelay / 1000}s... (attempt ${this._reconnectAttempts})`,
      LogType.WEBSOCKET,
    );
    this._pendingReconnectNotice = {
      attempt: this._reconnectAttempts,
      delayMs: actualDelay,
    };

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;

      // Consume the reservation at socket-open attempt (irreversible consumption point)
      this._reconnectNotBefore = null;

      this._logger.info(
        `Attempting reconnection (attempt ${this._reconnectAttempts})...`,
        LogType.WEBSOCKET,
      );
      this.connect();
    }, actualDelay);
  }
}
