/**
 * Station-side authorization decision (issue #452): whether a presented
 * identifier can be accepted or rejected locally, or must be sent to the
 * CSMS. Pure — no clock, no configuration store, no transport — so OCPP
 * 1.6 configuration keys and 2.x device-model variables both map onto the
 * same {@link LocalAuthorizationPolicy}.
 *
 * Precedence and rules (OCPP 1.6 Part 2 §3.5, §4.1, §9.1; 2.0.1 Part 2
 * C10, C12-C15):
 *
 * - The Local Authorization List wins over the Authorization Cache for the
 *   same identifier (1.6 §3.5.3, C13.FR.01, C14.FR.01).
 * - An entry whose expiry date has passed counts as `Expired` (1.6 §3.5.1
 *   "SHALL be changed to expired", §3.5.4, C10.FR.10). A cache entry older
 *   than the cache lifetime is not in the cache at all (C10.FR.08).
 * - Online: a valid (`Accepted`) entry starts without an Authorize round
 *   trip only when `localPreAuthorize` is set (1.6 §9.1.13, C12.FR.02,
 *   C14.FR.02). Anything else asks the CSMS: an unknown identifier (1.6
 *   §4.1 SHALL), a NOT-valid cache entry (1.6 §3.5.1, C10.FR.03,
 *   C12.FR.05), a NOT-valid list entry (C14.FR.03, C14.FR.05).
 * - Offline: a known NOT-valid identifier is rejected with its status (1.6
 *   §3.5.4 MUST, C13.FR.02/.05). A known valid identifier is accepted when
 *   `localAuthorizeOffline` is set (1.6 §9.1.12); otherwise it is not
 *   locally authorized and falls to the unknown-identifier rule. An unknown
 *   identifier is accepted only with `allowOfflineTxForUnknownId` (1.6
 *   §3.5.4, C15.FR.08), else rejected (C15 scenario step 5).
 */

/** Configuration-agnostic switches the decision reads. */
export interface LocalAuthorizationPolicy {
  /** 1.6 `AuthorizationCacheEnabled`; 2.x `AuthCacheCtrlr.Enabled`. */
  cacheEnabled: boolean;
  /** 1.6 `LocalAuthListEnabled`; 2.x `LocalAuthListCtrlr.Enabled`. */
  localListEnabled: boolean;
  /** 1.6 `LocalPreAuthorize`; 2.x `AuthCtrlr.LocalPreAuthorize`. */
  localPreAuthorize: boolean;
  /** 1.6 `LocalAuthorizeOffline`; 2.x `AuthCtrlr.LocalAuthorizeOffline`. */
  localAuthorizeOffline: boolean;
  /** 1.6 `AllowOfflineTxForUnknownId`; 2.x
   *  `AuthCtrlr.OfflineTxForUnknownIdEnabled`. */
  allowOfflineTxForUnknownId: boolean;
  /** 2.x `AuthCacheCtrlr.LifeTime` in seconds, counted from the entry's
   *  last update; `null` means no lifetime (1.6 has no such key). */
  cacheLifetimeSeconds: number | null;
  /** Whether local-list expiry dates are honoured. 1.6: `true` (§3.5.4);
   *  2.x: `LocalAuthListCtrlr.SupportsExpiryDateTime` (C13.FR.02/.05). */
  localListChecksExpiry: boolean;
}

/** What the resolver needs to know about a stored entry. */
export interface KnownAuthorization {
  status: string;
  /** Epoch ms after which the entry counts as `Expired`. */
  expiresAt?: number;
}

export interface CachedAuthorization extends KnownAuthorization {
  /** Epoch ms of the last update, for the cache lifetime. */
  updatedAt: number;
}

export interface LocalAuthorizationInput {
  online: boolean;
  policy: LocalAuthorizationPolicy;
  localListEntry?: KnownAuthorization;
  cacheEntry?: CachedAuthorization;
  /** Epoch ms. */
  now: number;
}

/** Where a decision came from. `unknownOffline`: no usable entry, offline. */
export type LocalAuthorizationSource = "localList" | "cache" | "unknownOffline";

export type LocalAuthorizationDecision =
  | { kind: "accept"; source: LocalAuthorizationSource }
  | { kind: "reject"; source: LocalAuthorizationSource; status: string }
  | { kind: "askCsms"; source: "localList" | "cache" | "none" };

/** A decision taken without the CSMS. */
export type LocalOnlyDecision = Exclude<
  LocalAuthorizationDecision,
  { kind: "askCsms" }
>;

/** Status reported when an unknown identifier is refused offline. */
export const UNKNOWN_OFFLINE_REJECT_STATUS = "Invalid";

const ACCEPTED = "Accepted";

/** Stored status, or `Expired` once an Accepted entry's expiry has passed. */
export function effectiveStatus(
  entry: KnownAuthorization,
  now: number,
): string {
  if (
    entry.status === ACCEPTED &&
    entry.expiresAt !== undefined &&
    entry.expiresAt <= now
  ) {
    return "Expired";
  }
  return entry.status;
}

export function resolveLocalAuthorization(
  input: LocalAuthorizationInput,
): LocalAuthorizationDecision {
  const { online, policy } = input;
  const known = knownEntry(input);

  if (online) {
    if (known && known.status === ACCEPTED && policy.localPreAuthorize) {
      return { kind: "accept", source: known.source };
    }
    return { kind: "askCsms", source: known?.source ?? "none" };
  }
  return offlineDecision(policy, known);
}

/** The offline rules alone: never asks the CSMS. */
export function resolveOfflineAuthorization(
  input: Omit<LocalAuthorizationInput, "online">,
): LocalOnlyDecision {
  return offlineDecision(input.policy, knownEntry(input));
}

function offlineDecision(
  policy: LocalAuthorizationPolicy,
  known: { source: "localList" | "cache"; status: string } | undefined,
): LocalOnlyDecision {
  if (known && known.status !== ACCEPTED) {
    return { kind: "reject", source: known.source, status: known.status };
  }
  if (known && policy.localAuthorizeOffline) {
    return { kind: "accept", source: known.source };
  }
  if (policy.allowOfflineTxForUnknownId) {
    return { kind: "accept", source: "unknownOffline" };
  }
  return {
    kind: "reject",
    source: "unknownOffline",
    status: UNKNOWN_OFFLINE_REJECT_STATUS,
  };
}

/** The entry that decides, local list first, with its effective status. */
function knownEntry(
  input: Omit<LocalAuthorizationInput, "online">,
): { source: "localList" | "cache"; status: string } | undefined {
  const { policy, now, localListEntry, cacheEntry } = input;
  if (policy.localListEnabled && localListEntry) {
    const status = policy.localListChecksExpiry
      ? effectiveStatus(localListEntry, now)
      : localListEntry.status;
    return { source: "localList", status };
  }
  if (policy.cacheEnabled && cacheEntry && withinLifetime(input, cacheEntry)) {
    return { source: "cache", status: effectiveStatus(cacheEntry, now) };
  }
  return undefined;
}

function withinLifetime(
  input: Omit<LocalAuthorizationInput, "online">,
  entry: CachedAuthorization,
): boolean {
  const lifetime = input.policy.cacheLifetimeSeconds;
  if (lifetime === null) return true;
  return input.now < entry.updatedAt + lifetime * 1000;
}
