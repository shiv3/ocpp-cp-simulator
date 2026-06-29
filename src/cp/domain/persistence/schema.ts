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
export const SCHEMA_VERSION = 5;

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
  ocpp_version   TEXT,
  security_profile INTEGER,
  authorization_key TEXT,
  cpo_name       TEXT,
  tls_ca_path    TEXT,
  tls_cert_path  TEXT,
  tls_key_path   TEXT,
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

-- Per-connector runtime state needed to survive a daemon restart in the
-- middle of an OCPP transaction. Without this, a pod restart on
-- Kubernetes (or any --state-db host where the process can die
-- mid-charge) leaves the CSMS holding a Charging transaction while the
-- simulator comes back up with every connector pinned to Available, and
-- StatusNotification / MeterValues stop arriving until an operator
-- manually intervenes.
--
-- Scope is the OCPP-visible state plus the in-flight transaction JSON
-- and the meter accumulator. Since v3 we also persist scenario execution
-- position so that a daemon restart mid-transaction resumes the same
-- scenario node instead of replaying from the top (which previously left
-- the Charging connector parked at "Wait for RemoteStartTransaction"
-- forever, since the scenario never reaches its meterValue node again).
CREATE TABLE IF NOT EXISTS connector_runtime (
  cp_id                            TEXT NOT NULL,
  connector_id                     INTEGER NOT NULL,
  status                           TEXT NOT NULL,
  availability                     TEXT NOT NULL,
  scheduled_availability           TEXT,
  transaction_json                 TEXT,
  meter_value_wh                   INTEGER NOT NULL DEFAULT 0,
  soc_percent                      REAL,
  last_auto_started_scenario_key   TEXT,
  scenario_position_json           TEXT,
  updated_at                       TEXT NOT NULL,
  PRIMARY KEY (cp_id, connector_id)
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
 *   - DB version  < SCHEMA_VERSION → run all forward migrations. The
 *     v1 → v2 case (adding `connector_runtime`) needs no dedicated
 *     branch because SCHEMA_SQL re-runs every call and uses
 *     `CREATE TABLE IF NOT EXISTS`.
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

  // v2 → v3: add `scenario_position_json` column to `connector_runtime`
  // so a daemon restart can resume the scenario at the saved node instead
  // of replaying from the START node. SQLite has no `ADD COLUMN IF NOT
  // EXISTS`, so we probe pragma table_info first.
  if (stored < 3) {
    const cols = db.all<{ name: string }>(
      "PRAGMA table_info(connector_runtime)",
    );
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("scenario_position_json")) {
      db.exec(
        "ALTER TABLE connector_runtime ADD COLUMN scenario_position_json TEXT",
      );
    }
  }

  // v3 → v4: persist the daemon CP's OCPP version so restored charge
  // points keep the same protocol instead of falling back to OCPP 1.6.
  // SQLite has no `ADD COLUMN IF NOT EXISTS`, so we probe pragma
  // table_info first.
  if (stored < 4) {
    const cols = db.all<{ name: string }>("PRAGMA table_info(charge_points)");
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("ocpp_version")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN ocpp_version TEXT");
    }
  }

  // v4 → v5: persist OCPP 1.6 security-profile metadata and TLS file
  // paths for daemon restore. Private key material stays out of SQLite;
  // restore re-reads tls_key_path and fails closed if it cannot.
  if (stored < 5) {
    const cols = db.all<{ name: string }>("PRAGMA table_info(charge_points)");
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("security_profile")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN security_profile INTEGER");
    }
    if (!have.has("authorization_key")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN authorization_key TEXT");
    }
    if (!have.has("cpo_name")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN cpo_name TEXT");
    }
    if (!have.has("tls_ca_path")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN tls_ca_path TEXT");
    }
    if (!have.has("tls_cert_path")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN tls_cert_path TEXT");
    }
    if (!have.has("tls_key_path")) {
      db.exec("ALTER TABLE charge_points ADD COLUMN tls_key_path TEXT");
    }
  }

  // (Place future forward migrations here, gated on `stored < N`.)

  db.run(
    "INSERT INTO schema_meta (key, value) VALUES ('version', ?) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [String(SCHEMA_VERSION)],
  );
}
