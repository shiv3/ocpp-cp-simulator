import type { EventEmitter } from "../../shared/EventEmitter";

export interface HeartbeatServiceEvents {
  /** Fired whenever the public state of the heartbeat changes (interval
   *  set/cleared, heartbeat sent, etc.) so UI can render up-to-date info. */
  stateChange: {
    intervalSeconds: number;
    lastSentAt: Date | null;
  };
}

/**
 * The station's heartbeat (OCPP 1.6 §4.6) as the charge point and the code
 * around it use it. `HeartbeatService` (application) implements it;
 * `ChargePoint.heartbeat` returns it.
 */
export interface ChargePointHeartbeat {
  /** Interval requested by the CSMS; 0 disables the heartbeat. */
  readonly intervalSeconds: number;
  /** When the most recent Heartbeat.req was sent. */
  readonly lastSentAt: Date | null;
  readonly events: EventEmitter<HeartbeatServiceEvents>;

  /** What sends a Heartbeat.req when the timer fires. */
  setHeartbeatCallback(callback: () => void): void;
  /** Send a Heartbeat.req now. */
  sendHeartbeat(): void;
  /** Set the interval and arm the idle timer; 0 disables the heartbeat. */
  startHeartbeat(periodSeconds: number): void;
  /** Set the interval to 0 and stop the timer. */
  stopHeartbeat(): void;
  /** Any CALL went out: rearm the idle timer. */
  notifyOutgoingCall(): void;
  /** A Heartbeat.req went out: stamp `lastSentAt`. */
  markHeartbeatSent(): void;
  /** Stop the idle timer; the interval and the callback stay. */
  cleanup(): void;
}
