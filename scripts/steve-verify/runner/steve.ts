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
 */

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

/** CSMS manager UI client: login + operation POST, one cookie jar per instance. */
export class SteveClient {
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

/** db()/db_scalar() equivalent: SQL against SteVe's MariaDB via docker exec. */
export class SteveDb {
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
}
