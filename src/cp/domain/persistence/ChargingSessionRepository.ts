import type {
  ChargingSession,
  ChargingSessionOutcome,
} from "../session/ChargingSession";

/**
 * Charging-session history (#447): the sessions `sessions.list` pages
 * through.
 *
 * One store per daemon, shared by every charge point.
 * {@link InMemoryChargingSessionRepository} backs a daemon without
 * `--state-db` and the browser's Local mode;
 * `SqliteChargingSessionRepository` keeps the history across restarts.
 *
 * Retention is per charge point: past {@link MAX_SESSIONS_PER_CP} sessions
 * that have ended, storing one evicts that charge point's oldest ended
 * session (by record order). A session that is still active is never
 * evicted. Deleting a charge point, or `state.reset`, drops its sessions.
 */
export const MAX_SESSIONS_PER_CP = 500;

export interface ChargingSessionQuery {
  cpId: string;
  connectorId?: number;
  outcomes?: readonly ChargingSessionOutcome[];
  limit?: number;
  offset?: number;
  /** By start time; `desc` (newest first) by default. */
  order?: "asc" | "desc";
}

export interface ChargingSessionPage {
  sessions: ChargingSession[];
  /** Sessions matching the query before `limit` / `offset`. */
  total: number;
}

export interface ChargingSessionRepository {
  /** Store a session; storing the same `sessionId` again replaces it. */
  upsert(session: ChargingSession): void;
  list(query: ChargingSessionQuery): ChargingSessionPage;
  /** `cpId`'s sessions with no observed end (`endedAt === null`), in record
   *  order: the ones a restart has to reconcile. */
  unended(cpId: string): ChargingSession[];
  deleteForChargePoint(cpId: string): void;
  clear(): void;
}

/** True when `session` passes the query's filters (not its paging). */
export function matchesSessionQuery(
  session: ChargingSession,
  query: ChargingSessionQuery,
): boolean {
  return (
    session.cpId === query.cpId &&
    (query.connectorId === undefined ||
      session.connectorId === query.connectorId) &&
    (query.outcomes === undefined || query.outcomes.includes(session.outcome))
  );
}

interface StoredSession {
  /** Record order: the tie-break for equal start times, and eviction order. */
  seq: number;
  session: ChargingSession;
}

/** Bounded session history for a daemon without `--state-db`. */
export class InMemoryChargingSessionRepository implements ChargingSessionRepository {
  /** Per charge point, by sessionId, in record order (re-setting a key keeps
   *  its place). */
  private readonly byCp = new Map<string, Map<string, StoredSession>>();
  private nextSeq = 1;

  upsert(session: ChargingSession): void {
    let sessions = this.byCp.get(session.cpId);
    if (!sessions) {
      sessions = new Map();
      this.byCp.set(session.cpId, sessions);
    }
    const seq = sessions.get(session.sessionId)?.seq ?? this.nextSeq++;
    sessions.set(session.sessionId, { seq, session });
    let ended = 0;
    for (const stored of sessions.values()) {
      if (stored.session.outcome !== "active") ended++;
    }
    for (const [sessionId, stored] of sessions) {
      if (ended <= MAX_SESSIONS_PER_CP) break;
      if (stored.session.outcome === "active") continue;
      sessions.delete(sessionId);
      ended--;
    }
  }

  list(query: ChargingSessionQuery): ChargingSessionPage {
    const direction = query.order === "asc" ? 1 : -1;
    const matching = [...(this.byCp.get(query.cpId)?.values() ?? [])]
      .filter(({ session }) => matchesSessionQuery(session, query))
      .sort(
        (a, b) =>
          direction *
          (a.session.startedAt.localeCompare(b.session.startedAt) ||
            a.seq - b.seq),
      );
    const offset = query.offset ?? 0;
    const end = query.limit === undefined ? undefined : offset + query.limit;
    return {
      sessions: matching.slice(offset, end).map(({ session }) => session),
      total: matching.length,
    };
  }

  unended(cpId: string): ChargingSession[] {
    return [...(this.byCp.get(cpId)?.values() ?? [])]
      .map(({ session }) => session)
      .filter((session) => session.endedAt === null);
  }

  deleteForChargePoint(cpId: string): void {
    this.byCp.delete(cpId);
  }

  clear(): void {
    this.byCp.clear();
  }
}
