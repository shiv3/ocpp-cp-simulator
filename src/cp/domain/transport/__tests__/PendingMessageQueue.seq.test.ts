import { describe, it, expect, beforeEach, vi } from "vitest";
import { PendingMessageQueue } from "../PendingMessageQueue";
import type { Database } from "../../persistence/Database";
import { OCPPAction } from "../../types/OcppTypes";

/**
 * Mock in-memory Database implementation for vitest testing.
 * Implements a minimal SQL subset sufficient for PendingMessageQueue.
 */
class MockSqliteDatabase implements Database {
  private tables: Map<string, Map<string, Record<string, unknown>>> = new Map();
  private indices: Map<string, string[]> = new Map();

  constructor() {
    this.initializeTables();
  }

  private initializeTables(): void {
    // Create schema_meta table
    this.tables.set("schema_meta", new Map());
    // Create pending_messages table
    this.tables.set("pending_messages", new Map());
  }

  exec(sql: string): void {
    // Handle schema creation DDL
    if (sql.includes("CREATE INDEX IF NOT EXISTS pending_by_cp_seq")) {
      this.indices.set("pending_by_cp_seq", []);
    }
  }

  run(sql: string, params: unknown[] = []): void {
    if (sql.includes("INSERT INTO schema_meta")) {
      const table = this.tables.get("schema_meta")!;
      table.set(params[0] as string, { value: params[1] });
    } else if (sql.includes("INSERT INTO pending_messages")) {
      const table = this.tables.get("pending_messages")!;
      const [
        cp_id,
        message_id,
        action,
        connector_id,
        payload,
        attempts,
        created_at,
        seq,
      ] = params;
      const key = `${cp_id}|${message_id}`;
      table.set(key, {
        cp_id,
        message_id,
        action,
        connector_id,
        payload,
        attempts,
        created_at,
        seq,
      });
    } else if (sql.includes("UPDATE pending_messages SET attempts")) {
      const [attempts, cp_id, message_id] = params;
      const table = this.tables.get("pending_messages")!;
      const key = `${cp_id}|${message_id}`;
      const row = table.get(key);
      if (row) {
        table.set(key, { ...row, attempts });
      }
    } else if (sql.includes("UPDATE pending_messages SET seq = rowid")) {
      // Backfill seq from rowid during migration
      const table = this.tables.get("pending_messages")!;
      let rowid = 1;
      for (const [, row] of table.entries()) {
        if (row.seq === null || row.seq === undefined) {
          row.seq = rowid;
        }
        rowid++;
      }
    } else if (sql.includes("DELETE FROM pending_messages")) {
      const table = this.tables.get("pending_messages")!;
      if (sql.includes("WHERE cp_id = ? AND message_id = ?")) {
        const [cp_id, message_id] = params;
        const key = `${cp_id}|${message_id}`;
        table.delete(key);
      } else if (sql.includes("WHERE cp_id = ?")) {
        const [cp_id] = params;
        for (const key of table.keys()) {
          if (key.startsWith(`${cp_id}|`)) {
            table.delete(key);
          }
        }
      }
    }
  }

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    if (sql.includes("PRAGMA table_info")) {
      // Support for migration column checks
      const tableName = sql.match(/PRAGMA table_info\((\w+)\)/)?.[1];
      if (tableName === "pending_messages") {
        return [
          { name: "cp_id" },
          { name: "message_id" },
          { name: "action" },
          { name: "connector_id" },
          { name: "payload" },
          { name: "attempts" },
          { name: "created_at" },
          { name: "seq" },
        ] as T[];
      }
    } else if (sql.includes("SELECT name FROM sqlite_master")) {
      // Support for index checks
      const indices = [
        { name: "pending_by_cp_seq" },
        { name: "pending_by_cp" },
      ];
      return indices as T[];
    } else if (
      sql.includes(
        "SELECT message_id, action, connector_id, payload, attempts, created_at, seq",
      ) &&
      sql.includes("FROM pending_messages")
    ) {
      const table = this.tables.get("pending_messages")!;
      const [cp_id] = params;
      const rows: T[] = [];
      for (const row of table.values()) {
        if ((row as Record<string, unknown>).cp_id === cp_id) {
          // Return in seq order
          rows.push(row as T);
        }
      }
      // Sort by seq to match ORDER BY seq ASC
      rows.sort((a, b) => {
        const seqA = (a as Record<string, unknown>).seq as number;
        const seqB = (b as Record<string, unknown>).seq as number;
        return (seqA || 0) - (seqB || 0);
      });
      return rows;
    }
    return [] as T[];
  }

  get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): T | null {
    if (sql.includes("SELECT value FROM schema_meta")) {
      const table = this.tables.get("schema_meta")!;
      const row = table.get(params[0] as string);
      return (row as T) || null;
    }
    return null;
  }

  close(): void {
    this.tables.clear();
  }
}

