import { OCPPAction } from "../../../domain/types/OcppTypes";
import { realClock } from "../../../shared/clock";
import type { SimClock } from "../../../shared/clock";

/**
 * §4.2 Boot gate status union type.
 * - Idle: pre-handshake; only BootNotification allowed
 * - Pending: BootNotification.conf received with status=Pending; only BootNotification allowed
 * - Accepted: BootNotification.conf received with status=Accepted; all CALLs allowed
 * - Rejected: BootNotification.conf received with status=Rejected; blocked until retryAfter
 */
export type BootGateStatus =
  | { status: "Idle" }
  | { status: "Accepted" }
  | { status: "Pending" }
  | { status: "Rejected"; retryAfter: Date };

/**
 * Unified boot gate state machine shared by WebSocket and SOAP transports.
 *
 * Outgoing CALLs are restricted while BootNotification has not yet been Accepted.
 * BootNotification itself + the CALLRESULT replies are always permitted (they're how
 * the handshake unblocks).
 *
 * - Pending: only allow BootNotification (e.g. TriggerMessage-driven resend).
 *   Other CALLs are blocked.
 * - Rejected: nothing goes out at all until retryAfter elapses.
 * - Idle (pre-handshake): allow BootNotification only.
 */
export class BootGate {
  private _status: BootGateStatus = { status: "Idle" };
  /** Depth of the {@link runTriggered} scopes currently running. */
  private _triggered = 0;

  constructor(private readonly clock: SimClock = realClock) {}

  /**
   * Get the current boot gate status.
   */
  get status(): BootGateStatus {
    return this._status;
  }

  /**
   * Set the boot gate status. Typically called by BootNotificationResultHandler
   * when a BootNotification.conf response is received.
   */
  set(status: BootGateStatus): void {
    this._status = status;
  }

  /**
   * Run `fn` as the answer to an accepted TriggerMessage. §4.2: a Pending
   * station may send "unless it has been instructed by the Central System to
   * do so with a TriggerMessage.req", so a CALL made synchronously inside
   * `fn` passes the gate while Pending. Idle and Rejected are not widened:
   * a Rejected station stays silent until the retry interval has passed.
   */
  runTriggered<T>(fn: () => T): T {
    this._triggered++;
    try {
      return fn();
    } finally {
      this._triggered--;
    }
  }

  /**
   * Check whether an outgoing CALL with the given action is allowed.
   *
   * @param action The OCPP action to check
   * @param now Optional current time (defaults to the gate's clock)
   * @returns true if the action is allowed, false otherwise
   */
  isCallAllowed(action: OCPPAction, now?: Date): boolean {
    // BootNotification is always exempt — it's required to unblock the gate.
    if (action === OCPPAction.BootNotification) return true;

    const currentTime = now ?? new Date(this.clock.now());

    switch (this._status.status) {
      case "Accepted":
        // After Accepted, all CALLs are allowed.
        return true;
      case "Pending":
        // In Pending, only BootNotification is allowed (checked above), plus
        // what a TriggerMessage asked for (§4.2).
        return this._triggered > 0;
      case "Rejected":
        // In Rejected, check if retryAfter has elapsed.
        return currentTime >= this._status.retryAfter;
      case "Idle":
        // Pre-handshake: only BootNotification is allowed (checked above).
        return false;
    }
  }
}
