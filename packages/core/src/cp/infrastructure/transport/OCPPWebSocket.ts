import type { Logger } from "../../shared/Logger";
import { LogType } from "../../shared/Logger";
import { encodeCallFrame } from "./callFrame";
import { isCertificateInBundle } from "../../domain/security/certificateHash";
import {
  isBrowserRuntime,
  OcppSecurityProfileConfigError,
  openOcppWebSocket,
  type OcppSocket,
} from "./wsUrlWithBasic";
import type { SupervisionUrlPool } from "./SupervisionUrlPool";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
  OcppWebSocketConnectOptions,
} from "./wsUrlWithBasic";
import type { OCPPAction, OCPPErrorCode } from "../../domain/types/OcppTypes";
import { OCPPMessageType } from "../../domain/types/OcppTypes";
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
} from "@ocpp-cp-simulator/ocpp/index";
import {
  NetworkSimController,
  type ControllerHost,
  type GenerationToken,
  type CloseCause,
  type Settlement,
  type ResolvedNetworkSimConfig,
  type DisconnectRuleType,
} from "./network-sim";
import type { WsClientOptions } from "../../shared/WsClientOptions";
import {
  DEFAULT_RECONNECT_POLICY,
  nextReconnectDelayMs,
  type ReconnectPolicy,
  type RetryBackOffVariables,
} from "../../shared/ReconnectPolicy";
import type {
  ChargePointSocket,
  SocketClose,
  TransportObserverEvents,
} from "../../domain/transport/ChargePointSocket";
import { EventEmitter } from "../../shared/EventEmitter";
import {
  ClientCertificateState,
  type ClientIdentity,
} from "./ws/clientCertificateState";
import {
  classifyFailedAttempt,
  describeConnectError,
  GenerationTokenImpl,
  SUPERSEDED_CLOSE,
  type ConnectErrorDetail,
} from "./ws/closeClassification";
import { UpgradeRefusalDiagnostic } from "./ws/upgradeRefusalDiagnostic";
import {
  dispatchIncomingFrame,
  writeUpstreamPhysical,
} from "./ws/wsNetworkSim";

export { neverReachedCsms } from "./ws/closeClassification";

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

export type MessageHandler = (
  messageType: OCPPMessageType,
  messageId: string,
  action: OCPPAction,
  payload: OcppMessagePayload,
) => void;

