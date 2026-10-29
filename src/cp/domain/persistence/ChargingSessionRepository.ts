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
 * session (by end time, or start time when the end is unknown). A session
 * that is still active is never evicted. Deleting a charge point, or
 * `state.reset`, drops its sessions.
 */
export const MAX_SESSIONS_PER_CP = 500;

export interface ChargingSessionQuery {
  cpId: string;
  connectorId?: number;
  outcomes?: ChargingSessionOutcome[];
  /** How many sessions to return: the newest N, like `logs.get`. */
  limit?: number;
  /** How many of the newest sessions to skip before taking `limit`. */
  offset?: number;
  /** Order of the returned window, by start time; `desc` (newest first) by
   *  default. It never changes which sessions `limit` / `offset` select. */
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
    // Only an ended session can take the charge point past the cap.
    if (session.outcome === "active") return;
    const ended = [...sessions.values()].filter(
      (stored) => stored.session.outcome !== "active",
    );
    if (ended.length <= MAX_SESSIONS_PER_CP) return;
    // Oldest end first (a session whose end is unknown by its start), so a
    // long session that just ended is not the one evicted.
    const endOf = ({ session: s }: StoredSession) => s.endedAt ?? s.startedAt;
    ended
      .sort((a, b) => endOf(b).localeCompare(endOf(a)) || b.seq - a.seq)
      .slice(MAX_SESSIONS_PER_CP)
      .forEach((stored) => sessions.delete(stored.session.sessionId));
  }

  list(query: ChargingSessionQuery): ChargingSessionPage {
    const { connectorId, outcomes } = query;
    const matching = [...(this.byCp.get(query.cpId)?.values() ?? [])]
      .filter(
        ({ session }) =>
          (connectorId === undefined || session.connectorId === connectorId) &&
          (outcomes === undefined || outcomes.includes(session.outcome)),
      )
      .sort(
        (a, b) =>
          b.session.startedAt.localeCompare(a.session.startedAt) ||
          b.seq - a.seq,
      );
    const offset = query.offset ?? 0;
    const end = query.limit === undefined ? undefined : offset + query.limit;
    const window = matching.slice(offset, end).map(({ session }) => session);
    if (query.order === "asc") window.reverse();
    return { sessions: window, total: matching.length };
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