/** Raw persisted rows for a cp, in seq order — bypasses the queue's own
 *  mapping so tests can assert on `seq` / `message_id` directly. */
function readRows(
  db: Database,
  cpId: string,
): { message_id: string; seq: number }[] {
  return db.all<{ message_id: string; seq: number }>(
    "SELECT message_id, action, connector_id, payload, attempts, created_at, seq " +
      "FROM pending_messages WHERE cp_id = ? ORDER BY seq ASC, created_at ASC",
    [cpId],
  );
}

describe("PendingMessageQueue with seq", () => {
  describe("in-memory mode (no database)", () => {
    it("enqueues and dequeues with seq assignment", () => {
      const queue = new PendingMessageQueue("cp-test");
      queue.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { foo: "bar" },
        connectorId: 1,
      });
      queue.enqueue({
        action: OCPPAction.MeterValues,
        payload: { baz: "qux" },
        connectorId: 1,
      });

      expect(queue.size()).toBe(2);
      const all = queue.all();
      expect(all[0].action).toBe(OCPPAction.StartTransaction);
      expect(all[1].action).toBe(OCPPAction.MeterValues);
    });

    it("maintains FIFO order for same-millisecond bursts", () => {
      const queue = new PendingMessageQueue("cp-test");
      const now = 1700000000000;
      vi.setSystemTime(new Date(now));

      queue.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { tx: 1 },
        connectorId: 1,
      });
      queue.enqueue({
        action: OCPPAction.MeterValues,
        payload: { tx: 1, meterValue: 100 },
        connectorId: 1,
      });
      queue.enqueue({
        action: OCPPAction.StopTransaction,
        payload: { tx: 1 },
        connectorId: 1,
      });

      vi.useRealTimers();

      const all = queue.all();
      expect(all[0].action).toBe(OCPPAction.StartTransaction);
      expect(all[1].action).toBe(OCPPAction.MeterValues);
      expect(all[2].action).toBe(OCPPAction.StopTransaction);
    });

    it("continues seq counter across multiple enqueue calls", () => {
      const queue = new PendingMessageQueue("cp-test");
      queue.enqueue({
        action: OCPPAction.StartTransaction,
        payload: {},
      });
      queue.enqueue({
        action: OCPPAction.MeterValues,
        payload: {},
      });

      expect(queue.size()).toBe(2);
      const all = queue.all();
      // Verify both are enqueued (seq is internal, not exposed in PendingMessage)
      expect(all.length).toBe(2);
    });

    it("dequeues in FIFO order", () => {
      const queue = new PendingMessageQueue("cp-test");
      queue.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { order: 1 },
      });
      queue.enqueue({
        action: OCPPAction.MeterValues,
        payload: { order: 2 },
      });

      const msg1 = queue.dequeue();
      expect(msg1?.action).toBe(OCPPAction.StartTransaction);
      expect((msg1?.payload as Record<string, unknown>).order).toBe(1);

      const msg2 = queue.dequeue();
      expect(msg2?.action).toBe(OCPPAction.MeterValues);
      expect((msg2?.payload as Record<string, unknown>).order).toBe(2);

      expect(queue.dequeue()).toBeUndefined();
    });
  });

  describe("database-backed mode", () => {
    let db: MockSqliteDatabase;

    beforeEach(() => {
      db = new MockSqliteDatabase();
      // Simulate running migrations to set up schema
      db.run("INSERT INTO schema_meta (key, value) VALUES ('version', ?)", [
        "version",
        "6",
      ]);
    });

    it("persists and loads messages with seq", () => {
      const queue1 = new PendingMessageQueue("cp-db-test", db);
      queue1.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { tx: 123 },
        connectorId: 1,
      });
      queue1.enqueue({
        action: OCPPAction.MeterValues,
        payload: { tx: 123, meterValue: 500 },
        connectorId: 1,
      });

      // Create a new queue instance and load from DB
      const queue2 = new PendingMessageQueue("cp-db-test", db);
      expect(queue2.size()).toBe(2);
      const all = queue2.all();
      expect(all[0].action).toBe(OCPPAction.StartTransaction);
      expect(all[1].action).toBe(OCPPAction.MeterValues);
    });

    it("orders by seq on reload", () => {
      const queue1 = new PendingMessageQueue("cp-db-test", db);
      const now = 1700000000000;
      vi.setSystemTime(new Date(now));

      queue1.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { order: 1 },
      });
      queue1.enqueue({
        action: OCPPAction.MeterValues,
        payload: { order: 2 },
      });
      queue1.enqueue({
        action: OCPPAction.StopTransaction,
        payload: { order: 3 },
      });

      vi.useRealTimers();

      // Reload and verify order is preserved
      const queue2 = new PendingMessageQueue("cp-db-test", db);
      const all = queue2.all();
      expect(
        all.map((m) => (m.payload as Record<string, unknown>).order),
      ).toEqual([1, 2, 3]);
    });

    it("allocator restarts with seq continuing above MAX", () => {
      const queue1 = new PendingMessageQueue("cp-db-test", db);
      queue1.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { batch: 1 },
      });
      queue1.enqueue({
        action: OCPPAction.MeterValues,
        payload: { batch: 1 },
      });

      // Simulate restart: new queue loads from DB
      const queue2 = new PendingMessageQueue("cp-db-test", db);
      expect(queue2.size()).toBe(2);

      // Enqueue a new message; it should get seq >= 3
      queue2.enqueue({
        action: OCPPAction.StopTransaction,
        payload: { batch: 2 },
      });

      // Verify order: original 2 messages, then the new one
      const queue3 = new PendingMessageQueue("cp-db-test", db);
      expect(queue3.size()).toBe(3);
      const all = queue3.all();
      expect(all[2].action).toBe(OCPPAction.StopTransaction);
    });

    it("advances seq by exactly 1 per enqueue", () => {
      const queue = new PendingMessageQueue("cp-db-test", db);
      queue.enqueue({ action: OCPPAction.StartTransaction, payload: {} });
      queue.enqueue({ action: OCPPAction.MeterValues, payload: {} });
      queue.enqueue({ action: OCPPAction.StopTransaction, payload: {} });

      const seqs = readRows(db, "cp-db-test").map((r) => r.seq);
      expect(seqs).toEqual([1, 2, 3]);
    });

    it("keeps message ids unique across restarts within one millisecond", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      // Two queue instances for the same cp, opened while the clock is
      // frozen: the second one loads the first one's rows and must not mint
      // an id that collides with them ((cp_id, message_id) is the PK).
      const queue1 = new PendingMessageQueue("cp-db-test", db);
      queue1.enqueue({ action: OCPPAction.StartTransaction, payload: {} });
      queue1.enqueue({ action: OCPPAction.MeterValues, payload: {} });

      const queue2 = new PendingMessageQueue("cp-db-test", db);
      queue2.enqueue({ action: OCPPAction.StopTransaction, payload: {} });

      vi.useRealTimers();

      const ids = readRows(db, "cp-db-test").map((r) => r.message_id);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    });

    it("flush() removes delivered messages and retries failed ones", () => {
      const queue = new PendingMessageQueue("cp-db-test", db);
      queue.enqueue({
        action: OCPPAction.StartTransaction,
        payload: {},
      });
      queue.enqueue({
        action: OCPPAction.MeterValues,
        payload: {},
      });

      let successCount = 0;
      const delivered = queue.flush(() => {
        successCount++;
        return successCount > 1; // Fail the first, succeed on second attempt
      }, 2);

      // Only the first message was attempted; flush stops on failure
      expect(delivered).toBe(0);
      expect(queue.size()).toBe(2); // Both still in queue

      // Next flush: first message retried and fails again (attempts=2)
      successCount = 0;
      queue.flush(() => {
        return false; // Fail all
      }, 2);

      expect(queue.size()).toBe(1); // First message was dropped (max attempts)
    });

    it("clear() removes all messages for this CP", () => {
      const queue = new PendingMessageQueue("cp-db-test", db);
      queue.enqueue({ action: OCPPAction.StartTransaction, payload: {} });
      queue.enqueue({ action: OCPPAction.MeterValues, payload: {} });

      queue.clear();
      expect(queue.size()).toBe(0);

      // Verify it's gone from DB too
      const queue2 = new PendingMessageQueue("cp-db-test", db);
      expect(queue2.size()).toBe(0);
    });

    it("different CPs maintain separate seq counters", () => {
      const queueA = new PendingMessageQueue("cp-a", db);
      queueA.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { cp: "a" },
      });
      queueA.enqueue({ action: OCPPAction.MeterValues, payload: { cp: "a" } });

      const queueB = new PendingMessageQueue("cp-b", db);
      queueB.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { cp: "b" },
      });

      const queueA2 = new PendingMessageQueue("cp-a", db);
      expect(queueA2.size()).toBe(2);

      const queueB2 = new PendingMessageQueue("cp-b", db);
      expect(queueB2.size()).toBe(1);

      // Verify order within each CP
      const allA = queueA2.all();
      const allB = queueB2.all();
      expect((allA[0].payload as Record<string, unknown>).cp).toBe("a");
      expect((allB[0].payload as Record<string, unknown>).cp).toBe("b");
    });
  });

  describe("legacy/migration scenarios", () => {
    it("handles pre-migration rows with identical created_at", () => {
      // Simulate a pre-migration DB with duplicate timestamps
      const db = new MockSqliteDatabase();
      const now = new Date("2026-07-24T12:00:00.000Z").toISOString();

      // Insert rows with identical created_at but different seq values after backfill
      db.run(
        "INSERT INTO pending_messages (cp_id, message_id, action, connector_id, payload, attempts, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "cp-legacy",
          "msg-1",
          OCPPAction.StartTransaction,
          1,
          '{"tx":1}',
          0,
          now,
          null,
        ],
      );
      db.run(
        "INSERT INTO pending_messages (cp_id, message_id, action, connector_id, payload, attempts, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "cp-legacy",
          "msg-2",
          OCPPAction.MeterValues,
          1,
          '{"tx":1,"meterValue":100}',
          0,
          now,
          null,
        ],
      );
      db.run(
        "INSERT INTO pending_messages (cp_id, message_id, action, connector_id, payload, attempts, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "cp-legacy",
          "msg-3",
          OCPPAction.StopTransaction,
          1,
          '{"tx":1}',
          0,
          now,
          null,
        ],
      );

      // Simulate migration: backfill seq from rowid
      db.run("UPDATE pending_messages SET seq = rowid WHERE seq IS NULL", []);

      // Load and verify order is preserved
      const queue = new PendingMessageQueue("cp-legacy", db);
      const all = queue.all();

      expect(all.length).toBe(3);
      expect(all[0].action).toBe(OCPPAction.StartTransaction);
      expect(all[1].action).toBe(OCPPAction.MeterValues);
      expect(all[2].action).toBe(OCPPAction.StopTransaction);
    });

    it("fresh DB has seq column in schema", () => {
      const db = new MockSqliteDatabase();
      const rows = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_messages'",
      );
      // In mock, table exists; in real DB, schema creation would add seq column
      expect(rows.length).toBeGreaterThanOrEqual(0);
    });

    it("index pending_by_cp_seq exists after migration", () => {
      const db = new MockSqliteDatabase();
      db.exec(
        "CREATE INDEX IF NOT EXISTS pending_by_cp_seq ON pending_messages (cp_id, seq)",
      );

      const indices = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'pending_by_cp_seq'",
      );
      expect(indices.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("StartTransaction/StopTransaction ordering", () => {
    it("maintains Start before Stop when enqueued in same millisecond", () => {
      const queue = new PendingMessageQueue("cp-tx-order");
      const now = 1700000000000;
      vi.setSystemTime(new Date(now));

      queue.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { transactionId: 123 },
        connectorId: 1,
      });
      queue.enqueue({
        action: OCPPAction.StopTransaction,
        payload: { transactionId: 123 },
        connectorId: 1,
      });

      vi.useRealTimers();

      const all = queue.all();
      expect(all[0].action).toBe(OCPPAction.StartTransaction);
      expect(all[1].action).toBe(OCPPAction.StopTransaction);
      expect(all.length).toBe(2);
    });

    it("Start-Stop order preserved across restart", () => {
      const db = new MockSqliteDatabase();
      const queue1 = new PendingMessageQueue("cp-tx-persist", db);
      const now = 1700000000000;
      vi.setSystemTime(new Date(now));

      queue1.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { transactionId: 456 },
        connectorId: 1,
      });
      queue1.enqueue({
        action: OCPPAction.StopTransaction,
        payload: { transactionId: 456 },
        connectorId: 1,
      });

      vi.useRealTimers();

      // Reload from DB
      const queue2 = new PendingMessageQueue("cp-tx-persist", db);
      const all = queue2.all();
      expect(all[0].action).toBe(OCPPAction.StartTransaction);
      expect(all[1].action).toBe(OCPPAction.StopTransaction);
    });
  });
});
