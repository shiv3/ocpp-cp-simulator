/**
 * steve.ts -- TypeScript port of lib.sh's steve_login/steve_op (CSMS
 * operation POSTs against the SteVe manager UI) and db()/db_scalar() (SQL
 * against SteVe's MariaDB container). Faithfully reproduces the CSRF/cookie
 * dance: GET the form page for its `_csrf` token, POST form-urlencoded with
 * that token + the session cookie, read the 302 `Location` redirect SteVe
 * issues on success (never following it -- `redirect: "manual"`, matching
 * curl's default no-follow behavior in the bash version).
 *
 * DB access shells out to `docker exec` against the DB container, mirroring
 * lib.sh's db()/db_scalar() exactly (same SQL, same container).
 *
 * Since issue #184 Task 2, this manager-UI client (`SteveUiOps`) is one of
 * two `SteveOps` implementations -- `steve-api.ts`'s `SteveApiOps` (SteVe
 * 3.13.0's typed REST `/api/v1/operations/*`) is the DEFAULT driver
 * (`STEVE_DRIVER=api` or unset); this UI client is the explicit fallback
 * (`STEVE_DRIVER=ui`), selected in main.ts. Both implement the same
 * `SteveOps` surface below so specs/*.ts (which only ever call
 * `steve.op(opPath, fields)` and `steve.cpSelect(cpId)`) need no changes
 * regardless of which driver is active.
 */

/**
 * The entire method surface specs/*.ts calls on `steve` (grep confirms:
 * every call site is either `steve.op(...)` or `steve.cpSelect(...)`,
 * always feeding cpSelect's return value straight into the following
 * op()'s `chargePointSelectList` field). Deliberately narrow -- each
 * driver is free to encode `cpSelect`'s return value however its own
 * `op()` implementation expects to decode it (SteveUiOps uses SteVe's
 * manager-UI `"V_16_JSON;<cpId>;-"` select-list token; SteveApiOps just
 * uses the bare cpId, since the REST DTOs take `chargeBoxIdList: string[]`
 * directly) -- callers never need to know or care which.
 */
export interface SteveOps {
  /** Builds the token `op()`'s `chargePointSelectList` field expects for
   *  one charge point, in whatever encoding this driver's `op()` decodes. */
  cpSelect(cpId: string): string;
  /** steve_op OP_PATH FIELDS equivalent (see lib.sh). Drives one CSMS
   *  operation (`opPath` e.g. "v1.6/Reset") with UI-form-shaped `fields`
   *  (string-valued, named after the manager UI's <form> inputs -- see
   *  specs/*.ts call sites for the exact per-operation shapes). Resolves
   *  once the CSMS has accepted/dispatched the operation; does NOT imply
   *  the charge point has responded (or ever will) -- every spec's
   *  assert() checks the sim's own captured wire log, not this call's
   *  result, so a driver should throw only on a genuine transport/request
   *  failure (bad auth, malformed request, HTTP error), never on an OCPP
   *  Rejected/CallError/no-response outcome. */
  op(opPath: string, fields: Record<string, string>): Promise<string>;
}

/**
 * SteveTx -- the transaction/reservation-assertion surface every spec's
 * drive()/assert() calls via `db.*` (predates issue #184's REST migration;
 * kept as the field name for spec-source stability). Two implementations:
 * `SteveDb` below (direct MariaDB queries, unchanged since Task 1) and
 * steve-api.ts's `SteveApiDb` (SteVe 3.13.0's `/api/v1/transactions` REST
 * API, issue #184 Task 3) -- selected the same way as `SteveOps`
 * (`STEVE_DRIVER=api|ui`, see main.ts's `createDb()`).
 *
 * `latestReservationPk`/`reservationStatus` have NO REST equivalent: SteVe
 * 3.13.0 ships no `/api/v1/reservations` controller at all (confirmed by
 * listing the running container's compiled `web/api/*RestController`
 * classes -- only Transactions/OcppTags/OcppOperations exist). Both
 * implementations resolve those two methods via direct DB access;
 * `SteveApiDb` documents this as its one fallback (see its header).
 */
