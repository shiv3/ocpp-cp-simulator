import { Logger, LogType } from "../../shared/Logger";
import { openOcppWebSocket } from "./wsUrlWithBasic";
import type { OcppSecurityProfile, OcppTlsOptions } from "./wsUrlWithBasic";
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
} from "./network-sim";

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

/**
 * GenerationTokenImpl: immutable per-generation object carrying the generation number
 * and, once closed, its latched close cause. First-cause latching: the first close
 * of a generation latches its cause; later close processing for that same generation
 * must NOT overwrite it.
 */
class GenerationTokenImpl implements GenerationToken {
  private _closeCause: CloseCause | null = null;

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
  private _ws: WebSocket | null = null;
  private _url: string;
  private _basicAuth: { username: string; password: string } | null = null;
  private _chargePointId: string;
  private _logger: Logger;
  private _messageHandler: MessageHandler | null = null;
  private _pingInterval: number | null = null;
  private _reconnectAttempts: number = 0;
  private _maxReconnectAttempts: number = Infinity; // Infinite retries
  private _baseReconnectDelay: number = 1000; // 1 second base delay
  private _maxReconnectDelay: number = 30000; // 30 seconds max delay
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _onOpenCallback: (() => void) | null = null;
  private _onCloseCallback: ((ev: CloseEvent) => void) | null = null;
  private _isManualDisconnect: boolean = false;
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

  // Network simulation
  private _controller: NetworkSimController;
  private _generationCounter: number = 0;
  private _currentGeneration: GenerationTokenImpl;
  private _reconnectNotBefore: number | null = null;
  private _onCloseTransactionCallback:
    ((finalized: GenerationToken) => void) | null = null;
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
      requestSimulatedDisconnect: (reconnectDelayMs: number) =>
        this.simulateConnectionLoss(reconnectDelayMs),
      log: (message: string) => this._logger.info(message, LogType.WEBSOCKET),
    };
    this._controller = new NetworkSimController(controllerHost, chargePointId);
  }

  get url(): string {
    return this._url;
  }

  public connect(
    onopen: (() => void) | null = null,
    onclose: ((ev: CloseEvent) => void) | null = null,
  ): void {
    // Increment generation on new connection
    this._generationCounter++;
    this._currentGeneration = new GenerationTokenImpl(this._generationCounter);

    // Store callbacks for reconnection
    if (onopen) this._onOpenCallback = onopen;
    if (onclose) this._onCloseCallback = onclose;

    this._isManualDisconnect = false;

    const onopenHandler = () => {
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
    const oncloseHandler = (ev: CloseEvent) => {
      // Generation guard: only process close if this socket belongs to the current generation
      if (socketGeneration === this._generationCounter) {
        this.handleClose(ev);
      }
      if (this._onCloseCallback) {
        this._onCloseCallback(ev);
      }
    };

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
      tls: this._tls,
      warn: (message) => this._logger.warn(message, LogType.WEBSOCKET),
      onopen: onopenHandler,
      onmessage: onmessageHandler,
      onerror: onerrorHandler,
      onclose: oncloseHandler,
    });
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
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
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

    // Close the socket WITHOUT setting _isManualDisconnect (so auto-reconnect runs)
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
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
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
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
    gen?: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): boolean {
    // TEMPORARY COMPATIBILITY: gen defaults to currentGeneration() when omitted
    const token = gen ?? this._currentGeneration;

    // Stale generation check
    if (token.gen !== this._currentGeneration.gen) {
      // Stale generation: sendAction returns false, onSettled does NOT fire
      return false;
    }

    // Socket-open gate: spec section 2.5 requires send-false when socket is not open
    if (!this.isConnected()) {
      return false;
    }

    const message = JSON.stringify([
      OCPPMessageType.CALL,
      messageId,
      action,
      payload,
    ]);
    return this._controller.sendUpstream(message, onSettled);
  }

  public sendResult(
    messageId: string,
    payload: unknown,
    gen?: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    // TEMPORARY COMPATIBILITY: gen defaults to currentGeneration() when omitted
    const token = gen ?? this._currentGeneration;

    // Stale generation check
    if (token.gen !== this._currentGeneration.gen) {
      // Stale generation: settle immediately with socket_closed + old generation's cause
      const settlement: Settlement = {
        outcome: "socket_closed",
        closeCause: token.closeCause ?? "network",
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
    gen?: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    // TEMPORARY COMPATIBILITY: gen defaults to currentGeneration() when omitted
    const token = gen ?? this._currentGeneration;

    // Stale generation check
    if (token.gen !== this._currentGeneration.gen) {
      // Stale generation: settle immediately with socket_closed + old generation's cause
      const settlement: Settlement = {
        outcome: "socket_closed",
        closeCause: token.closeCause ?? "network",
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
  public simulateConnectionLoss(reconnectDelayMs: number): void {
    if (this._disposed) {
      return;
    }

    // FIRST install the reservation BEFORE draining
    this._reconnectNotBefore = Date.now() + reconnectDelayMs;

    // THEN run the close transaction for a 'simulated' cause
    this.runCloseTransaction("simulated");

    // THEN close the socket WITHOUT setting _isManualDisconnect
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  /**
   * Physical send (the actual websocket.send call).
   * This is what the ControllerHost.writeUpstream calls.
   */
  private writeUpstreamPhysical(raw: string): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(raw);
      this._logger.info(`Sent: ${raw}`, LogType.WEBSOCKET);
    } else {
      this._logger.warn("WebSocket is not connected", LogType.WEBSOCKET);
    }
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

    // this.startPingInterval();
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
  }

  private handleError(evt: Event): void {
    this._logger.error(`WebSocket error type: ${evt.type}`, LogType.WEBSOCKET);
  }

  private handleClose(ev: CloseEvent): void {
    this._logger.info(
      `WebSocket closed: code=${ev.code}, reason=${ev.reason || "none"}, wasClean=${ev.wasClean}`,
      LogType.WEBSOCKET,
    );
    this.stopPingInterval();

    if (this._disposed) {
      // Transport is disposed — terminal state, ignore close events
      return;
    }

    // Determine the close cause
    const closeCause: CloseCause = this._isManualDisconnect
      ? "manual"
      : "network";

    // Run the close transaction (idempotent per generation)
    this.runCloseTransaction(closeCause);

    // Only attempt reconnect if not manually disconnected
    if (!this._isManualDisconnect) {
      this.attemptReconnect();
    }
  }

  // private startPingInterval(): void {
  //   this._pingInterval = setInterval(() => {
  //     if (this._ws && this._ws.readyState === WebSocket.OPEN) {
  //       this._ws.ping();
  //     }
  //   }, 30000); // Send a ping every 30 seconds
  // }

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
