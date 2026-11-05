// Authorization Cache vocabulary (#452): the statuses a CSMS can answer and
// the bound on one seed. The cache itself lives in `cp/domain/auth`.

/** Every authorization status a CSMS can answer: the 1.6 AuthorizationStatus
 *  values (Accepted, Blocked, Expired, Invalid, ConcurrentTx) and the 2.x
 *  AuthorizationStatusEnumType additions. */
export const AUTHORIZATION_STATUSES = [
  "Accepted",
  "Blocked",
  "ConcurrentTx",
  "Expired",
  "Invalid",
  "NoCredit",
  "NotAllowedTypeEVSE",
  "NotAtThisLocation",
  "NotAtThisTime",
  "Unknown",
] as const;

/**
 * At most this many entries in one seed: the cache capacity.
 * `DEFAULT_AUTHORIZATION_CACHE_MAX_ENTRIES` is this value.
 */
export const AUTHORIZATION_CACHE_SEED_MAX = 1000;
