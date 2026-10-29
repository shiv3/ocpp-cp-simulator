import {
  DEFAULT_AUTHORIZATION_CACHE_MAX_ENTRIES,
  type AuthorizationCacheEntry,
  type AuthorizationCacheRecord,
} from "./AuthorizationCache";
import { idTokenKey } from "./idTokenKey";
import { OCPP_2_0_1, OCPP_2_1 } from "../types/OcppVersion";

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

/**
 * The longest identifier a charge point of `ocppVersion` carries, for
 * `idToken` and `parentId` alike: 1.6 Part 2 §7.28 IdToken is a
 * CiString20Type (1.2, 1.5 and 1.6S use the same type); 2.x
 * IdTokenType.idToken, which groupIdToken is too, is identifierString
 * [0..36] in 2.0.1 and [0..255] in 2.1 (vendor/ocpp-schemas
 * AuthorizeRequest.json).
 */
export function idTokenMaxLength(ocppVersion: string): number {
  if (ocppVersion === OCPP_2_1) return 255;
  if (ocppVersion === OCPP_2_0_1) return 36;
  return 20;
}

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
 *  seed changes nothing. `maxLength` bounds `idToken` and `parentId`
 *  ({@link idTokenMaxLength}); identifiers compare case-insensitively
 *  ({@link idTokenKey}). */
export function parseAuthorizationCacheSeed(
  entries: readonly AuthorizationCacheSeedEntry[],
  maxLength: number,
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
    if (entry.idToken.length > maxLength) {
      throw new InvalidAuthorizationCacheSeedError(
        `${where}.idToken is longer than ${maxLength} characters`,
      );
    }
    const key = idTokenKey(entry.idToken);
    if (seen.has(key)) {
      throw new InvalidAuthorizationCacheSeedError(
        `${where}.idToken ${entry.idToken} appears twice`,
      );
    }
    seen.add(key);
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
    if (entry.parentId !== undefined && entry.parentId.length > maxLength) {
      throw new InvalidAuthorizationCacheSeedError(
        `${where}.parentId is longer than ${maxLength} characters`,
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
