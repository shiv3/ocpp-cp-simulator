// Split out of OCPPWebSocket (#877): reaches the socket only through `host`.
import { LogType } from "../../../shared/Logger";
import { nextReconnectDelayMs } from "../../../shared/ReconnectPolicy";
import type { DisconnectRuleType } from "../network-sim";
import type { OcppWebSocketHost } from "./socketHost";

export class ReconnectScheduler {
  constructor(private readonly host: OcppWebSocketHost) {}

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
    if (this.host.disposed || reason === this.host.linkBlockedReason) return;
    if (reason !== null) {
      const hadLink =
        !this.host.isManualDisconnect &&
        (this.host.ws !== null || this.host.reconnectTimer !== null);
      this.host.linkBlockedReason = reason;
      this.host.resumeOnLinkRestore = this.host.resumeOnLinkRestore || hadLink;
      if (this.host.reconnectTimer) {
        clearTimeout(this.host.reconnectTimer);
        this.host.reconnectTimer = null;
      }
      this.host.reconnectAttempts = 0;
      this.host.reconnectNotBefore = null;
      this.host.pendingReconnectNotice = null;
      if (this.host.ws) {
        this.host.runCloseTransaction("simulated");
        this.host.selfRequestedClose = true;
        this.host.ws.close();
        this.host.ws = null;
        this.host.stopPingInterval();
      }
      return;
    }
    this.host.linkBlockedReason = null;
    if (!this.host.resumeOnLinkRestore) return;
    this.host.resumeOnLinkRestore = false;
    this.host.reconnectAttempts = 0;
    this.host.logger.info(
      "The cellular link is restored; reconnecting",
      LogType.WEBSOCKET,
    );
    this.host.connect();
  }

  public attemptReconnect(): void {
    // #930: an administratively down link is not a failed attempt.
    if (this.host.linkBlockedReason !== null) return;
    // Clear any existing reconnect timer
    if (this.host.reconnectTimer) {
      clearTimeout(this.host.reconnectTimer);
      this.host.reconnectTimer = null;
    }

    this.host.reconnectAttempts++;

    const decision = nextReconnectDelayMs(
      this.host.reconnectPolicy,
      this.host.reconnectAttempts,
      this.host.reconnectRandom,
      this.host.retryBackOff,
    );
    if (decision.kind === "give-up") {
      const attempts = this.host.reconnectAttempts - 1;
      this.host.logger.warn(
        `Giving up reconnecting after ${attempts} attempt(s) (reconnect.maxAttempts=${this.host.reconnectPolicy.maxAttempts})`,
        LogType.WEBSOCKET,
      );
      // A later explicit connect() starts with a fresh budget.
      this.host.reconnectAttempts = 0;
      this.host.reconnectNotBefore = null;
      this.host.pendingReconnectNotice = null;
      // Announced with the close, after the disconnect it follows.
      this.host.pendingGaveUp = { attempts };
      return;
    }
    const backoffDelay = decision.delayMs;

    // Reconnect reservation: the actual scheduled delay is the max of the backoff
    // and the remaining time until reconnectNotBefore
    const reservationDelay = this.host.reconnectNotBefore
      ? Math.max(0, this.host.reconnectNotBefore - Date.now())
      : 0;
    const actualDelay = Math.max(backoffDelay, reservationDelay);

    this.host.logger.info(
      `Reconnecting in ${actualDelay / 1000}s... (attempt ${this.host.reconnectAttempts})`,
      LogType.WEBSOCKET,
    );
    this.host.pendingReconnectNotice = {
      attempt: this.host.reconnectAttempts,
      delayMs: actualDelay,
    };

    this.host.reconnectTimer = setTimeout(() => {
      this.host.reconnectTimer = null;

      // Consume the reservation at socket-open attempt (irreversible consumption point)
      this.host.reconnectNotBefore = null;

      this.host.logger.info(
        `Attempting reconnection (attempt ${this.host.reconnectAttempts})...`,
        LogType.WEBSOCKET,
      );
      this.host.connect();
    }, actualDelay);
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
    if (this.host.disposed) {
      return;
    }

    // Observers learn of the fault while the socket is still up, so the
    // `disconnected` that follows can be attributed to this rule.
    this.host.observers.emit("simulatedDisconnect", {
      ruleId,
      ruleType,
      reconnectDelayMs,
    });

    // FIRST install the reservation BEFORE draining
    this.host.reconnectNotBefore = Date.now() + reconnectDelayMs;

    // THEN run the close transaction for a 'simulated' cause
    this.host.runCloseTransaction("simulated");

    // Injected by this charge point's own fault simulator, so it is not
    // evidence about the supervision URL — see `_selfRequestedClose`.
    this.host.selfRequestedClose = true;

    // THEN close the socket WITHOUT setting _isManualDisconnect
    if (this.host.ws) {
      this.host.ws.close();
      this.host.ws = null;
    }
    this.host.stopPingInterval();
  }
}
