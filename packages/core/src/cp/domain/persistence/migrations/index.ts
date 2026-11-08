import type { Database } from "../Database";
import { migration0026BehaviorParams } from "./0026-behavior-params";

/**
 * Forward migrations 26 and later, one file per version.
 *
 * Versions 3..25 are the legacy `if (stored < N)` branches in `runMigrations`
 * (schema.ts); they stay where they are. To add migration N+1:
 *
 *   1. Create `migrations/NNNN-<slug>.ts` exporting a {@link Migration}
 *      whose `version` is N+1 (N = the current `SCHEMA_VERSION`).
 *   2. Append it to {@link MIGRATIONS} below (one import line, one list line).
 *
 * `SCHEMA_VERSION` is derived from the last entry, so nothing else changes.
 * Two PRs that both take N+1 collide on the list line, and the guard test in
 * `__tests__/migrations.bun.test.ts` fails if the versions are not unique,
 * contiguous and ascending.
 */
export interface Migration {
  /** The schema version this migration produces. */
  readonly version: number;
  /** Short slug, matching the file name. */
  readonly name: string;
  /** Idempotent: guard `ALTER TABLE` with a `PRAGMA table_info` probe. */
  up(db: Database): void;
}

/** The highest version handled by the legacy branches in `runMigrations`. */
export const LEGACY_SCHEMA_VERSION = 25;

export const MIGRATIONS: readonly Migration[] = [migration0026BehaviorParams];

/** Problems with a migration list; empty when it is well formed. */
export function validateMigrations(
  migrations: readonly Migration[],
  legacyVersion: number = LEGACY_SCHEMA_VERSION,
): string[] {
  const problems: string[] = [];
  let expected = legacyVersion + 1;
  for (const m of migrations) {
    if (m.version !== expected) {
      problems.push(
        `migration "${m.name}" has version ${m.version}, expected ${expected}`,
      );
    }
    expected = m.version + 1;
  }
  return problems;
}

/** The schema version a migration list ends at. */
export function latestVersion(
  migrations: readonly Migration[],
  legacyVersion: number = LEGACY_SCHEMA_VERSION,
): number {
  return migrations.length > 0
    ? migrations[migrations.length - 1].version
    : legacyVersion;
}
