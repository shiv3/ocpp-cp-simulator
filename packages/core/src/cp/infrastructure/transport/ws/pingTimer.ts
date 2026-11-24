// Split out of OCPPWebSocket (#877): reaches the socket only through `host`.
import { WS_READY_STATE } from "./readyState";
import { LogType } from "../../../shared/Logger";
import type { OcppWebSocketHost } from "./socketHost";

export class PingTimer {
  constructor(private readonly host: OcppWebSocketHost) {}

  /**
   * #406: apply `WebSocketPingInterval`. Takes effect at once on an open
   * socket and on every later open; 0 stops the client-side ping.
   */
  public setPingInterval(seconds: number): void {
    if (seconds === this.host.pingIntervalSeconds) return;
    this.host.pingIntervalSeconds = seconds;
    this.host.logger.info(
      seconds > 0 ? `WebSocket ping every ${seconds}s` : "WebSocket ping off",
      LogType.WEBSOCKET,
    );
    this.startPingInterval();
  }

  /**
   * #406: ping frames are WebSocket control frames, not OCPP messages, so
   * they bypass the network-sim pipelines and are not logged one by one.
   */
  public startPingInterval(): void {
    this.stopPingInterval();
    const seconds = this.host.pingIntervalSeconds;
    if (seconds <= 0 || !this.host.isConnected()) return;
    this.host.pingInterval = setInterval(() => {
      if (!this.host.ws || this.host.ws.readyState !== WS_READY_STATE.OPEN)
        return;
      try {
        this.host.ws.ping();
      } catch (error) {
        this.host.logger.warn(
          `WebSocket ping failed: ${String(error)}`,
          LogType.WEBSOCKET,
        );
      }
    }, seconds * 1000);
  }

  public stopPingInterval(): void {
    if (this.host.pingInterval) {
      clearInterval(this.host.pingInterval);
      this.host.pingInterval = null;
    }
  }
}
