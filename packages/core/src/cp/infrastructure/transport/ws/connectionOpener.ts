// Split out of OCPPWebSocket (#877): reaches the socket only through `host`.
import { LogType } from "../../../shared/Logger";
import {
  OcppSecurityProfileConfigError,
  openOcppWebSocket,
  type OcppSocket,
} from "../wsUrlWithBasic";
import { type CloseCause } from "../network-sim";
import { type SocketClose } from "../../../domain/transport/ChargePointSocket";
import {
  classifyFailedAttempt,
  describeConnectError,
  GenerationTokenImpl,
  SUPERSEDED_CLOSE,
  type ConnectErrorDetail,
} from "./closeClassification";
import type { OcppWebSocketHost } from "./socketHost";

export class ConnectionOpener {
  constructor(private readonly host: OcppWebSocketHost) {}

  public connect(
    onopen: (() => void) | null = null,
    onclose: ((ev: SocketClose, cause: CloseCause) => void) | null = null,
  ): void {
    if (this.host.linkBlockedReason !== null) {
      // #930: the cellular link is down. Remember the request and any
      // callbacks, open nothing; restoring service connects.
      if (onopen) this.host.onOpenCallback = onopen;
      if (onclose) this.host.onCloseCallback = onclose;
      this.host.isManualDisconnect = false;
      this.host.resumeOnLinkRestore = !this.host.disposed;
      this.host.logger.info(
        `connect deferred: the cellular link is unavailable (${this.host.linkBlockedReason})`,
        LogType.WEBSOCKET,
      );
      return;
    }
    // #478: a socket the charge point closed (reset, disconnect) fires its
    // close event asynchronously, after this new generation exists. Report it
    // now, so its `disconnected` precedes the next `connected` and its
    // teardown cannot hit the replacement; the late event then only logs.
    const superseded = this.host.socketToken;
    if (this.host.ws === null && superseded && !superseded.closeReported) {
      this.host.reportClose(superseded, SUPERSEDED_CLOSE);
    }
    // A connect during the reconnect backoff supersedes it: left armed, the
    // timer would open another socket over this one and orphan it.
    if (this.host.reconnectTimer) {
      clearTimeout(this.host.reconnectTimer);
      this.host.reconnectTimer = null;
    }

    // Increment generation on new connection
    this.host.generationCounter++;
    this.host.currentGeneration = new GenerationTokenImpl(
      this.host.generationCounter,
    );

    // Store callbacks for reconnection
    if (onopen) this.host.onOpenCallback = onopen;
    if (onclose) this.host.onCloseCallback = onclose;

    this.host.isManualDisconnect = false;
    this.host.selfRequestedClose = false;

    const attempt = this.host.clientCerts.nextTlsOptions();
    this.host.connectionClientCertificate = attempt.tls?.cert;
    let opened = false;
    const onopenHandler = () => {
      opened = true;
      this.host.securityProfileFallback = null;
      this.clearHandshakeTimer();
      this.host.clientCerts.onOpened(attempt.renewed);
      this.host.refusal.clearBudget();
      this.host.urlPool?.onSuccess();
      this.host.handleOpen();
      if (this.host.onOpenCallback) {
        this.host.onOpenCallback();
      }
    };
    const onmessageHandler = (ev: MessageEvent) => {
      this.host.controller.receiveDownstream(ev.data.toString());
    };
    // #1034: the first error of this attempt, before it opened. Bun 1.4.4
    // puts the cause there and closes with a blank 1006. Closure-local, so a
    // superseded socket's late error cannot speak for this attempt, nor
    // silence its refusal probe by reporting a status of its own (#1033).
    let firstError: ConnectErrorDetail | undefined;
    let statusReported = false;
    const onerrorHandler = (ev: Event) => {
      if (!opened) firstError ??= describeConnectError(ev);
      if (this.host.refusal.reportError(ev)) statusReported = true;
    };

    // Capture the current generation for this socket connection
    const socketGeneration = this.host.generationCounter;
    // Kept per socket: a reset's close lands after the next generation is
    // already open, and must still report its own cause (#474).
    const socketToken = this.host.currentGeneration;
    const oncloseHandler = (ev: CloseEvent) => {
      this.clearHandshakeTimer();
      const closeCause = this.host.closeCauseOf(socketToken);
      // Logged for every socket, stale ones included: it is the only line
      // carrying the real close code of a socket a reset superseded, and the
      // CP logs no error for it.
      this.host.logger.info(
        `WebSocket closed: code=${ev.code}, reason=${ev.reason || "none"}, wasClean=${ev.wasClean}, cause=${closeCause}`,
        LogType.WEBSOCKET,
      );
      // Generation guard: only process close if this socket belongs to the current generation
      if (socketGeneration === this.host.generationCounter) {
        if (!opened && !this.host.isManualDisconnect) {
          const fallback = this.host.securityProfileFallback;
          this.host.securityProfileFallback = null;
          fallback?.();
        }
        // Only a failed connection attempt counts, not one the station
        // closed itself before it opened, nor one no CSMS ever saw.
        const kind = opened ? null : classifyFailedAttempt(ev, firstError);
        if (kind && closeCause === "network" && kind !== "unreached") {
          this.host.clientCerts.onFailed(attempt.renewed);
        }
        // #288: ask the CSMS why it refused, unless the client said so.
        const probe = kind === "upgrade-refused" && !statusReported;
        this.host.handleClose(closeCause, probe);
      }
      this.host.reportClose(socketToken, ev);
      // #448: announced once the charge point has handled the close, so an
      // observer sees the disconnect before the reconnect it causes.
      const notice = this.host.pendingReconnectNotice;
      this.host.pendingReconnectNotice = null;
      if (notice) this.host.observers.emit("reconnectScheduled", notice);
      const gaveUp = this.host.pendingGaveUp;
      this.host.pendingGaveUp = null;
      if (gaveUp) this.host.observers.emit("reconnectGaveUp", gaveUp);
    };

    // Resolving here, per attempt, is what keeps the URL list out of
    // everything downstream: the snapshot, the persisted `ws_url` and the log
    // lines all still see one string.
    if (this.host.urlPool) {
      this.host.url = this.host.urlPool.next();
    }

    try {
      this.host.ws = openOcppWebSocket({
        baseUrl: this.host.url,
        chargePointId: this.host.chargePointId,
        basicAuth: this.host.basicAuth,
        extraHeaders: this.host.extraHeaders,
        extraSubprotocols: this.host.extraSubprotocols,
        ocppVersion: this.host.ocppVersion,
        securityProfile: this.host.securityProfile,
        authorizationKey: this.host.authorizationKey,
        cpoName: this.host.cpoName,
        tls: attempt.tls,
        ...(Object.keys(this.host.wsOptions).length > 0
          ? { ws: this.host.wsOptions }
          : {}),
        warn: (message) => this.host.logger.warn(message, LogType.WEBSOCKET),
        onConnectOptions: (options) => {
          this.host.lastConnectOptions = options;
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
        !this.host.credentialsChangedAtRuntime
      ) {
        throw error;
      }
      this.host.logger.error(
        `Cannot open the connection: ${error.message}`,
        LogType.WEBSOCKET,
      );
      const fallback = this.host.securityProfileFallback;
      this.host.securityProfileFallback = null;
      fallback?.();
      this.host.ws = null;
      if (!this.host.isManualDisconnect && !this.host.disposed)
        this.host.attemptReconnect();
      return;
    }
    this.host.socketToken = socketToken;
    this.armHandshakeTimer(this.host.ws);
  }

  /** #611: no runtime times the handshake out natively (Bun never does), so
   *  an attempt that has not opened in time is closed here; it then fails
   *  like any other connection failure and the reconnect policy takes over. */
  private armHandshakeTimer(socket: OcppSocket): void {
    this.clearHandshakeTimer();
    const timeoutMs = this.host.wsOptions.handshakeTimeoutMs;
    if (timeoutMs === undefined) return;
    this.host.handshakeTimer = setTimeout(() => {
      this.host.handshakeTimer = null;
      if (
        this.host.ws !== socket ||
        socket.readyState !== WebSocket.CONNECTING
      ) {
        return;
      }
      this.host.logger.warn(
        `WebSocket handshake timed out after ${timeoutMs} ms (ws.handshakeTimeoutMs)`,
        LogType.WEBSOCKET,
      );
      socket.close();
    }, timeoutMs);
  }

  public clearHandshakeTimer(): void {
    if (this.host.handshakeTimer) {
      clearTimeout(this.host.handshakeTimer);
      this.host.handshakeTimer = null;
    }
  }
}
