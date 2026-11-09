// Runs under `bun test`: the SQLite implementation uses the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";

import { BunSqliteDatabase } from "../BunSqliteDatabase";
import { SqlitePendingMessageRepository } from "../SqlitePendingMessageRepository";
import type { StoredPendingMessage } from "../../../domain/persistence/PendingMessageRepository";
import { PendingMessageQueue } from "../../../domain/transport/PendingMessageQueue";
import { OCPPAction } from "../../../domain/types/OcppTypes";

/** The `pending_messages` table behind PendingMessageQueue (#878). */

const opened: BunSqliteDatabase[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function openDb(): BunSqliteDatabase {
  const db = BunSqliteDatabase.open(":memory:");
  opened.push(db);
  return db;
}

function message(
  messageId: string,
  seq: number | null,
  createdAt = "2026-11-09T10:00:00.000Z",
): StoredPendingMessage {
  return {
    messageId,
    action: "StartTransaction",
    connectorId: 1,
    payload: JSON.stringify({ id: messageId }),
    attempts: 0,
    createdAt,
    seq,
  };
}

describe("SqlitePendingMessageRepository", () => {
  it("round-trips messages per charge point, by seq", () => {
    const db = openDb();
    const repo = new SqlitePendingMessageRepository("CP-A", db);
    expect(repo.loadAll()).toEqual([]);

    repo.insert(message("m2", 2));
    repo.insert({ ...message("m1", 1), connectorId: null });
    new SqlitePendingMessageRepository("CP-B", db).insert(message("m3", 3));

    expect(new SqlitePendingMessageRepository("CP-A", db).loadAll()).toEqual([
      { ...message("m1", 1), connectorId: null },
      message("m2", 2),
    ]);
    expect(
      new SqlitePendingMessageRepository("CP-B", db)
        .loadAll()
        .map((m) => m.messageId),
    ).toEqual(["m3"]);
  });

  it("orders rows without a seq first, then by created_at", () => {
    const db = openDb();
    const repo = new SqlitePendingMessageRepository("CP-A", db);
    repo.insert(message("late", null, "2026-11-09T10:00:02.000Z"));
    repo.insert(message("seq1", 1));
    repo.insert(message("early", null, "2026-11-09T10:00:01.000Z"));

    expect(repo.loadAll().map((m) => m.messageId)).toEqual([
      "early",
      "late",
      "seq1",
    ]);
  });

  it("updates attempts, deletes one row and clears its charge point only", () => {
    const db = openDb();
    const repo = new SqlitePendingMessageRepository("CP-A", db);
    const other = new SqlitePendingMessageRepository("CP-B", db);
    repo.insert(message("m1", 1));
    repo.insert(message("m2", 2));
    other.insert(message("m1", 1));

    repo.updateAttempts("m2", 3);
    repo.delete("m1");
    expect(repo.loadAll()).toEqual([{ ...message("m2", 2), attempts: 3 }]);
    expect(other.loadAll()).toEqual([message("m1", 1)]);

    repo.clear();
    expect(repo.loadAll()).toEqual([]);
    expect(other.loadAll()).toHaveLength(1);
  });

  it("has the seq column and its (cp_id, seq) index on a fresh database", () => {
    const db = openDb();
    expect(
      db
        .all<{ name: string }>("PRAGMA table_info(pending_messages)")
        .map((c) => c.name),
    ).toContain("seq");
    expect(
      db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'pending_by_cp_seq'",
      ),
    ).toHaveLength(1);
  });

  it("replays rows from before the seq column in insertion order once backfilled", () => {
    const db = openDb();
    const now = "2026-07-24T12:00:00.000Z";
    for (const [id, action] of [
      ["msg-1", OCPPAction.StartTransaction],
      ["msg-2", OCPPAction.MeterValues],
      ["msg-3", OCPPAction.StopTransaction],
    ]) {
      db.run(
        "INSERT INTO pending_messages (cp_id, message_id, action, connector_id, payload, attempts, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ["cp-legacy", id, action, 1, '{"tx":1}', 0, now, null],
      );
    }
    // The v5 → v6 migration's backfill.
    db.run("UPDATE pending_messages SET seq = rowid WHERE seq IS NULL");

    const queue = new PendingMessageQueue(
      new SqlitePendingMessageRepository("cp-legacy", db),
      new Set([
        OCPPAction.StartTransaction,
        OCPPAction.StopTransaction,
        OCPPAction.MeterValues,
      ]),
    );

    expect(queue.all().map((m) => m.action)).toEqual([
      OCPPAction.StartTransaction,
      OCPPAction.MeterValues,
      OCPPAction.StopTransaction,
    ]);
  });

  it("restores a queue across a restart, its seq continuing above the max", () => {
    const db = openDb();
    const queued = new Set([OCPPAction.StartTransaction]);
    const first = new PendingMessageQueue(
      new SqlitePendingMessageRepository("CP-A", db),
      queued,
    );
    first.enqueue({ action: OCPPAction.StartTransaction, payload: { n: 1 } });
    first.enqueue({ action: OCPPAction.StartTransaction, payload: { n: 2 } });

    const restarted = new PendingMessageQueue(
      new SqlitePendingMessageRepository("CP-A", db),
      queued,
    );
    restarted.enqueue({
      action: OCPPAction.StartTransaction,
      payload: { n: 3 },
    });

    expect(restarted.all().map((m) => m.payload)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
    expect(
      new SqlitePendingMessageRepository("CP-A", db)
        .loadAll()
        .map((m) => m.seq),
    ).toEqual([1, 2, 3]);
  });
});
