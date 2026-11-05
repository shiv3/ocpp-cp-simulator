import { Logger } from "../../shared/Logger";
import { EventEmitter } from "../../shared/EventEmitter";

export interface HeartbeatServiceEvents {
  /** Fired whenever the public state of the heartbeat changes (interval
   *  set/cleared, heartbeat sent, etc.) so UI can render up-to-date info. */
  stateChange: {
    intervalSeconds: number;
    lastSentAt: Date | null;
  };
}

/**
 * OCPP 1.6 §4.6 Heartbeat.
 *
 * Spec: "The Charge Point SHALL send a Heartbeat.req PDU whenever no other
 * message was sent during the configured Heartbeat interval." That is, the
 * Heartbeat is a fallback for an otherwise idle connection — every outgoing
 * CALL (BootNotification, StatusNotification, MeterValues, etc.) resets the
 * heartbeat timer because the CSMS gets its `currentTime` back from those
 * `*.conf` responses just as it would from a Heartbeat.
 *
 * Implementation: a `setTimeout` that we rearm every time we send any CALL
 * (via {@link notifyOutgoingCall}). When the timeout fires we send a
 * Heartbeat.req, which itself routes through `OCPPMessageHandler.sendRequest`
 * and therefore re-calls {@link notifyOutgoingCall}, chaining the next
 * timeout. `intervalSeconds = 0` disables the heartbeat entirely.
 */
export class HeartbeatService {
  private readonly _events = new EventEmitter<HeartbeatServiceEvents>();
  private _logger: Logger;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _sendHeartbeatCallback: (() => void) | null = null;
  /** Interval requested by the CSMS (BootNotification.conf.interval or
   *  ChangeConfiguration HeartbeatInterval). 0 disables. */
  private _intervalSeconds = 0;
  /** Wall-clock time of the most recent Heartbeat.req we sent (for UI). */
  private _lastSentAt: Date | null = null;

  constructor(logger: Logger) {
    this._logger = logger;
  }

  get events(): EventEmitter<HeartbeatServiceEvents> {
    return this._events;
  }

  get intervalSeconds(): number {
    return this._intervalSeconds;
  }

  get lastSentAt(): Date | null {
    return this._lastSentAt;
  }

  setHeartbeatCallback(callback: () => void): void {
    this._sendHeartbeatCallback = callback;
  }

  /**
   * Send a Heartbeat.req now (e.g. user pressed "Send Heartbeat" or a scenario
   * fired a Heartbeat notification node). Counts as activity, so the idle
   * timer rearms via {@link notifyOutgoingCall} just like any other CALL.
   */
  sendHeartbeat(): void {
    if (!this._sendHeartbeatCallback) {
      this._logger.error("Heartbeat callback not set");
      return;
    }
    this._sendHeartbeatCallback();
  }

  /**
   * Configure the heartbeat interval and arm the idle timer. `periodSeconds`
   * comes straight from BootNotification.conf.interval (boot path) or
   * ChangeConfiguration HeartbeatInterval (runtime path). `0` disables.
   */
  startHeartbeat(periodSeconds: number): void {
    this._intervalSeconds = Math.max(0, Math.floor(periodSeconds));
    if (this._intervalSeconds === 0) {
      this._logger.info("Heartbeat interval=0, periodic Heartbeat disabled");
      this.clearTimer();
    } else {
      this._logger.info(
        `Heartbeat interval set to ${this._intervalSeconds}s (idle-timer)`,
      );
      this.armTimer();
    }
    this.emitState();
  }

  /** Cleared by ChangeConfiguration interval=0 or by reconnect/teardown. */
  stopHeartbeat(): void {
    this._intervalSeconds = 0;
    this.clearTimer();
    this.emitState();
  }

  /**
   * Called by the transport whenever ANY outgoing CALL leaves the CP. Resets
   * the idle timer so we only fire a Heartbeat.req when nothing else has
   * gone out for `intervalSeconds`. Heartbeat.req itself comes through this
   * path, so the next firing is naturally scheduled `intervalSeconds` after
   * the last successful send.
   *
   * Callers should also distinguish "this CALL was the Heartbeat itself" so
   * we can stamp lastSentAt. Use {@link markHeartbeatSent} for that.
   */
  notifyOutgoingCall(): void {
    if (this._intervalSeconds > 0) this.armTimer();
  }

  /** Stamp lastSentAt — called from the transport when the outgoing CALL is
   *  specifically a Heartbeat.req, so the UI can show "last sent Xs ago". */
  markHeartbeatSent(): void {
    this._lastSentAt = new Date();
    this.emitState();
  }

  /**
   * Stop the idle timer. Called from `ChargePoint.teardownAfterClose` on
   * WebSocket close so a stale timer doesn't try to send a Heartbeat onto
   * a half-open connection.
   *
   * Note we deliberately do NOT clear `_sendHeartbeatCallback`: that
   * callback is set ONCE in the `ChargePoint` constructor and is wired
   * to the stable `OCPPMessageHandler` instance, which lives for the
   * lifetime of the `ChargePoint`. Nulling it here would break the
   * reconnect path — `BootNotificationResultHandler` calls
   * `startHeartbeat(interval)` on the very same `HeartbeatService`
   * instance, the timer rearms, fires after `interval` seconds, calls
   * `sendHeartbeat()`, and would crash with "Heartbeat callback not
   * set" because nothing re-installs the callback. The CSMS then
   * disconnects on its PingWait (60s with no inbound traffic) and the
   * cycle repeats every minute. See shiv3-cp7's logs around
   * 2026-06-02T09:25-09:31 for the symptom.
   */
  cleanup(): void {
    this.clearTimer();
  }

  private armTimer(): void {
    this.clearTimer();
    this._timer = setTimeout(() => {
      this._timer = null;
      // Send fires sendRequest → notifyOutgoingCall → armTimer for the next
      // window, so we don't have to re-arm here. markHeartbeatSent runs from
      // the transport hook below.
      this.sendHeartbeat();
    }, this._intervalSeconds * 1000);
  }

  private clearTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private emitState(): void {
    this._events.emit("stateChange", {
      intervalSeconds: this._intervalSeconds,
      lastSentAt: this._lastSentAt,
    });
  }
}
