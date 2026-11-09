import type { AuthorizationCacheEntry } from "../../domain/auth/AuthorizationCache";
import type { AuthorizationCacheRepository } from "../../domain/persistence/AuthorizationCacheRepository";
import type { Database } from "../../domain/persistence/Database";

interface CacheRow {
  id_token: string;
  status: string;
  expires_at: string | null;
  parent_id: string | null;
  inserted_at: string;
  updated_at: string;
}

/** One charge point's rows of the `authorization_cache` table (#452, #878). */
export class SqliteAuthorizationCacheRepository implements AuthorizationCacheRepository {
  constructor(
    private readonly chargePointId: string,
    private readonly database: Database,
  ) {}

  loadAll(): AuthorizationCacheEntry[] {
    const rows = this.database.all<CacheRow>(
      "SELECT id_token, status, expires_at, parent_id, inserted_at, updated_at " +
        "FROM authorization_cache WHERE cp_id = ?",
      [this.chargePointId],
    );
    return rows.map((row) => {
      const expiresAt =
        row.expires_at !== null ? Date.parse(row.expires_at) : NaN;
      return {
        idToken: row.id_token,
        status: row.status,
        ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
        ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
        insertedAt: Date.parse(row.inserted_at) || 0,
        updatedAt: Date.parse(row.updated_at) || 0,
      };
    });
  }

  upsert(entry: AuthorizationCacheEntry): void {
    this.database.run(
      "INSERT INTO authorization_cache " +
        "(cp_id, id_token, status, expires_at, parent_id, inserted_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (cp_id, id_token) DO UPDATE SET " +
        "status = excluded.status, expires_at = excluded.expires_at, " +
        "parent_id = excluded.parent_id, updated_at = excluded.updated_at",
      [
        this.chargePointId,
        entry.idToken,
        entry.status,
        entry.expiresAt !== undefined
          ? new Date(entry.expiresAt).toISOString()
          : null,
        entry.parentId ?? null,
        new Date(entry.insertedAt).toISOString(),
        new Date(entry.updatedAt).toISOString(),
      ],
    );
  }

  delete(idToken: string): void {
    this.database.run(
      "DELETE FROM authorization_cache WHERE cp_id = ? AND id_token = ?",
      [this.chargePointId, idToken],
    );
  }

  clear(): void {
    this.database.run("DELETE FROM authorization_cache WHERE cp_id = ?", [
      this.chargePointId,
    ]);
  }
}
