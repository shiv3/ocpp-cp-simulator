/**
 * Current schema for the simulator state DB.
 *
 * The same SQL runs against `bun:sqlite` (daemon) and sql.js (browser).
 * Tables are entity-shaped rather than KV so a human can `sqlite3 .schema`
 * the daemon DB and read it. JSON columns hold domain DTOs verbatim —
 * those shapes already evolve with OCPP changes, so packing them as JSON
 * keeps the schema stable while the data inside drifts.
 *
 * Migration policy: bump SCHEMA_VERSION and add a branch in `runMigrations`
 * when the columns must change. There are no migrations to write today
 * because the simulator has no prior SQLite users — the previous
 * persistence layer was localStorage and we explicitly do NOT carry it
 * forward (see plan).
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenarios (
  cp_id        TEXT NOT NULL,
  connector_id INTEGER NOT NULL,
  scenario_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  enabled      INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  definition   TEXT NOT NULL,
  PRIMARY KEY (cp_id, connector_id, scenario_id)
);
CREATE INDEX IF NOT EXISTS scenarios_by_cp_conn
  ON scenarios (cp_id, connector_id);

CREATE TABLE IF NOT EXISTS connector_settings (
  cp_id          TEXT NOT NULL,
  connector_id   INTEGER NOT NULL,
  auto_meter     TEXT,
  availability   TEXT,
  soc_meter_sync INTEGER,
  PRIMARY KEY (cp_id, connector_id)
);

CREATE TABLE IF NOT EXISTS charging_profiles (
  cp_id               TEXT NOT NULL,
  connector_id        INTEGER NOT NULL,
  charging_profile_id INTEGER NOT NULL,
  stack_level         INTEGER NOT NULL,
  purpose             TEXT NOT NULL,
  profile             TEXT NOT NULL,
  PRIMARY KEY (cp_id, connector_id, charging_profile_id)
);

CREATE TABLE IF NOT EXISTS configuration (
  cp_id TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (cp_id, key)
);

CREATE TABLE IF NOT EXISTS pending_messages (
  cp_id        TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  action       TEXT NOT NULL,
  connector_id INTEGER,
  payload      TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (cp_id, message_id)
);
CREATE INDEX IF NOT EXISTS pending_by_cp
  ON pending_messages (cp_id, created_at);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- High-frequency log entries from the CP domain (every OCPP message, every
-- scenario tick, every state transition). Writes are debounced + capped
-- by LogRepository to avoid thrashing the sql.js → IndexedDB flush in
-- the browser. AUTOINCREMENT id gives us a stable ordering and lets the
-- retention sweep prune oldest-first without comparing timestamps.
CREATE TABLE IF NOT EXISTS logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  cp_id     TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  level     TEXT NOT NULL,
  log_type  TEXT NOT NULL,
  message   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_by_cp_ts
  ON logs (cp_id, id);

-- Daemon-mode charge point registry. Persists the CP-creation params so a
-- daemon restart with --state-db restores every CP that was registered
-- (via CLI bootstrap or POST /v1/cp) before the previous shutdown. The
-- browser doesn't write this table — local mode uses the Config row in
-- \`kv\` for the same job (config.Experimental.ChargePointIDs drives
-- useChargePoints.syncLocalChargePoints).
CREATE TABLE IF NOT EXISTS charge_points (
  cp_id          TEXT PRIMARY KEY,
  ws_url         TEXT NOT NULL,
  connectors     INTEGER NOT NULL,
  vendor         TEXT NOT NULL,
  model          TEXT NOT NULL,
  basic_auth     TEXT,
  boot_notif     TEXT,
  created_at     TEXT NOT NULL
);

-- Per-CP UI / operator state. Currently holds the "desired connected"
-- flag: when the operator clicks Connect we set it to 1, so a reload (or
-- daemon restart) brings the CP back up automatically.
--
-- Kept separate from \`charge_points\` because:
--   - Browser local mode doesn't write \`charge_points\` (Config drives
--     that side), but it DOES write this table.
--   - Per-CP state is a UI / runtime concern that drifts independently of
--     the immutable creation params.
CREATE TABLE IF NOT EXISTS charge_point_state (
  cp_id             TEXT PRIMARY KEY,
  desired_connected INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
);
`;

import type { Database } from "./Database";

/**
 * Thrown when the on-disk DB was written by a future / forward-incompatible
 * build of the simulator. We refuse to open it rather than silently
 * dropping or rewriting data the older code doesn't understand.
 */
export class SchemaVersionMismatchError extends Error {
  constructor(
    public readonly stored: number,
    public readonly supported: number,
  ) {
    super(
      `Refusing to open state DB: stored schema version ${stored} is newer ` +
        `than the simulator's supported version ${supported}. ` +
        `Upgrade the simulator or point --state-db at a fresh path.`,
    );
    this.name = "SchemaVersionMismatchError";
  }
}

/**
 * Apply pending schema changes. Idempotent — running on an up-to-date DB
 * is a no-op aside from re-stamping schema_meta. Always call once when a
 * `Database` is opened.
 *
 * Version handling:
 *   - DB version  < SCHEMA_VERSION → run all forward migrations (none
 *     defined yet because we're at v1; the CREATE TABLE IF NOT EXISTS
 *     in SCHEMA_SQL handles the "fresh DB" case).
 *   - DB version == SCHEMA_VERSION → no-op aside from re-stamping.
 *   - DB version  > SCHEMA_VERSION → throw {@link SchemaVersionMismatchError}.
 *     Older simulator running against a DB the newer simulator wrote;
 *     bail out instead of corrupting it.
 */
export function runMigrations(db: Database): void {
  // schema_meta itself has to exist before we can read the stored
  // version, so run the table-create pass first. It's a no-op on an
  // already-migrated DB.
  db.exec(SCHEMA_SQL);

  const row = db.get<{ value: string }>(
    "SELECT value FROM schema_meta WHERE key = 'version'",
  );
  const stored = row ? Number(row.value) : 0;
  if (Number.isFinite(stored) && stored > SCHEMA_VERSION) {
    throw new SchemaVersionMismatchError(stored, SCHEMA_VERSION);
  }

  // (Place future forward migrations here, gated on `stored < N`.)

  db.run(
    "INSERT INTO schema_meta (key, value) VALUES ('version', ?) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [String(SCHEMA_VERSION)],
  );
}
