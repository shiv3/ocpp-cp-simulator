/**
 * The OCPP identity of a charge point (the `cpId` appended to the WebSocket
 * URL) and the rules for renaming it through `ChargePointIdentity`
 * (OCPP 1.6 vendor key) / `SecurityCtrlr.Identity` (2.x) (#924).
 */

/** The configuration key behind both `ChargePointIdentity` (1.6) and
 *  `SecurityCtrlr.Identity` (2.x). It always holds the ACTIVE identity. */
export const CHARGE_POINT_IDENTITY_KEY = "ChargePointIdentity";

/**
 * Where a pending (accepted, not yet applied) identity is stored in the
 * per-charge-point `configuration` table. It is not a configuration key, so
 * the store never loads it as a value; it moves with the `cp_id` rename.
 * An empty string means "nothing pending".
 */
export const PENDING_IDENTITY_OVERRIDE = "$pendingChargePointIdentity";

/** Same limit as the 1.6 `chargeBoxIdentity` (CiString48Type). */
export const CHARGE_POINT_IDENTITY_MAX_LENGTH = 48;

const SAFE_IDENTITY = /^[A-Za-z0-9._~-]+$/;

/**
 * Why `value` cannot be an identity, or `undefined` when it can: non-empty,
 * at most {@link CHARGE_POINT_IDENTITY_MAX_LENGTH} characters, and only URL
 * path unreserved characters (letters, digits, `.`, `_`, `~`, `-`), so it
 * can be appended to the URL without escaping.
 */
export function chargePointIdentityRejection(
  value: string,
): string | undefined {
  if (value === "") return "the identity is empty";
  if (value.length > CHARGE_POINT_IDENTITY_MAX_LENGTH) {
    return `the identity is longer than ${CHARGE_POINT_IDENTITY_MAX_LENGTH} characters`;
  }
  if (!SAFE_IDENTITY.test(value)) {
    return "the identity may only contain letters, digits, '.', '_', '~' and '-'";
  }
  return undefined;
}

/** What the host that owns a charge point's identity provides. */
export interface IdentityRenameHost {
  /** Whether another charge point of this simulator already has `id`. */
  isTaken(id: string): boolean;
  /**
   * The charge point reboots (Reset): apply the pending identity now.
   * Returns true when the host took the charge point over (it is rebuilt
   * under the new identity and this instance must do nothing more).
   */
  applyAtReboot(newId: string): boolean;
}
