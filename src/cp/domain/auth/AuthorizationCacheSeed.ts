import {
  DEFAULT_AUTHORIZATION_CACHE_MAX_ENTRIES,
  type AuthorizationCacheEntry,
  type AuthorizationCacheRecord,
} from "./AuthorizationCache";

/**
 * The control-plane view of the Authorization Cache (#452): what tests and
 * scenarios read and seed without touching the database. Times are ISO
 * strings here, epoch ms inside the cache.
 */

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

export type AuthorizationStatus = (typeof AUTHORIZATION_STATUSES)[number];

/** At most this many entries in one seed: the cache capacity. */
export const AUTHORIZATION_CACHE_SEED_MAX =
  DEFAULT_AUTHORIZATION_CACHE_MAX_ENTRIES;

export interface AuthorizationCacheSeedEntry {
  idToken: string;
  /** Checked at run time too: callers may hand anything over. */
  status: AuthorizationStatus;
  /** ISO date-time after which the entry counts as Expired. */
  expiresAt?: string;
  /** 1.6 parentIdTag / 2.x groupIdToken. */
  parentId?: string;
}

export interface AuthorizationCacheEntryView {
  idToken: string;
  status: string;
  expiresAt?: string;
  parentId?: string;
  insertedAt: string;
  updatedAt: string;
}

export interface AuthorizationCacheView {
  /** 1.6 AuthorizationCacheEnabled / 2.x AuthCacheCtrlr.Enabled. */
  enabled: boolean;
  entries: AuthorizationCacheEntryView[];
}

/** A seed refused before anything was written. */
export class InvalidAuthorizationCacheSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuthorizationCacheSeedError";
  }
}

const STATUSES: ReadonlySet<string> = new Set(AUTHORIZATION_STATUSES);

/** Check every entry, then convert; throws on the first fault so a refused
 *  seed changes nothing. */
export function parseAuthorizationCacheSeed(
  entries: readonly AuthorizationCacheSeedEntry[],
): AuthorizationCacheRecord[] {
  if (entries.length > AUTHORIZATION_CACHE_SEED_MAX) {
    throw new InvalidAuthorizationCacheSeedError(
      `at most ${AUTHORIZATION_CACHE_SEED_MAX} entries`,
    );
  }
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const where = `entries[${index}]`;
    if (entry.idToken === "") {
      throw new InvalidAuthorizationCacheSeedError(`${where}.idToken is empty`);
    }
    if (seen.has(entry.idToken)) {
      throw new InvalidAuthorizationCacheSeedError(
        `${where}.idToken ${entry.idToken} appears twice`,
      );
    }
    seen.add(entry.idToken);
    if (!STATUSES.has(entry.status)) {
      throw new InvalidAuthorizationCacheSeedError(
        `${where}.status ${entry.status} is not an authorization status`,
      );
    }
    if (entry.parentId === "") {
      throw new InvalidAuthorizationCacheSeedError(
        `${where}.parentId is empty`,
      );
    }
    const expiresAt =
      entry.expiresAt !== undefined ? Date.parse(entry.expiresAt) : undefined;
    if (expiresAt !== undefined && !Number.isFinite(expiresAt)) {
      throw new InvalidAuthorizationCacheSeedError(
        `${where}.expiresAt is not a date`,
      );
    }
    return {
      idToken: entry.idToken,
      status: entry.status,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}),
    };
  });
}

export function authorizationCacheEntryView(
  entry: AuthorizationCacheEntry,
): AuthorizationCacheEntryView {
  return {
    idToken: entry.idToken,
    status: entry.status,
    ...(entry.expiresAt !== undefined
      ? { expiresAt: new Date(entry.expiresAt).toISOString() }
      : {}),
    ...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}),
    insertedAt: new Date(entry.insertedAt).toISOString(),
    updatedAt: new Date(entry.updatedAt).toISOString(),
  };
}
