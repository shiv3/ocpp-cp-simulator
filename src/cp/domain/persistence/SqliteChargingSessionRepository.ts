import type { Database, SqlParam } from "./Database";
import type { ChargingSession } from "../session/ChargingSession";
import {
  MAX_SESSIONS_PER_CP,
  type ChargingSessionPage,
  type ChargingSessionQuery,
  type ChargingSessionRepository,
} from "./ChargingSessionRepository";

/**
 * `charging_sessions`-backed session history (#447), for a daemon started
 * with `--state-db`: the history survives a restart.
 *
 * A row whose JSON no longer parses is skipped rather than thrown, so one bad
 * row cannot make the whole listing fail (the `BlueprintRepository` rule).
 * The listing's `total` still counts it.
 */
export class SqliteChargingSessionRepository implements ChargingSessionRepository {
  constructor(private readonly db: Database) {}

  upsert(session: ChargingSession): void {
    // One transaction for the write and its retention sweep.
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      // Upsert rather than INSERT OR REPLACE: a replace deletes the row and
      // hands it a new `seq`, which would move it to the back of the
      // eviction queue.
      this.db.run(
        "INSERT INTO charging_sessions (cp_id, session_id, connector_id, " +
          "started_at, ended_at, outcome, session_json) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (cp_id, session_id) DO UPDATE SET " +
          "connector_id = excluded.connector_id, started_at = excluded.started_at, " +
          "ended_at = excluded.ended_at, outcome = excluded.outcome, " +
          "session_json = excluded.session_json",
        [
          session.cpId,
          session.sessionId,
          session.connectorId,
          session.startedAt,
          session.endedAt,
          session.outcome,
          JSON.stringify(session),
        ],
      );
      // Every ended session at or below the charge point's (cap+1)-th newest
      // ended `seq`. Active ones are not counted and never deleted.
      this.db.run(
        "DELETE FROM charging_sessions WHERE cp_id = ? AND outcome != 'active' " +
          "AND seq <= (SELECT seq FROM charging_sessions " +
          "WHERE cp_id = ? AND outcome != 'active' " +
          "ORDER BY seq DESC LIMIT 1 OFFSET ?)",
        [session.cpId, session.cpId, MAX_SESSIONS_PER_CP],
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(query: ChargingSessionQuery): ChargingSessionPage {
    const clauses = ["cp_id = ?"];
    const params: SqlParam[] = [query.cpId];
    if (query.connectorId !== undefined) {
      clauses.push("connector_id = ?");
      params.push(query.connectorId);
    }
    if (query.outcomes !== undefined) {
      clauses.push(
        `outcome IN (${query.outcomes.map(() => "?").join(", ") || "NULL"})`,
      );
      params.push(...query.outcomes);
    }
    const where = ` WHERE ${clauses.join(" AND ")}`;
    const direction = query.order === "asc" ? "ASC" : "DESC";

    const total =
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM charging_sessions${where}`,
        params,
      )?.n ?? 0;
    // SQLite needs a LIMIT to take an OFFSET; -1 means "no limit".
    const rows = this.db.all<{ session_json: string }>(
      `SELECT session_json FROM charging_sessions${where} ` +
        `ORDER BY started_at ${direction}, seq ${direction} LIMIT ? OFFSET ?`,
      [...params, query.limit ?? -1, query.offset ?? 0],
    );
    return { sessions: parseRows(rows), total };
  }

  unended(cpId: string): ChargingSession[] {
    return parseRows(
      this.db.all<{ session_json: string }>(
        "SELECT session_json FROM charging_sessions " +
          "WHERE cp_id = ? AND ended_at IS NULL ORDER BY seq",
        [cpId],
      ),
    );
  }

  deleteForChargePoint(cpId: string): void {
    this.db.run("DELETE FROM charging_sessions WHERE cp_id = ?", [cpId]);
  }

  clear(): void {
    this.db.run("DELETE FROM charging_sessions");
  }
}

function parseRows(rows: Array<{ session_json: string }>): ChargingSession[] {
  const sessions: ChargingSession[] = [];
  for (const row of rows) {
    const session = parseSession(row.session_json);
    if (session) sessions.push(session);
  }
  return sessions;
}

/** The stored JSON, or null when it no longer parses to a session object. */
function parseSession(json: string): ChargingSession | null {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" &&
      value !== null &&
      typeof (value as { sessionId?: unknown }).sessionId === "string"
      ? (value as ChargingSession)
      : null;
  } catch {
    return null;
  }
}
