import { OCPPAction } from "../../../domain/types/OcppTypes";

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
   * Check whether an outgoing CALL with the given action is allowed.
   *
   * @param action The OCPP action to check
   * @param now Optional current time (defaults to new Date() for testing)
   * @returns true if the action is allowed, false otherwise
   */
  isCallAllowed(action: OCPPAction, now?: Date): boolean {
    // BootNotification is always exempt — it's required to unblock the gate.
    if (action === OCPPAction.BootNotification) return true;

    const currentTime = now ?? new Date();

    switch (this._status.status) {
      case "Accepted":
        // After Accepted, all CALLs are allowed.
        return true;
      case "Pending":
        // In Pending, only BootNotification is allowed (checked above).
        return false;
      case "Rejected":
        // In Rejected, check if retryAfter has elapsed.
        return currentTime >= this._status.retryAfter;
      case "Idle":
        // Pre-handshake: only BootNotification is allowed (checked above).
        return false;
    }
  }
}
