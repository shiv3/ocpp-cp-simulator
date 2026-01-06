import { Logger } from "../../shared/Logger";

/**
 * Manages heartbeat functionality for a charge point
 */
export class HeartbeatService {
  private _logger: Logger;
  private _heartbeatInterval: number | null = null;
  private _sendHeartbeatCallback: (() => void) | null = null;

  constructor(logger: Logger) {
    this._logger = logger;
  }

  /**
   * Set the callback function to send heartbeat
   */
  setHeartbeatCallback(callback: () => void): void {
    this._sendHeartbeatCallback = callback;
  }

  /**
   * Send a single heartbeat
   */
  sendHeartbeat(): void {
    if (this._sendHeartbeatCallback) {
      this._sendHeartbeatCallback();
    } else {
      this._logger.error("Heartbeat callback not set");
    }
  }

  /**
   * Start sending periodic heartbeats
   * @param periodSeconds Interval in seconds between heartbeats
   */
  startHeartbeat(periodSeconds: number): void {
    this._logger.info(`Setting heartbeat period to ${periodSeconds}s`);
    this.stopHeartbeat();
    this._heartbeatInterval = setInterval(
      () => this.sendHeartbeat(),
      periodSeconds * 1000,
    );
  }

  /**
   * Stop sending periodic heartbeats
   */
  stopHeartbeat(): void {
    if (this._heartbeatInterval) {
      this._logger.info("Stopping heartbeat");
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stopHeartbeat();
    this._sendHeartbeatCallback = null;
  }
}
