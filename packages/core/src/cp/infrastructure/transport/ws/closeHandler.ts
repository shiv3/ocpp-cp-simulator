// Split out of OCPPWebSocket (#877): reaches the socket only through `host`.
import { LogType } from "../../../shared/Logger";
import { type GenerationToken, type CloseCause } from "../network-sim";
import { type SocketClose } from "../../../domain/transport/ChargePointSocket";
import type { GenerationTokenImpl } from "./closeClassification";
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

  /** @param probeRefusal a refused upgrade whose status the client hid:
   *  ask the CSMS (#288), never after a manual disconnect. */
  public handleClose(closeCause: CloseCause, probeRefusal: boolean): void {
    if (probeRefusal && !this.host.isManualDisconnect && !this.host.disposed) {
      this.host.refusal.probe(
        this.host.lastConnectOptions,
        this.host.generationCounter,
      );
    }
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
