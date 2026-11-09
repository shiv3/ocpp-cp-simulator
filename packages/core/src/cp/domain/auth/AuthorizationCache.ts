import {
  NoopAuthorizationCacheRepository,
  type AuthorizationCacheRepository,
} from "../persistence/AuthorizationCacheRepository";
import { AUTHORIZATION_CACHE_SEED_MAX } from "@ocpp-cp-simulator/contracts/authorization";
import { idTokenKey } from "./idTokenKey";
import { effectiveStatus } from "./LocalAuthorizationResolver";
import { realClock } from "../../shared/clock";
import type { SimClock } from "../../shared/clock";

/**
 * What the CSMS said about an identifier, normalized across versions:
 * 1.6 `idTagInfo` (`expiryDate`, `parentIdTag`) and 2.x `idTokenInfo`
 * (`cacheExpiryDateTime`, `groupIdToken.idToken`).
 */
export interface AuthorizationCacheRecord {
  idToken: string;
  /** Authorization status as received ("Accepted", "Blocked", …). */
  status: string;
  /** Epoch ms after which the entry counts as Expired. */
  expiresAt?: number;
  /** 1.6 parentIdTag / 2.x groupIdToken. */
  parentId?: string;
}

export interface AuthorizationCacheEntry extends AuthorizationCacheRecord {
  /** Epoch ms of the first insertion. */
  insertedAt: number;
  /** Epoch ms of the last update. */
  updatedAt: number;
}

export interface AuthorizationCacheOptions {
  /** Capacity; reaching it evicts per {@link AuthorizationCache.upsert}. */
  maxEntries?: number;
  now?: () => number;
  /** Where `now` comes from when it is not given; the platform clock. */
  clock?: SimClock;
}

/** Neither 1.6 nor 2.x has a key for the cache capacity in entries. */
export const DEFAULT_AUTHORIZATION_CACHE_MAX_ENTRIES =
  AUTHORIZATION_CACHE_SEED_MAX;

/**
 * The charge point's Authorization Cache (issue #452; OCPP 1.6 Part 2
 * §3.5.1, 2.0.1 Part 2 C10): the latest identifier information received
 * from the CSMS, valid and NOT-valid alike.
 *
 * It only stores. Whether an entry is consulted or written (the
 * `AuthorizationCacheEnabled` switch, the local-list exclusion of §3.5.3)
 * is decided by {@link StationAuthorization}.
 *
 * Persisted through an {@link AuthorizationCacheRepository} when one is
 * given — "Cache values SHOULD be persisted across reboots, resets and
 * power outages" (1.6 §3.5.1 with errata 3.4, C10.FR.02) — and in memory
 * otherwise, like {@link PendingMessageQueue}: loaded in the constructor,
 * written through on every change.
 *
 * Identifiers are case insensitive ({@link idTokenKey}): one entry, and
 * one row, per folded identifier, under the spelling last received.
 */
export class AuthorizationCache {
  /** Keyed by {@link idTokenKey}. */
  private readonly entries = new Map<string, AuthorizationCacheEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly repository: AuthorizationCacheRepository;

  /**
   * `repository` is bound to the charge point (#878); `null` keeps the
   * cache in memory only.
   */
  constructor(
    repository: AuthorizationCacheRepository | null = null,
    options: AuthorizationCacheOptions = {},
  ) {
    this.repository = repository ?? new NoopAuthorizationCacheRepository();
    this.maxEntries = Math.max(
      1,
      options.maxEntries ?? DEFAULT_AUTHORIZATION_CACHE_MAX_ENTRIES,
    );
    const clock = options.clock ?? realClock;
    this.now = options.now ?? (() => clock.now());
    this.load();
  }

  get(idToken: string): AuthorizationCacheEntry | undefined {
    const entry = this.entries.get(idTokenKey(idToken));
    return entry ? { ...entry } : undefined;
  }

  all(): AuthorizationCacheEntry[] {
    return Array.from(this.entries.values(), (e) => ({ ...e }));
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Insert or update an entry (1.6 §3.5.1 "When an IdTagInfo is received
   * for an identifier in the Cache, it SHALL be updated", C12.FR.06). An
   * update keeps the insertion time. When a new identifier arrives and the
   * cache is full, NOT-valid entries go first, then the oldest valid ones
   * (1.6 §3.5.1 SHALL, C10.FR.07).
   */
  upsert(record: AuthorizationCacheRecord): void {
    const now = this.now();
    const key = idTokenKey(record.idToken);
    const previous = this.entries.get(key);
    if (!previous) this.makeRoom(now);
    // A new spelling of a known identifier replaces its row: the table
    // key compares exactly.
    if (previous && previous.idToken !== record.idToken) {
      this.deleteRow(previous.idToken);
    }
    const entry: AuthorizationCacheEntry = {
      idToken: record.idToken,
      status: record.status,
      ...(record.expiresAt !== undefined
        ? { expiresAt: record.expiresAt }
        : {}),
      ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
      insertedAt: previous?.insertedAt ?? now,
      updatedAt: now,
    };
    this.entries.set(key, entry);
    this.writeRow(entry);
  }

  remove(idToken: string): boolean {
    const key = idTokenKey(idToken);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.deleteRow(entry.idToken);
    return true;
  }

  /** Empty the cache. Returns false when the stored copy could not be
   *  cleared (the in-memory copy is cleared either way). */
  clear(): boolean {
    this.entries.clear();
    try {
      this.repository.clear();
      return true;
    } catch (err) {
      console.error("Failed to clear the authorization cache:", err);
      return false;
    }
  }

  private makeRoom(now: number): void {
    while (this.entries.size >= this.maxEntries) {
      const victim = this.evictionCandidate(now);
      if (!victim) return;
      this.remove(victim);
    }
  }

  /** Oldest NOT-valid entry, else the oldest valid one. */
  private evictionCandidate(now: number): string | undefined {
    let invalid: AuthorizationCacheEntry | undefined;
    let valid: AuthorizationCacheEntry | undefined;
    for (const entry of this.entries.values()) {
      if (effectiveStatus(entry, now) === "Accepted") {
        if (!valid || entry.updatedAt < valid.updatedAt) valid = entry;
      } else if (!invalid || entry.updatedAt < invalid.updatedAt) {
        invalid = entry;
      }
    }
    return (invalid ?? valid)?.idToken;
  }

  // ── persistence helpers ────────────────────────────────────────────────

  private load(): void {
    try {
      const shadowed: string[] = [];
      for (const entry of this.repository.loadAll()) {
        // Rows spelt differently are one identifier: the newest wins and
        // the others are dropped, so the table holds one row per key.
        const key = idTokenKey(entry.idToken);
        const other = this.entries.get(key);
        if (other && other.updatedAt >= entry.updatedAt) {
          shadowed.push(entry.idToken);
          continue;
        }
        if (other) shadowed.push(other.idToken);
        this.entries.set(key, entry);
      }
      for (const idToken of shadowed) this.deleteRow(idToken);
    } catch (err) {
      console.error("Failed to load the authorization cache:", err);
    }
  }

  private writeRow(entry: AuthorizationCacheEntry): void {
    try {
      this.repository.upsert(entry);
    } catch (err) {
      console.error("Failed to persist an authorization cache entry:", err);
    }
  }

  private deleteRow(idToken: string): void {
    try {
      this.repository.delete(idToken);
    } catch (err) {
      console.error("Failed to delete an authorization cache entry:", err);
    }
  }
}
