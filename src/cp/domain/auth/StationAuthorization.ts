import type {
  AuthorizationCache,
  AuthorizationCacheRecord,
} from "./AuthorizationCache";
import type { LocalAuthListManager } from "./LocalAuthList";
import {
  resolveLocalAuthorization,
  resolveOfflineAuthorization,
  type KnownAuthorization,
  type LocalAuthorizationDecision,
  type LocalAuthorizationInput,
  type LocalAuthorizationPolicy,
  type LocalOnlyDecision,
} from "./LocalAuthorizationResolver";

/** A CSMS verdict on an identifier, without the identifier itself. */
export type CsmsAuthorizationResult = Omit<AuthorizationCacheRecord, "idToken">;

export interface StationAuthorizationDeps {
  cache: AuthorizationCache;
  localList: LocalAuthListManager;
  /** Read on every call, so configuration changes apply at once. */
  policy: () => LocalAuthorizationPolicy;
  now?: () => number;
}

/**
 * The charge point's local authorization (issue #452): the Authorization
 * Cache and the Local Authorization List, read through
 * {@link resolveLocalAuthorization} and written from CSMS answers only.
 */
export class StationAuthorization {
  private readonly now: () => number;

  constructor(private readonly deps: StationAuthorizationDeps) {
    this.now = deps.now ?? Date.now;
  }

  get cache(): AuthorizationCache {
    return this.deps.cache;
  }

  policy(): LocalAuthorizationPolicy {
    return this.deps.policy();
  }

  decide(idToken: string, online: boolean): LocalAuthorizationDecision {
    return resolveLocalAuthorization({ online, ...this.inputFor(idToken) });
  }

  /** The offline rules alone, e.g. when the connection drops mid-wait. */
  decideOffline(idToken: string): LocalOnlyDecision {
    return resolveOfflineAuthorization(this.inputFor(idToken));
  }

  private inputFor(idToken: string): Omit<LocalAuthorizationInput, "online"> {
    const listed = this.deps.localList.getEntry(idToken);
    const cached = this.deps.cache.get(idToken);
    return {
      policy: this.deps.policy(),
      now: this.now(),
      ...(listed ? { localListEntry: toKnown(listed) } : {}),
      ...(cached ? { cacheEntry: cached } : {}),
    };
  }

  /**
   * Record what the CSMS answered for `idToken` (1.6 Authorize.conf,
   * StartTransaction.conf, StopTransaction.conf: §3.5.1, §4.1; 2.x
   * AuthorizeResponse / TransactionEventResponse: C10.FR.04/.05). Returns
   * whether the cache was written.
   *
   * Nothing is written while the cache is disabled, nor for an identifier
   * of the Local Authorization List ("SHALL NOT be added to the
   * Authorization Cache", 1.6 §3.5.3). Only CSMS answers come here, never a
   * local decision, so an identifier accepted offline as unknown is not
   * cached (C15.FR.01).
   */
  recordCsmsResult(idToken: string, result: CsmsAuthorizationResult): boolean {
    if (!this.deps.policy().cacheEnabled) return false;
    if (this.deps.localList.getEntry(idToken)) return false;
    this.deps.cache.upsert({ idToken, ...result });
    return true;
  }

  /** Empty the cache (1.6 §5.4, C11.FR.01). False when it could not be. */
  clearCache(): boolean {
    return this.deps.cache.clear();
  }
}

function toKnown(entry: {
  status: string;
  expiryDate?: string;
}): KnownAuthorization {
  const expiresAt =
    entry.expiryDate !== undefined ? Date.parse(entry.expiryDate) : NaN;
  return Number.isFinite(expiresAt)
    ? { status: entry.status, expiresAt }
    : { status: entry.status };
}
