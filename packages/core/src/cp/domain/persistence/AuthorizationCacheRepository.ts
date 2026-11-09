import type { AuthorizationCacheEntry } from "../auth/AuthorizationCache";

/**
 * Where one charge point's {@link AuthorizationCache} entries are kept
 * (#452, #878): "Cache values SHOULD be persisted across reboots, resets and
 * power outages" (1.6 §3.5.1 with errata 3.4, C10.FR.02).
 *
 * A row per identifier as spelt; case folding, the dedupe of rows spelt
 * differently and eviction stay in the cache. A failure throws: the cache
 * logs it and carries on in memory.
 *
 * `SqliteAuthorizationCacheRepository` uses the `authorization_cache` table;
 * {@link NoopAuthorizationCacheRepository} backs a charge point without a
 * database, whose cache lives in memory only.
 */
export interface AuthorizationCacheRepository {
  /** Every stored entry, in no particular order. */
  loadAll(): AuthorizationCacheEntry[];
  /** Store an entry; an existing row keeps its insertion time. */
  upsert(entry: AuthorizationCacheEntry): void;
  delete(idToken: string): void;
  clear(): void;
}

/** A charge point without a database: nothing is stored. */
export class NoopAuthorizationCacheRepository implements AuthorizationCacheRepository {
  loadAll(): AuthorizationCacheEntry[] {
    return [];
  }

  upsert(_entry: AuthorizationCacheEntry): void {}

  delete(_idToken: string): void {}

  clear(): void {}
}