export interface SteveTx {
  /** db_latest_tx_pk equivalent: most recent transaction_pk (open or
   *  closed) for a charge box. Empty string if none. */
  latestTxPk(cpId: string): Promise<string>;
  /** db_wait_active_tx_pk equivalent -- see the full open-and-tagged
   *  narrowing rationale on SteveDb's method below. */
  waitActiveTxPk(
    cpId: string,
    idTag: string,
    timeoutSecs?: number,
  ): Promise<string>;
  /** db_close_stale_tx equivalent. Idempotent. */
  closeStaleTx(cpId: string): Promise<void>;
  /** db_latest_reservation_pk equivalent. DB-only surface -- see this
   *  interface's doc comment. */
  latestReservationPk(cpId: string): Promise<string>;
  /** `reservation.status` for a reservation_pk (e.g. "CANCELLED"). DB-only
   *  -- see this interface's doc comment. */
  reservationStatus(reservationPk: string): Promise<string>;
  /** `transaction.id_tag` for a transaction_pk (REST:
   *  `Transaction.ocppIdTag`). Empty string if the transaction doesn't
   *  exist. */
  txIdTag(txPk: string): Promise<string>;
  /** `transaction.stop_timestamp` for a transaction_pk (REST:
   *  `Transaction.stopTimestamp`) -- "" while still open (or nonexistent),
   *  a non-empty timestamp string once closed. Matches assert.ts's
   *  `assertNonEmpty` "" == not-set sentinel. */
  txStopTimestamp(txPk: string): Promise<string>;
  /** `transaction.stop_reason` for a transaction_pk (REST:
   *  `Transaction.stopReason`). "" if unset/nonexistent. */
  txStopReason(txPk: string): Promise<string>;
  /** COUNT(*) of transactions for a charge box + idTag, as a decimal
   *  string (REST: length of the `chargeBoxId`+`ocppIdTag`-filtered
   *  `/transactions` list). */
  txCountForTag(cpId: string, idTag: string): Promise<string>;
  /** `charging_profile.charging_profile_pk` for a Charging Profile entity
   *  identified by its `description` -- the same lookup
   *  `02-provision.sh`'s `ensure_charging_profile()` already runs before
   *  creating one. DB-only surface, like `latestReservationPk`/
   *  `reservationStatus` above: SteVe 3.13.0 has no Charging Profile CRUD
   *  REST endpoint at all (steve-community/steve#2069). "" if no such
   *  profile exists. Issue #184 Task 4: added after the
   *  `remotetrigger-smartcharging` specs' hardcoded pks (`"1"`/`"2"`) were
   *  found to have drifted from the actually-provisioned value on a
   *  long-lived SteVe DB (auto_increment gaps from unrelated provisioning
   *  history) -- looking the pk up by description instead of hardcoding it
   *  makes those specs correct regardless of DB history. */
  chargingProfilePkByDescription(description: string): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export interface SteveConfig {
  /** e.g. http://localhost:18180/steve/manager */
  baseUrl: string;
  username: string;
  password: string;
  /** docker container name running SteVe's MariaDB (e.g. steve-db-1). */
  dbContainer: string;
  dbUser: string;
  dbPass: string;
  dbName: string;
}

export function defaultSteveConfig(
  env: NodeJS.ProcessEnv = process.env,
): SteveConfig {
  const appPort = env.STEVE_APP_HOST_PORT ?? "18180";
  return {
    baseUrl: env.STEVE_URL ?? `http://localhost:${appPort}/steve/manager`,
    username: env.STEVE_USER ?? "admin",
    password: env.STEVE_PASS ?? "1234",
    dbContainer: env.STEVE_DB_CONTAINER ?? "steve-db-1",
    dbUser: env.STEVE_DB_USER ?? "steve",
    dbPass: env.STEVE_DB_PASS ?? "changeme",
    dbName: env.STEVE_DB_NAME ?? "stevedb",
  };
}

/**
 * reservation_expiry_soon equivalent: a ReserveNow "expiry" value `minutes`
 * (default 10) from now, in the "YYYY-MM-DD HH:MM" format SteVe's ReserveNow
 * form expects (no seconds field). Runtime-relative so specs never go stale
 * the way a hardcoded absolute date would -- always UTC (matches the bash
 * version's `date -u`).
 */
export function reservationExpirySoon(minutes = 10): string {
  const d = new Date(Date.now() + minutes * 60_000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * retrieve_datetime_soon equivalent (duplicated identically across the
 * cert16-tc044-* bash specs -- collapsed to one shared helper here): a
 * `UpdateFirmware.retrieveDateTime` value `seconds` (default 90) from now,
 * in the same "YYYY-MM-DD HH:MM" no-seconds-field format as
 * {@link reservationExpirySoon}. Deliberately a longer default offset than a
 * ReserveNow expiry needs (90s, not minutes) -- retrieveDateTime has no
 * seconds field, so a short "+N seconds" offset can round into the current
 * (already-past) minute; +90s guarantees landing in a strictly future
 * minute regardless of where in the current minute the caller runs.
 */
export function retrieveDatetimeSoon(seconds = 90): string {
  const d = new Date(Date.now() + seconds * 1_000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export interface WaitForConditionOptions {
  /** Total time budget, ms (default 15000). */
  timeoutMs?: number;
  /** Delay between polls, ms (default 1000). */
  intervalMs?: number;
  /** Included in the timeout error message. */
  description?: string;
}

/**
 * wait_for_condition equivalent: polls `check()` (any async predicate -- DB
 * polling here, but deliberately generic, not DB-specific) until it
 * resolves to a truthy value, returning that value. Rejects once
 * `timeoutMs` has elapsed without a truthy result -- mirrors lib.sh's
 * wait_for_condition, which `die`s (kills the whole run) on timeout rather
 * than returning an empty/failure value for the caller to handle
 * gracefully; letting this reject and propagate out of a spec's drive()
 * reproduces that same fail-hard behavior here.
 */
export async function waitForCondition<T>(
  check: () => Promise<T | undefined | null | false | "">,
  options: WaitForConditionOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const description = options.description ?? "condition";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for: ${description}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const CSRF_RE = /name="_csrf"\s+value="([^"]*)"/;

function extractCsrf(html: string): string {
  const match = CSRF_RE.exec(html);
  if (!match) {
    throw new Error(
      "steve: could not find _csrf token in response body (login may have failed)",
    );
  }
  return match[1];
}

/** CSMS manager UI client: login + operation POST, one cookie jar per
 *  instance. The `STEVE_DRIVER=ui` fallback SteveOps implementation --
 *  see steve-api.ts's SteveApiOps for the default REST driver. */
export class SteveUiOps implements SteveOps {
  private cookies = new Map<string, string>();

  constructor(private readonly cfg: SteveConfig) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorbSetCookie(res: Response): void {
    const values =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    for (const raw of values) {
      const pair = raw.split(";", 1)[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx > 0) {
        this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    }
  }

  async isLoggedIn(): Promise<boolean> {
    if (this.cookies.size === 0) return false;
    const res = await fetch(`${this.cfg.baseUrl}/home`, {
      redirect: "manual",
      headers: { cookie: this.cookieHeader() },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    return res.status === 200;
  }

  async login(): Promise<void> {
    this.cookies.clear();

    let res = await fetch(`${this.cfg.baseUrl}/signin`, {
      redirect: "manual",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    this.absorbSetCookie(res);
    const csrf = extractCsrf(await res.text());

    const form = new URLSearchParams({
      username: this.cfg.username,
      password: this.cfg.password,
      _csrf: csrf,
    });
    res = await fetch(`${this.cfg.baseUrl}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: this.cookieHeader(),
      },
      body: form.toString(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    this.absorbSetCookie(res);
  }

  async ensureLogin(): Promise<void> {
    if (await this.isLoggedIn()) return;
    await this.login();
  }

  /** steve_cp_select CP_ID equivalent -- the chargePointSelectList form value
   *  SteVe expects for an OCPP 1.6J charge point. */
  cpSelect(cpId: string): string {
    return `V_16_JSON;${cpId};-`;
  }

  /**
   * steve_op OP_PATH FIELDS equivalent. POSTs one CSMS operation,
   * form-encoded, exactly like the manager UI would. Returns the redirect
   * `Location` on success (SteVe 302s to /operations/tasks/<id>); throws on
   * failure (missing CSRF token or no redirect).
   */
  async op(opPath: string, fields: Record<string, string>): Promise<string> {
    await this.ensureLogin();

    let res = await fetch(`${this.cfg.baseUrl}/operations/${opPath}`, {
      redirect: "manual",
      headers: { cookie: this.cookieHeader() },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    this.absorbSetCookie(res);
    const csrf = extractCsrf(await res.text());

    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set("_csrf", csrf);

    res = await fetch(`${this.cfg.baseUrl}/operations/${opPath}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: this.cookieHeader(),
      },
      body: form.toString(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    this.absorbSetCookie(res);

    const location = res.headers.get("location");
    if (!location) {
      const body = await res.text().catch(() => "<unreadable body>");
      throw new Error(
        `steve_op: no redirect Location header for ${opPath} (status ${res.status}): ${body.slice(0, 300)}`,
      );
    }
    return location;
  }
}

/** db()/db_scalar() equivalent: SQL against SteVe's MariaDB via docker exec.
 *  Implements SteveTx -- the `STEVE_DRIVER=ui`/`db` fallback (and, until
 *  issue #184 Task 3, the only implementation); see steve-api.ts's
 *  SteveApiDb for the `STEVE_DRIVER=api` default. */
export class SteveDb implements SteveTx {
  constructor(private readonly cfg: SteveConfig) {}

  /** Runs SQL, returns the first column of the first row (empty string if none). */
  async scalar(sql: string): Promise<string> {
    const proc = Bun.spawn(
      [
        "docker",
        "exec",
        "-i",
        this.cfg.dbContainer,
        "mariadb",
        "-N",
        "-B",
        `-u${this.cfg.dbUser}`,
        `-p${this.cfg.dbPass}`,
        this.cfg.dbName,
        "-e",
        sql,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `steve db query failed (exit ${exitCode}): ${stderr.trim() || "<no stderr>"}`,
      );
    }
    return stdout.split("\n")[0]?.trim() ?? "";
  }

  /** db_latest_tx_pk equivalent: most recent transaction_pk (open or closed). */
  async latestTxPk(cpId: string): Promise<string> {
    return this.scalar(
      `SELECT t.transaction_pk FROM transaction t JOIN evse e ON e.evse_pk = t.evse_pk WHERE e.charge_box_id = '${cpId}' ORDER BY t.transaction_pk DESC LIMIT 1;`,
    );
  }

  /** db_latest_open_tx_pk equivalent: most recent still-open transaction_pk. */
  async latestOpenTxPk(cpId: string): Promise<string> {
    return this.scalar(
      `SELECT t.transaction_pk FROM transaction t JOIN evse e ON e.evse_pk = t.evse_pk WHERE e.charge_box_id = '${cpId}' AND t.stop_timestamp IS NULL ORDER BY t.transaction_pk DESC LIMIT 1;`,
    );
  }

  /** db_latest_reservation_pk equivalent: most recent reservation_pk for a
   *  charge box (any status). */
  async latestReservationPk(cpId: string): Promise<string> {
    return this.scalar(
      `SELECT r.reservation_pk FROM reservation r JOIN evse e ON e.evse_pk = r.evse_pk WHERE e.charge_box_id = '${cpId}' ORDER BY r.reservation_pk DESC LIMIT 1;`,
    );
  }

  /**
   * db_wait_active_tx_pk equivalent: polls (bounded, default 15s) for an
   * OPEN transaction (stop_timestamp IS NULL) on `cpId` started with
   * `idTag`, returning its transaction_pk. Use this instead of
   * {@link latestTxPk} when a spec needs to bind its later assertions to the
   * transaction ITS OWN scenario/drive() created -- latestTxPk just grabs
   * the newest row for the charge box regardless of tag or open/closed
   * state, which on a reused charge point can silently pick up a stale
   * closed transaction from an earlier run instead of the racing
   * in-progress one. Task-3-group-only (tc028, tc057): every Task 1/2 spec
   * either has no concurrent tag collision risk or doesn't need the
   * open-and-tagged narrowing. Rejects (fail-hard, mirrors
   * {@link waitForCondition}/wait_for_condition's `die`) on timeout --
   * unlike the bash version's `log_warn` + `return 1`, which lets its
   * caller's `|| true` swallow the failure and continue with an empty
   * TX_PK. Callers that want that same "continue with nothing" behavior
   * should catch and treat the rejection as an empty result themselves.
   */
  async waitActiveTxPk(
    cpId: string,
    idTag: string,
    timeoutSecs = 15,
  ): Promise<string> {
    return waitForCondition(
      () =>
        this.scalar(
          `SELECT t.transaction_pk FROM transaction t JOIN evse e ON e.evse_pk = t.evse_pk WHERE e.charge_box_id = '${cpId}' AND t.id_tag = '${idTag}' AND t.stop_timestamp IS NULL ORDER BY t.transaction_pk DESC LIMIT 1;`,
        ),
      {
        timeoutMs: timeoutSecs * 1000,
        intervalMs: 1_000,
        description: `active transaction on ${cpId} (id_tag=${idTag})`,
      },
    );
  }

  /** db_close_stale_tx equivalent: closes any transaction left open from a
   *  previous interrupted run, so max_active_transaction_count doesn't block
   *  the next scenario. Idempotent. */
  async closeStaleTx(cpId: string): Promise<void> {
    const pk = await this.latestOpenTxPk(cpId);
    if (!pk) return;
    await this.scalar(
      `INSERT INTO transaction_stop (transaction_pk, event_timestamp, event_actor, stop_timestamp, stop_value, stop_reason) VALUES (${pk}, NOW(), 'manual', NOW(), '0', 'Local');`,
    );
  }

  /** `reservation.status` for a reservation_pk (e.g. "CANCELLED").
   *  DB-only -- see {@link latestReservationPk}. */
  async reservationStatus(reservationPk: string): Promise<string> {
    return this.nullSafeScalar(
      `SELECT status FROM reservation WHERE reservation_pk=${reservationPk};`,
    );
  }

  /** charging_profile_pk for a Charging Profile entity by its
   *  `description` -- see the `SteveTx` interface's doc comment. */
  async chargingProfilePkByDescription(description: string): Promise<string> {
    return this.scalar(
      `SELECT charging_profile_pk FROM charging_profile WHERE description = '${description}' LIMIT 1;`,
    );
  }

  /** `transaction.id_tag` for a transaction_pk. Empty string if the
   *  transaction doesn't exist. */
  async txIdTag(txPk: string): Promise<string> {
    return this.nullSafeScalar(
      `SELECT id_tag FROM transaction WHERE transaction_pk=${txPk};`,
    );
  }

  /** `transaction.stop_timestamp` for a transaction_pk -- "" while still
   *  open (or nonexistent), a non-empty timestamp string once closed. */
  async txStopTimestamp(txPk: string): Promise<string> {
    return this.nullSafeScalar(
      `SELECT stop_timestamp FROM transaction WHERE transaction_pk=${txPk};`,
    );
  }

  /** `transaction.stop_reason` for a transaction_pk. "" if unset. */
  async txStopReason(txPk: string): Promise<string> {
    return this.nullSafeScalar(
      `SELECT stop_reason FROM transaction WHERE transaction_pk=${txPk};`,
    );
  }

  /** COUNT(*) of transactions for a charge box + idTag, as a decimal
   *  string. */
  async txCountForTag(cpId: string, idTag: string): Promise<string> {
    return this.scalar(
      `SELECT COUNT(*) FROM transaction t JOIN evse e ON e.evse_pk = t.evse_pk WHERE e.charge_box_id = '${cpId}' AND t.id_tag = '${idTag}';`,
    );
  }

  /**
   * scalar(), normalizing a genuine SQL NULL to "" -- issue #184 Task 3
   * finding: the MariaDB CLI (`mariadb -N -B`, what scalar() shells out
   * to) renders a SQL NULL as the literal 4-character string "NULL", not
   * an empty string (live-verified: `SELECT NULL;` -> the bytes `NULL\n`).
   * scalar() passes that through verbatim (a faithful raw-SQL
   * passthrough, kept as-is for any future direct caller), but every
   * typed getter above wants "" as its is-this-set sentinel
   * (assert.ts's assertNonEmpty checks `value !== ""` -- see
   * txStopTimestamp's doc comment) -- without this normalization,
   * `assertNonEmpty(await db.txStopTimestamp(openTxPk), ...)` would
   * wrongly PASS on a still-open transaction, since the string "NULL" is
   * non-empty. (A zero-row result, e.g. a nonexistent transaction_pk,
   * already comes back as "" from scalar() itself -- MariaDB prints
   * nothing at all for zero rows, only "NULL" for an existing row's NULL
   * column -- so this only needs to handle the one literal.)
   */
  private async nullSafeScalar(sql: string): Promise<string> {
    const raw = await this.scalar(sql);
    return raw === "NULL" ? "" : raw;
  }
}
