import type { Logger } from "../../shared/Logger";
import { LogType } from "../../shared/Logger";
import { isCertificateInBundle } from "../../domain/security/certificateHash";
import { isBrowserRuntime, type OcppSocket } from "./wsUrlWithBasic";
import type { SupervisionUrlPool } from "./SupervisionUrlPool";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
  OcppWebSocketConnectOptions,
} from "./wsUrlWithBasic";
import type { OCPPAction, OCPPErrorCode } from "../../domain/types/OcppTypes";
import type { OCPPMessageType } from "../../domain/types/OcppTypes";
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
import { GenerationTokenImpl } from "./ws/closeClassification";
import { UpgradeRefusalDiagnostic } from "./ws/upgradeRefusalDiagnostic";
import {
  dispatchIncomingFrame,
  writeUpstreamPhysical,
} from "./ws/wsNetworkSim";

import { ConnectionOpener } from "./ws/connectionOpener";
import { FrameSender } from "./ws/frameSender";
import { CloseHandler } from "./ws/closeHandler";
import { ReconnectScheduler } from "./ws/reconnectScheduler";
import { createHost } from "./ws/socketHost";
import { PingTimer } from "./ws/pingTimer";

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
  private readonly _opener: ConnectionOpener;
  private readonly _sender: FrameSender;
  private readonly _closer: CloseHandler;
  private readonly _reconnect: ReconnectScheduler;
  private readonly _ping: PingTimer;

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
    const host = createHost(this, {
      isConnected: () => this.isConnected(),
      connect: (onopen, onclose) => this.connect(onopen, onclose),
      attemptReconnect: () => this.attemptReconnect(),
      startPingInterval: () => this.startPingInterval(),
      stopPingInterval: () => this.stopPingInterval(),
      runCloseTransaction: (closeCause) => this.runCloseTransaction(closeCause),
      handleOpen: () => this._closer.handleOpen(),
      handleError: (evt) => this._closer.handleError(evt),
      handleClose: (ev, closeCause) => this._closer.handleClose(ev, closeCause),
      closeCauseOf: (token) => this._closer.closeCauseOf(token),
      reportClose: (token, ev) => this._closer.reportClose(token, ev),
      clearHandshakeTimer: () => this.clearHandshakeTimer(),
    });
    // Read by the collaborators through `host` (ws/socketHost.ts) only.
    void [
      this._basicAuth,
      this._chargePointId,
      this._pingInterval,
      this._pingIntervalSeconds,
      this._reconnectAttempts,
      this._reconnectRandom,
      this._handshakeTimer,
      this._retryBackOff,
      this._resumeOnLinkRestore,
      this._onOpenCallback,
      this._onCloseCallback,
      this._isManualDisconnect,
      this._selfRequestedClose,
      this._refusal,
      this._refusalStatusReported,
      this._extraHeaders,
      this._extraSubprotocols,
      this._ocppVersion,
      this._authorizationKey,
      this._securityProfileFallback,
      this._credentialsChangedAtRuntime,
      this._cpoName,
      this._socketToken,
      this._reconnectNotBefore,
      this._urlPool,
      this._onCloseTransactionCallback,
      this._pendingReconnectNotice,
      this._pendingGaveUp,
    ];
    this._opener = new ConnectionOpener(host);
    this._sender = new FrameSender(host);
    this._closer = new CloseHandler(host);
    this._reconnect = new ReconnectScheduler(host);
    this._ping = new PingTimer(host);
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
    this._opener.connect(onopen, onclose);
  }

  private clearHandshakeTimer(): void {
    this._opener.clearHandshakeTimer();
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
    return this._sender.sendAction(messageId, action, payload, gen, onSettled);
  }

  public sendResult(
    messageId: string,
    payload: unknown,
    gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    this._sender.sendResult(messageId, payload, gen, onSettled);
  }

  public sendError(
    messageId: string,
    payload: OcppMessageErrorPayload,
    gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    this._sender.sendError(messageId, payload, gen, onSettled);
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
    this._sender.sendRaw(raw, gen, onSettled);
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
    this._reconnect.simulateConnectionLoss(reconnectDelayMs, ruleId, ruleType);
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
    this._ping.setPingInterval(seconds);
  }

  public setMessageHandler(handler: MessageHandler): void {
    this._messageHandler = handler;
  }

  private runCloseTransaction(closeCause: CloseCause): void {
    this._closer.runCloseTransaction(closeCause);
  }

  private startPingInterval(): void {
    this._ping.startPingInterval();
  }

  private stopPingInterval(): void {
    this._ping.stopPingInterval();
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
    this._reconnect.setLinkBlocked(reason);
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
    this._reconnect.attemptReconnect();
  }
}
