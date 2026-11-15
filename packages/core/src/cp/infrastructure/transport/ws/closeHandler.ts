// Split out of OCPPWebSocket (#877): reaches the socket only through `host`.
import { LogType } from "../../../shared/Logger";
import { redactSensitiveText } from "../../../shared/redaction";
import { probeUpgradeRefusal } from "../wsUrlWithBasic";
import { type GenerationToken, type CloseCause } from "../network-sim";
import { type SocketClose } from "../../../domain/transport/ChargePointSocket";
import type { GenerationTokenImpl } from "./closeClassification";
import { describeRefusal } from "./closeClassification";
import type { OcppWebSocketHost } from "./socketHost";

export class CloseHandler {
  constructor(private readonly host: OcppWebSocketHost) {}

  public handleOpen(): void {
    this.host.logger.info(
      "WebSocket connected successfully",
      LogType.WEBSOCKET,
    );

    // Reset reconnect attempts on successful connection
    if (this.host.reconnectAttempts > 0) {
      this.host.logger.info(
        `Reconnection successful after ${this.host.reconnectAttempts} attempt(s)`,
        LogType.WEBSOCKET,
      );
    }
    this.host.reconnectAttempts = 0;

    // Call controller.onSocketOpen() to arm periodic timers
    this.host.controller.onSocketOpen();

    this.host.startPingInterval();
  }

  /**
   * Close transaction: idempotent per generation.
   * Determines close cause (manual vs network), latches it on the current generation,
   * drains pipelines, invokes the close-transaction callback, and (implicitly via handleClose)
   * registers a reconnect request if applicable.
   */
  public runCloseTransaction(closeCause: CloseCause): void {
    // If the current generation's cause is already latched, this is idempotent — return
    if (this.host.currentGeneration.closeCause !== null) {
      return;
    }

    // Latch the cause on the current generation token
    this.host.currentGeneration.latchCloseCause(closeCause);

    // Drain pipelines synchronously (custody callbacks run inline)
    this.host.controller.shutdownPipelines({
      reason: "socket_closed",
      closeCause,
    });

    // Invoke the close-transaction callback (for Task 7/8/9 effect flushing)
    if (this.host.onCloseTransactionCallback) {
      try {
        this.host.onCloseTransactionCallback(this.host.currentGeneration);
      } catch {
        // Callback exception isolation
      }
    }
    this.host.observers.emit("closed", { cause: closeCause });
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
  public handleError(evt: Event): void {
    const detail = evt as {
      type: string;
      message?: string;
      httpStatus?: number;
      httpLocation?: string;
    };
    if (typeof detail.httpStatus === "number") {
      this.host.refusalStatusReported = true;
      this.host.logger.error(
        describeRefusal(detail.httpStatus, detail.httpLocation),
        LogType.WEBSOCKET,
      );
      return;
    }
    this.host.logger.error(
      detail.message
        ? // The client's message quotes the connection URL, which may carry
          // `user:password@host` credentials -- redact before logging.
          `WebSocket error: ${redactSensitiveText(detail.message)}`
        : `WebSocket error type: ${detail.type}`,
      LogType.WEBSOCKET,
    );
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
    if (this.host.isManualDisconnect || this.host.disposed) return;
    if (this.host.refusalStatusReported) return;
    if (ev.code !== 1002 || !/expected 101/i.test(ev.reason ?? "")) return;
    const options = this.host.lastConnectOptions;
    if (!options) return;
    const now = Date.now();
    if (now - this.host.lastRefusalProbeAt < 60_000) return;
    this.host.lastRefusalProbeAt = now;
    // The probe is a round trip, and the reconnect loop may well win it. A
    // refusal logged against a charge point that is connected again reads as
    // a live problem, so the answer is dropped unless it still describes the
    // connection that asked the question.
    const probedGeneration = this.host.generationCounter;
    void probeUpgradeRefusal(options)
      .then((detail) => {
        if (this.host.disposed || !detail) return;
        if (this.host.generationCounter !== probedGeneration) return;
        if (this.host.ws?.readyState === WebSocket.OPEN) return;
        this.host.logger.error(
          `${describeRefusal(detail.status, detail.location)} (diagnostic GET after the handshake failed)`,
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
  public closeCauseOf(token: GenerationToken): CloseCause {
    if (token.closeCause !== null) return token.closeCause;
    return this.host.disposed || this.host.isManualDisconnect
      ? "manual"
      : "network";
  }

  /** Tells the charge point a generation's socket closed, once per socket. */
  public reportClose(token: GenerationTokenImpl, ev: SocketClose): void {
    if (token.closeReported) return;
    token.closeReported = true;
    this.host.onCloseCallback?.(ev, this.closeCauseOf(token));
  }

  public handleClose(ev: CloseEvent, closeCause: CloseCause): void {
    this.maybeProbeRefusal(ev);
    this.host.stopPingInterval();

    if (this.host.disposed) {
      // Transport is disposed — terminal state, ignore close events
      return;
    }

    // Run the close transaction (idempotent per generation; a cause the
    // charge point latched itself is kept)
    this.runCloseTransaction(closeCause);

    // Only attempt reconnect if not manually disconnected
    if (!this.host.isManualDisconnect) {
      // Only a close the charge point did not ask for counts as a failure of
      // the URL in use. A reset, or an injected disconnect, says nothing about
      // the node and must not push an affinity pool off its primary.
      if (!this.host.selfRequestedClose) this.host.urlPool?.onFailure();
      this.host.attemptReconnect();
    }
  }
}
