// Runs under `bun test`: the SQLite implementation uses the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";

import { BunSqliteDatabase } from "../BunSqliteDatabase";
import {
  InMemoryChargingSessionRepository,
  MAX_SESSIONS_PER_CP,
  type ChargingSessionRepository,
} from "../ChargingSessionRepository";
import { SqliteChargingSessionRepository } from "../SqliteChargingSessionRepository";
import type { ChargingSession } from "../../session/ChargingSession";
import {
  chargingSession,
  UNENDED,
} from "../../../../test/chargingSessionFixtures";

/**
 * #447: the session history contract, run against both implementations — the
 * in-memory store a daemon without `--state-db` uses, and the
 * `charging_sessions` table.
 */

let clock = Date.parse("2026-10-28T08:00:00.000Z");

function session(overrides: Partial<ChargingSession> = {}): ChargingSession {
  clock += 60_000;
  return chargingSession({
    sessionId: `s-${clock}`,
    cpId: "CP-A",
    startedAt: new Date(clock).toISOString(),
    endedAt: new Date(clock + 30_000).toISOString(),
    durationMs: 30_000,
    ...overrides,
  });
}

function active(overrides: Partial<ChargingSession> = {}): ChargingSession {
  return session({ ...UNENDED, ...overrides });
}

const opened: BunSqliteDatabase[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

const implementations: Array<[string, () => ChargingSessionRepository]> = [
  ["in-memory", () => new InMemoryChargingSessionRepository()],
  [
    "sqlite",
    () => {
      const db = BunSqliteDatabase.open(":memory:");
      opened.push(db);
      return new SqliteChargingSessionRepository(db);
    },
  ],
];

describe.each(implementations)(
  "ChargingSessionRepository (%s)",
  (_, create) => {
    it("lists a stored session", () => {
      const repo = create();
      const s = session();
      repo.upsert(s);

      expect(repo.list({ cpId: "CP-A" })).toEqual({ sessions: [s], total: 1 });
    });

    it("replaces a session upserted again under the same id", () => {
      const repo = create();
      const started = active();
      repo.upsert(started);
      const ended = {
        ...started,
        endedAt: started.startedAt,
        outcome: "completed" as const,
      };
      repo.upsert(ended);

      expect(repo.list({ cpId: "CP-A" })).toEqual({
        sessions: [ended],
        total: 1,
      });
    });

    it("keeps charge points apart", () => {
      const repo = create();
      const a = session();
      const b = session({ cpId: "CP-B" });
      repo.upsert(a);
      repo.upsert(b);

      expect(repo.list({ cpId: "CP-A" }).sessions).toEqual([a]);
      expect(repo.list({ cpId: "CP-B" }).sessions).toEqual([b]);
      expect(repo.list({ cpId: "CP-C" })).toEqual({ sessions: [], total: 0 });
    });

    it("orders newest first by default and oldest first with order asc", () => {
      const repo = create();
      const first = session();
      const second = session();
      repo.upsert(second);
      repo.upsert(first);

      expect(repo.list({ cpId: "CP-A" }).sessions).toEqual([second, first]);
      expect(repo.list({ cpId: "CP-A", order: "asc" }).sessions).toEqual([
        first,
        second,
      ]);
    });

    it("windows the newest sessions whatever the order, like logs.get", () => {
      const repo = create();
      const [a, b, c] = [session(), session(), session()];
      for (const s of [a, b, c]) repo.upsert(s);

      expect(repo.list({ cpId: "CP-A", limit: 2 }).sessions).toEqual([c, b]);
      expect(
        repo.list({ cpId: "CP-A", limit: 2, order: "asc" }).sessions,
      ).toEqual([b, c]);
      expect(
        repo.list({ cpId: "CP-A", limit: 2, offset: 1, order: "asc" }),
      ).toEqual({ sessions: [a, b], total: 3 });
    });

    it("filters by connector and by outcome, and counts the match before paging", () => {
      const repo = create();
      const c1 = session();
      const c2 = session({ connectorId: 2 });
      const live = active({ connectorId: 2 });
      const failed = session({ outcome: "failed", connectorId: 2 });
      for (const s of [c1, c2, live, failed]) repo.upsert(s);

      expect(repo.list({ cpId: "CP-A", connectorId: 2 }).total).toBe(3);
      expect(
        repo.list({ cpId: "CP-A", outcomes: ["active", "failed"] }).sessions,
      ).toEqual([failed, live]);
      expect(
        repo.list({ cpId: "CP-A", connectorId: 2, limit: 1, offset: 1 }),
      ).toEqual({ sessions: [live], total: 3 });
    });

    it("returns the sessions whose end was never observed", () => {
      const repo = create();
      const live = active();
      const lost = active({ outcome: "interrupted" });
      repo.upsert(session());
      repo.upsert(live);
      repo.upsert(lost);
      repo.upsert(active({ cpId: "CP-B" }));

      expect(repo.unended("CP-A")).toEqual([live, lost]);
    });

    it("evicts the oldest ended sessions past the cap and never an active one", () => {
      const repo = create();
      const live = active();
      repo.upsert(live);
      const ended: ChargingSession[] = [];
      for (let i = 0; i < MAX_SESSIONS_PER_CP + 2; i++) {
        const s = session();
        ended.push(s);
        repo.upsert(s);
      }

      const page = repo.list({ cpId: "CP-A", order: "asc" });
      expect(page.total).toBe(MAX_SESSIONS_PER_CP + 1);
      expect(page.sessions[0]).toEqual(live);
      expect(page.sessions[1]).toEqual(ended[2]);
    });

    it("evicts by end, so a long session that just ended is kept", () => {
      const repo = create();
      const long = active();
      repo.upsert(long);
      for (let i = 0; i < MAX_SESSIONS_PER_CP; i++) repo.upsert(session());
      // Recorded first, ended last.
      const ended = {
        ...long,
        endedAt: new Date(clock + 3_600_000).toISOString(),
        outcome: "completed" as const,
      };
      repo.upsert(ended);

      const { sessions, total } = repo.list({ cpId: "CP-A", order: "asc" });
      expect(total).toBe(MAX_SESSIONS_PER_CP);
      expect(sessions[0]).toEqual(ended);
    });

    it("evicts a session whose end is unknown by its start", () => {
      const repo = create();
      const lost = session({ ...UNENDED, outcome: "interrupted" });
      repo.upsert(lost);
      for (let i = 0; i < MAX_SESSIONS_PER_CP; i++) repo.upsert(session());

      expect(repo.unended("CP-A")).toEqual([]);
      expect(repo.list({ cpId: "CP-A" }).total).toBe(MAX_SESSIONS_PER_CP);
    });

    it("does not let one charge point's history evict another's", () => {
      const repo = create();
      const kept = session({ cpId: "CP-B" });
      repo.upsert(kept);
      for (let i = 0; i < MAX_SESSIONS_PER_CP + 1; i++) repo.upsert(session());

      expect(repo.list({ cpId: "CP-B" }).sessions).toEqual([kept]);
    });

    it("drops a charge point's sessions, and everything on clear", () => {
      const repo = create();
      repo.upsert(session());
      repo.upsert(session({ cpId: "CP-B" }));

      repo.deleteForChargePoint("CP-A");
      expect(repo.list({ cpId: "CP-A" }).total).toBe(0);
      expect(repo.list({ cpId: "CP-B" }).total).toBe(1);

      repo.clear();
      expect(repo.list({ cpId: "CP-B" }).total).toBe(0);
    });
    describe("across charge points (#489)", () => {
      // Same start time on purpose: the order across charge points must not
      // depend on which one the store happens to visit first.
      function fleet() {
        const repo = create();
        const t = "2026-11-08T10:00:00.000Z";
        const a1 = session({ cpId: "CP-A", sessionId: "a1", startedAt: t });
        const b1 = session({ cpId: "CP-B", sessionId: "b1", startedAt: t });
        const a2 = session({
          cpId: "CP-A",
          sessionId: "a2",
          startedAt: "2026-11-08T11:00:00.000Z",
          outcome: "failed",
        });
        const c1 = session({
          cpId: "CP-C",
          sessionId: "c1",
          startedAt: "2026-11-08T09:00:00.000Z",
        });
        [a1, b1, a2, c1].forEach((s) => repo.upsert(s));
        return { repo };
      }
      const ids = (page: { sessions: ChargingSession[] }) =>
        page.sessions.map((s) => s.sessionId);

      it("lists every charge point newest first, ties by record order", () => {
        const { repo } = fleet();
        expect(ids(repo.list({}))).toEqual(["a2", "b1", "a1", "c1"]);
        expect(repo.list({}).total).toBe(4);
        expect(ids(repo.list({ order: "asc" }))).toEqual([
          "c1",
          "a1",
          "b1",
          "a2",
        ]);
      });

      it("pages without skipping or repeating a session", () => {
        const { repo } = fleet();
        const pages = [0, 2].map((offset) =>
          ids(repo.list({ limit: 2, offset })),
        );
        expect(pages.flat()).toEqual(["a2", "b1", "a1", "c1"]);
      });

      it("narrows to cpIds, and an empty list matches nothing", () => {
        const { repo } = fleet();
        expect(ids(repo.list({ cpIds: ["CP-B", "CP-C"] }))).toEqual([
          "b1",
          "c1",
        ]);
        expect(repo.list({ cpIds: [] })).toEqual({ sessions: [], total: 0 });
      });

      it("filters by outcome and a half-open start-time range", () => {
        const { repo } = fleet();
        expect(ids(repo.list({ outcomes: ["failed"] }))).toEqual(["a2"]);
        expect(
          ids(
            repo.list({
              startedFrom: "2026-11-08T10:00:00.000Z",
              startedTo: "2026-11-08T11:00:00.000Z",
            }),
          ),
        ).toEqual(["b1", "a1"]);
        expect(
          repo.list({
            startedFrom: "2026-11-08T10:00:00.000Z",
            startedTo: "2026-11-08T10:00:00.000Z",
          }).total,
        ).toBe(0);
      });

      it("applies the time range to one charge point too", () => {
        const { repo } = fleet();
        expect(
          ids(
            repo.list({
              cpId: "CP-A",
              startedFrom: "2026-11-08T10:30:00.000Z",
            }),
          ),
        ).toEqual(["a2"]);
      });
    });
  },
);

describe("SqliteChargingSessionRepository", () => {
  it("serves what another instance on the same database stored", () => {
    const db = BunSqliteDatabase.open(":memory:");
    opened.push(db);
    const s = session();
    new SqliteChargingSessionRepository(db).upsert(s);

    expect(
      new SqliteChargingSessionRepository(db).list({ cpId: "CP-A" }),
    ).toEqual({ sessions: [s], total: 1 });
  });

  it("skips a row whose JSON no longer parses but still counts it", () => {
    const db = BunSqliteDatabase.open(":memory:");
    opened.push(db);
    const repo = new SqliteChargingSessionRepository(db);
    const s = session();
    repo.upsert(s);
    db.run(
      "INSERT INTO charging_sessions (cp_id, session_id, connector_id, started_at, outcome, session_json) " +
        "VALUES ('CP-A', 'broken', 1, '2026-10-28T00:00:00.000Z', 'completed', '{')",
    );

    expect(repo.list({ cpId: "CP-A" })).toEqual({ sessions: [s], total: 2 });
  });
});