export class OCPPWebSocket implements ChargePointSocket {
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
  /** #609: how long to wait between attempts, and when to stop. */
  private _reconnectPolicy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY;
  /** Uniform in [0, 1); the charge point's seeded `reconnect` stream. */
  private _reconnectRandom: () => number = Math.random;
  /** #611: connection options; the runtime support was checked by the owner. */
  private _wsOptions: WsClientOptions = {};
  private _handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** #609: 2.x `RetryBackOff*` variables; null on 1.6. */
  private _retryBackOff: RetryBackOffVariables | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * #930: why the link is administratively down (a suspended or blocked SIM on
   * a cellular station), or `null`. While set, no socket is opened by any path
   * (connect, reset, the reconnect timer) and no reconnect attempt is counted.
   */
  private _linkBlockedReason: string | null = null;
  /** #930: the link was wanted when it went down (or a connect asked for it
   *  while down); restoring service dials again with a fresh budget. */
  private _resumeOnLinkRestore = false;
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
  /** #288: the attempt's error log and the refusal probe. */
  private readonly _refusal: UpgradeRefusalDiagnostic;
  // Extra HTTP headers + Sec-WebSocket-Protocol tokens attached on each
  // upgrade. Both are CLI-only — DOM WebSocket ignores extraHeaders, but
  // the runtime fallback in openOcppWebSocket handles that.
  private _extraHeaders: Record<string, string>;
  private _extraSubprotocols: ReadonlyArray<string>;
  private _ocppVersion: string;
  private _securityProfile?: OcppSecurityProfile;
  private _authorizationKey?: string;
  private _securityProfileFallback: (() => void) | null = null;
  /** `setSecurityCredentials` ran: a credential that cannot open a
   *  connection is then reported and retried, not thrown (#724). */
  private _credentialsChangedAtRuntime = false;
  private _cpoName?: string;
  private _tls?: OcppTlsOptions;
  private readonly _clientCerts: ClientCertificateState;
  /** Read by tests that cast to reach it. */
  private get _renewedClientCertificate() {
    return this._clientCerts.renewed;
  }
  /** #564: the client certificate (PEM) the current attempt presents. */
  private _connectionClientCertificate: string | undefined;

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
  private _pendingGaveUp: { attempts: number } | null = null;
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
    this._clientCerts = new ClientCertificateState({
      logger,
      tls: () => this._tls,
      emitDiscarded: () =>
        this.observers.emit("renewedClientCertificateDiscarded", {}),
    });
    this._refusal = new UpgradeRefusalDiagnostic(
      logger,
      (generation) =>
        !this._disposed &&
        this._generationCounter === generation &&
        this._ws?.readyState !== WebSocket.OPEN,
    );

    // Initialize network simulation controller and current generation
    this._currentGeneration = new GenerationTokenImpl(this._generationCounter);
    const controllerHost: ControllerHost = {
      writeUpstream: (raw: string) =>
        writeUpstreamPhysical(this._ws, raw, this._logger),
      dispatchDownstream: (raw: string) =>
        dispatchIncomingFrame(raw, {
          logger: this._logger,
          intercept: (frame) => this._incomingInterceptor?.(frame) ?? false,
          handler: () => this._messageHandler,
        }),
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
   * #609: replace the reconnect policy. `random` returns a number in
   * [0, 1) and draws the jitter; the charge point passes its seeded
   * `reconnect` stream so a run replays. Takes effect from the next attempt.
   */
  setReconnectPolicy(policy: ReconnectPolicy, random?: () => number): void {
    this._reconnectPolicy = policy;
    if (random) this._reconnectRandom = random;
  }

  /**
   * #611: handshake timeout, compression, max payload, proxy, local address.
   * The caller must have checked them against the runtime
   * (`assertWsClientOptions`): this does not drop what the runtime would
   * ignore. Applies from the next connection attempt.
   */
  setWsClientOptions(options: WsClientOptions): void {
    this._wsOptions = options;
  }

  get wsClientOptions(): WsClientOptions {
    return this._wsOptions;
  }

  get reconnectPolicy(): ReconnectPolicy {
    return this._reconnectPolicy;
  }

  /** #609: OCPP 2.x `RetryBackOffWaitMinimum` / `RandomRange` /
   *  `RepeatTimes`; `null` returns to the policy alone (1.6). */
  setRetryBackOff(variables: RetryBackOffVariables | null): void {
    this._retryBackOff = variables;
  }

  /**
   * Hand the socket a set of supervision URLs to choose between.
   *
   * A setter rather than a constructor parameter: the constructor already
   * carries eleven positional arguments, and a charge point with one URL —
   * every charge point until now — should not have to pass anything.
   */
  /**
   * The PEM that validates the current CSMS connection: the `--tls-ca`
   * certificates of a `wss://` connection that verifies the server (#537,
   * 1.6 whitepaper M04.FR.06), narrowed to the one root that ended the
   * server's chain when the client can read it (the Node `ws` client, #563)
   * and that root is in the bundle. Bun's native client and the browser
   * cannot, so the whole bundle stays. `undefined` over `ws://`, without
   * `--tls-ca` (the runtime's own trust store then validates) or with
   * verification turned off.
   */
  public connectionTrustAnchorsPem(): string | undefined {
    if (!/^wss:/i.test(this._url)) return undefined;
    if (this._tls?.rejectUnauthorized === false) return undefined;
    const bundle = this._tls?.ca;
    if (bundle === undefined) return undefined;
    const root = this._ws?.validatingRootPem?.();
    return root !== undefined && isCertificateInBundle(root, bundle)
      ? root
      : bundle;
  }

  /**
   * #724 A01.FR.03 / A05.FR.07: the credentials the next connection attempt
   * sends. Read on every attempt, so a ChangeConfiguration of
   * `AuthorizationKey` or `SecurityProfile` is used by the next reconnect.
   */
  public setSecurityCredentials(credentials: {
    securityProfile?: OcppSecurityProfile;
    authorizationKey?: string;
  }): void {
    this._credentialsChangedAtRuntime = true;
    if ("securityProfile" in credentials) {
      this._securityProfile = credentials.securityProfile;
    }
    if ("authorizationKey" in credentials) {
      this._authorizationKey = credentials.authorizationKey;
    }
  }

  /**
   * #724 A05.FR.08: until a connection opens, a socket close that is not a
   * manual disconnect calls `fallback` once, before the next attempt, so the
   * caller can put the previous security profile back.
   */
  public armSecurityProfileFallback(fallback: () => void): void {
    this._securityProfileFallback = fallback;
  }

  /** `--tls-ca` certificates are configured. */
  public hasConfiguredTrustAnchors(): boolean {
    return !!this._tls?.ca;
  }

  /** A client certificate is configured (`--tls-cert`) or was renewed. */
  public hasClientCertificate(): boolean {
    return !!this._tls?.cert || this._renewedClientCertificate !== null;
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
    this._clientCerts.use(identity);
  }

  /** Whether the open (or opening) connection presents `cert` as its client
   *  certificate (#564): one that does needs no reconnect to switch to it. */
  public presentsClientCertificate(cert: string): boolean {
    return (
      this._connectionClientCertificate === cert && this.isOpenOrConnecting()
    );
  }

  /**
   * #537: forgets every renewed identity, confirmed or not, so the next
   * connection presents the configured `cert` / `key`. Called when the
   * certificate store no longer holds the key of its Charging Station
   * certificate (a chain replaced by one signed for a caller-supplied CSR,
   * or removed). The refusal probe's replay options lose the key too.
   */
  public clearRenewedClientCertificate(): void {
    this._clientCerts.renewed = null;
    if (this._lastConnectOptions) {
      this._lastConnectOptions = {
        ...this._lastConnectOptions,
        tls: this._tls,
      };
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
    if (this._linkBlockedReason !== null) {
      // #930: the cellular link is down. Remember the request and any
      // callbacks, open nothing; restoring service connects.
      if (onopen) this._onOpenCallback = onopen;
      if (onclose) this._onCloseCallback = onclose;
      this._isManualDisconnect = false;
      this._resumeOnLinkRestore = !this._disposed;
      this._logger.info(
        `connect deferred: the cellular link is unavailable (${this._linkBlockedReason})`,
        LogType.WEBSOCKET,
      );
      return;
    }
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

    const attempt = this._clientCerts.nextTlsOptions();
    this._connectionClientCertificate = attempt.tls?.cert;
    let opened = false;
    const onopenHandler = () => {
      opened = true;
      this._securityProfileFallback = null;
      this.clearHandshakeTimer();
      this._clientCerts.onOpened(attempt.renewed);
      this._refusal.clearBudget();
      this._urlPool?.onSuccess();
      this.handleOpen();
      if (this._onOpenCallback) {
        this._onOpenCallback();
      }
    };
    const onmessageHandler = (ev: MessageEvent) => {
      this._controller.receiveDownstream(ev.data.toString());
    };
    // #1034: the first error of this attempt, before it opened. Bun 1.4.4
    // puts the cause there and closes with a blank 1006. Closure-local, so a
    // superseded socket's late error cannot speak for this attempt, nor
    // silence its refusal probe by reporting a status of its own (#1033).
    let firstError: ConnectErrorDetail | undefined;
    let statusReported = false;
    const onerrorHandler = (ev: Event) => {
      if (!opened) firstError ??= describeConnectError(ev);
      if (this._refusal.reportError(ev)) statusReported = true;
    };

    // Capture the current generation for this socket connection
    const socketGeneration = this._generationCounter;
    // Kept per socket: a reset's close lands after the next generation is
    // already open, and must still report its own cause (#474).
    const socketToken = this._currentGeneration;
    const oncloseHandler = (ev: CloseEvent) => {
      this.clearHandshakeTimer();
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
        if (!opened && !this._isManualDisconnect) {
          const fallback = this._securityProfileFallback;
          this._securityProfileFallback = null;
          fallback?.();
        }
        // Only a failed connection attempt counts, not one the station
        // closed itself before it opened, nor one no CSMS ever saw.
        const kind = opened ? null : classifyFailedAttempt(ev, firstError);
        if (kind && closeCause === "network" && kind !== "unreached") {
          this._clientCerts.onFailed(attempt.renewed);
        }
        // #288: ask the CSMS why it refused, unless the client said so.
        const probe = kind === "upgrade-refused" && !statusReported;
        this.handleClose(closeCause, probe);
      }
      this.reportClose(socketToken, ev);
      // #448: announced once the charge point has handled the close, so an
      // observer sees the disconnect before the reconnect it causes.
      const notice = this._pendingReconnectNotice;
      this._pendingReconnectNotice = null;
      if (notice) this.observers.emit("reconnectScheduled", notice);
      const gaveUp = this._pendingGaveUp;
      this._pendingGaveUp = null;
      if (gaveUp) this.observers.emit("reconnectGaveUp", gaveUp);
    };

    // Resolving here, per attempt, is what keeps the URL list out of
    // everything downstream: the snapshot, the persisted `ws_url` and the log
    // lines all still see one string.
    if (this._urlPool) {
      this._url = this._urlPool.next();
    }

    try {
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
        ...(Object.keys(this._wsOptions).length > 0
          ? { ws: this._wsOptions }
          : {}),
        warn: (message) => this._logger.warn(message, LogType.WEBSOCKET),
        onConnectOptions: (options) => {
          this._lastConnectOptions = options;
        },
        onopen: onopenHandler,
        onmessage: onmessageHandler,
        onerror: onerrorHandler,
        onclose: oncloseHandler,
      });
    } catch (error) {
      // A credential a ChangeConfiguration left unusable (#724) must not end
      // the reconnect loop: report it, undo a pending security-profile switch
      // and try again. A misconfiguration at start-up still throws.
      if (
        !(error instanceof OcppSecurityProfileConfigError) ||
        !this._credentialsChangedAtRuntime
      ) {
        throw error;
      }
      this._logger.error(
        `Cannot open the connection: ${error.message}`,
        LogType.WEBSOCKET,
      );
      const fallback = this._securityProfileFallback;
      this._securityProfileFallback = null;
      fallback?.();
      this._ws = null;
      if (!this._isManualDisconnect && !this._disposed) this.attemptReconnect();
      return;
    }
    this._socketToken = socketToken;
    this.armHandshakeTimer(this._ws);
  }

  /** #611: no runtime times the handshake out natively (Bun never does), so
   *  an attempt that has not opened in time is closed here; it then fails
   *  like any other connection failure and the reconnect policy takes over. */
  private armHandshakeTimer(socket: OcppSocket): void {
    this.clearHandshakeTimer();
    const timeoutMs = this._wsOptions.handshakeTimeoutMs;
    if (timeoutMs === undefined) return;
    this._handshakeTimer = setTimeout(() => {
      this._handshakeTimer = null;
      if (this._ws !== socket || socket.readyState !== WebSocket.CONNECTING) {
        return;
      }
      this._logger.warn(
        `WebSocket handshake timed out after ${timeoutMs} ms (ws.handshakeTimeoutMs)`,
        LogType.WEBSOCKET,
      );
      socket.close();
    }, timeoutMs);
  }

  private clearHandshakeTimer(): void {
    if (this._handshakeTimer) {
      clearTimeout(this._handshakeTimer);
      this._handshakeTimer = null;
    }
  }

  public disconnect(): void {
    if (this._disposed) {
      return;
    }
    // An operator's disconnect ends the wish to be connected, also while the
    // link is down (#930).
    this._resumeOnLinkRestore = false;

    // Drain synchronously FIRST (spec 2.6 step 1)
    this.runCloseTransaction("manual");

    // Set manual disconnect flag to prevent auto-reconnect
    this._isManualDisconnect = true;
    // A05.FR.08 covers the connection that follows the switch only: an
    // operator's disconnect ends it.
    this._securityProfileFallback = null;

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
    this._securityProfileFallback = null;

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
    this.clearHandshakeTimer();

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

  /** @param probeRefusal a refused upgrade whose status the client hid:
   *  ask the CSMS (#288), never after a manual disconnect. */
  private handleClose(closeCause: CloseCause, probeRefusal: boolean): void {
    if (probeRefusal && !this._isManualDisconnect && !this._disposed) {
      this._refusal.probe(this._lastConnectOptions, this._generationCounter);
    }
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

  /**
   * #930: take the link down (`reason`) or bring it back (`null`).
   *
   * Down: the open socket, if any, is closed with the `simulated` cause (a
   * deliberate simulated outage, not a failure of the station), the reconnect
   * timer is cancelled and the attempt budget reset, so an outage of any
   * length consumes none of the #609 policy. The station keeps its power and
   * its transactions; the close transaction salvages queued messages exactly
   * as for any lost link. Up: if a connection was wanted, dial again now with
   * a fresh budget through the normal `connect()` (no reboot, no extra boot:
   * whether a BootNotification follows is the charge point's own #702 rule).
   */
  public setLinkBlocked(reason: string | null): void {
    if (this._disposed || reason === this._linkBlockedReason) return;
    if (reason !== null) {
      const hadLink =
        !this._isManualDisconnect &&
        (this._ws !== null || this._reconnectTimer !== null);
      this._linkBlockedReason = reason;
      this._resumeOnLinkRestore = this._resumeOnLinkRestore || hadLink;
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this._reconnectAttempts = 0;
      this._reconnectNotBefore = null;
      this._pendingReconnectNotice = null;
      if (this._ws) {
        this.runCloseTransaction("simulated");
        this._selfRequestedClose = true;
        this._ws.close();
        this._ws = null;
        this.stopPingInterval();
      }
      return;
    }
    this._linkBlockedReason = null;
    if (!this._resumeOnLinkRestore) return;
    this._resumeOnLinkRestore = false;
    this._reconnectAttempts = 0;
    this._logger.info(
      "The cellular link is restored; reconnecting",
      LogType.WEBSOCKET,
    );
    this.connect();
  }

  /** #930: whether the link is administratively down, and why. */
  public get linkBlockedReason(): string | null {
    return this._linkBlockedReason;
  }

  /** #930: sustained payload caps per direction (bytes per second), or `null`. */
  public setBandwidthLimits(limits: {
    upstreamBytesPerSecond: number | null;
    downstreamBytesPerSecond: number | null;
  }): void {
    this._controller.setBandwidthLimits(limits);
  }

  private attemptReconnect(): void {
    // #930: an administratively down link is not a failed attempt.
    if (this._linkBlockedReason !== null) return;
    // Clear any existing reconnect timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._reconnectAttempts++;

    const decision = nextReconnectDelayMs(
      this._reconnectPolicy,
      this._reconnectAttempts,
      this._reconnectRandom,
      this._retryBackOff,
    );
    if (decision.kind === "give-up") {
      const attempts = this._reconnectAttempts - 1;
      this._logger.warn(
        `Giving up reconnecting after ${attempts} attempt(s) (reconnect.maxAttempts=${this._reconnectPolicy.maxAttempts})`,
        LogType.WEBSOCKET,
      );
      // A later explicit connect() starts with a fresh budget.
      this._reconnectAttempts = 0;
      this._reconnectNotBefore = null;
      this._pendingReconnectNotice = null;
      // Announced with the close, after the disconnect it follows.
      this._pendingGaveUp = { attempts };
      return;
    }
    const backoffDelay = decision.delayMs;

    // Reconnect reservation: the actual scheduled delay is the max of the backoff
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
