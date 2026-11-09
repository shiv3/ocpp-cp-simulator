import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PendingMessageQueue,
  type PendingMessage,
} from "../PendingMessageQueue";
import {
  NoopPendingMessageRepository,
  type PendingMessageRepository,
  type StoredPendingMessage,
} from "../../persistence/PendingMessageRepository";
import { OCPPAction } from "../../types/OcppTypes";

/**
 * In-memory {@link PendingMessageRepository} for one charge point: rows as
 * stored, loaded in the SQLite repository's order (seq ascending, a null
 * seq first, then created_at). The SQL itself is covered by
 * `infrastructure/persistence/__tests__/PendingMessageRepository.bun.test.ts`.
 */
class InMemoryPendingMessageRepository implements PendingMessageRepository {
  /** The stored rows, in insertion order. */
  readonly rows: StoredPendingMessage[] = [];

  loadAll(): StoredPendingMessage[] {
    return [...this.rows]
      .sort(
        (a, b) =>
          (a.seq ?? Number.NEGATIVE_INFINITY) -
            (b.seq ?? Number.NEGATIVE_INFINITY) ||
          a.createdAt.localeCompare(b.createdAt),
      )
      .map((row) => ({ ...row }));
  }

  insert(message: StoredPendingMessage): void {
    // (cp_id, message_id) is the table's primary key.
    if (this.rows.some((row) => row.messageId === message.messageId)) {
      throw new Error("UNIQUE constraint failed: pending_messages.message_id");
    }
    this.rows.push({ ...message });
  }

  delete(messageId: string): void {
    const index = this.rows.findIndex((row) => row.messageId === messageId);
    if (index >= 0) this.rows.splice(index, 1);
  }

  updateAttempts(messageId: string, attempts: number): void {
    const index = this.rows.findIndex((row) => row.messageId === messageId);
    if (index >= 0) this.rows[index] = { ...this.rows[index], attempts };
  }

  clear(): void {
    this.rows.length = 0;
  }
}

/** The 1.6 handler's queued actions. */
const QUEUED: ReadonlySet<OCPPAction> = new Set([
  OCPPAction.StartTransaction,
  OCPPAction.StopTransaction,
  OCPPAction.MeterValues,
]);

describe("PendingMessageQueue with seq", () => {
  describe("in-memory mode (no database)", () => {
    it("enqueues and dequeues with seq assignment", () => {
      const queue = new PendingMessageQueue(
        new NoopPendingMessageRepository(),
        QUEUED,
      );
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
      const queue = new PendingMessageQueue(
        new NoopPendingMessageRepository(),
        QUEUED,
      );
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
      const queue = new PendingMessageQueue(
        new NoopPendingMessageRepository(),
        QUEUED,
      );
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
      const queue = new PendingMessageQueue(
        new NoopPendingMessageRepository(),
        QUEUED,
      );
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
    let repo: InMemoryPendingMessageRepository;

    beforeEach(() => {
      repo = new InMemoryPendingMessageRepository();
    });

    it("persists and loads messages with seq", () => {
      const queue1 = new PendingMessageQueue(repo, QUEUED);
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
      const queue2 = new PendingMessageQueue(repo, QUEUED);
      expect(queue2.size()).toBe(2);
      const all = queue2.all();
      expect(all[0].action).toBe(OCPPAction.StartTransaction);
      expect(all[1].action).toBe(OCPPAction.MeterValues);
    });

    it("removeOldest drops the oldest row of one action only, persisted (#538)", () => {
      const queue1 = new PendingMessageQueue(repo, QUEUED);
      for (const [action, n] of [
        [OCPPAction.StartTransaction, 1],
        [OCPPAction.MeterValues, 2],
        [OCPPAction.MeterValues, 3],
      ] as const) {
        queue1.enqueue({ action, payload: { n }, connectorId: 1 });
      }
      expect(queue1.countOf(OCPPAction.MeterValues)).toBe(2);
      expect(queue1.removeOldest(OCPPAction.MeterValues)).toBe(true);
      expect(queue1.removeOldest(OCPPAction.StopTransaction)).toBe(false);

      const queue2 = new PendingMessageQueue(repo, QUEUED);
      expect(queue2.all().map((m) => m.payload)).toEqual([{ n: 1 }, { n: 3 }]);
      expect(queue2.countOf(OCPPAction.MeterValues)).toBe(1);
    });

    it("removeOldest with a predicate drops the oldest matching row only (#538)", () => {
      const queue1 = new PendingMessageQueue(repo, QUEUED);
      for (const n of [1, 2, 3, 4]) {
        queue1.enqueue({ action: OCPPAction.MeterValues, payload: { n } });
      }
      const even = (payload: unknown) => (payload as { n: number }).n % 2 === 0;
      expect(queue1.removeOldest(OCPPAction.MeterValues, even)).toBe(true);
      expect(
        queue1.removeOldest(
          OCPPAction.MeterValues,
          (p) => (p as { n: number }).n > 9,
        ),
      ).toBe(false);

      const queue2 = new PendingMessageQueue(repo, QUEUED);
      expect(queue2.all().map((m) => m.payload)).toEqual([
        { n: 1 },
        { n: 3 },
        { n: 4 },
      ]);
    });

    it("orders by seq on reload", () => {
      const queue1 = new PendingMessageQueue(repo, QUEUED);
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
      const queue2 = new PendingMessageQueue(repo, QUEUED);
      const all = queue2.all();
      expect(
        all.map((m) => (m.payload as Record<string, unknown>).order),
      ).toEqual([1, 2, 3]);
    });

    it("allocator restarts with seq continuing above MAX", () => {
      const queue1 = new PendingMessageQueue(repo, QUEUED);
      queue1.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { batch: 1 },
      });
      queue1.enqueue({
        action: OCPPAction.MeterValues,
        payload: { batch: 1 },
      });

      // Simulate restart: new queue loads from DB
      const queue2 = new PendingMessageQueue(repo, QUEUED);
      expect(queue2.size()).toBe(2);

      // Enqueue a new message; it should get seq >= 3
      queue2.enqueue({
        action: OCPPAction.StopTransaction,
        payload: { batch: 2 },
      });

      // Verify order: original 2 messages, then the new one
      const queue3 = new PendingMessageQueue(repo, QUEUED);
      expect(queue3.size()).toBe(3);
      const all = queue3.all();
      expect(all[2].action).toBe(OCPPAction.StopTransaction);
    });

    it("advances seq by exactly 1 per enqueue", () => {
      const queue = new PendingMessageQueue(repo, QUEUED);
      queue.enqueue({ action: OCPPAction.StartTransaction, payload: {} });
      queue.enqueue({ action: OCPPAction.MeterValues, payload: {} });
      queue.enqueue({ action: OCPPAction.StopTransaction, payload: {} });

      const seqs = repo.rows.map((r) => r.seq);
      expect(seqs).toEqual([1, 2, 3]);
    });

    it("does not leak persistence columns through the public shape", () => {
      const queue = new PendingMessageQueue(repo, QUEUED);
      queue.enqueue({ action: OCPPAction.StartTransaction, payload: {} });

      const flushed: PendingMessage[] = [];
      queue.flush((msg) => {
        flushed.push(msg);
        return true;
      }, 3);

      const queue2 = new PendingMessageQueue(repo, QUEUED);
      queue2.enqueue({ action: OCPPAction.MeterValues, payload: {} });
      const seen = [...queue2.all(), queue2.dequeue()!, ...flushed];

      for (const msg of seen) {
        expect(msg).not.toHaveProperty("seq");
        expect(msg).not.toHaveProperty("messageId");
      }
    });

    it("keeps message ids unique across restarts within one millisecond", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      // Two queue instances for the same cp, opened while the clock is
      // frozen: the second one loads the first one's rows and must not mint
      // an id that collides with them ((cp_id, message_id) is the PK).
      const queue1 = new PendingMessageQueue(repo, QUEUED);
      queue1.enqueue({ action: OCPPAction.StartTransaction, payload: {} });
      queue1.enqueue({ action: OCPPAction.MeterValues, payload: {} });

      const queue2 = new PendingMessageQueue(repo, QUEUED);
      queue2.enqueue({ action: OCPPAction.StopTransaction, payload: {} });

      vi.useRealTimers();

      const ids = repo.rows.map((r) => r.messageId);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    });

    it("flush() removes delivered messages and retries failed ones", () => {
      const queue = new PendingMessageQueue(repo, QUEUED);
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
      const queue = new PendingMessageQueue(repo, QUEUED);
      queue.enqueue({ action: OCPPAction.StartTransaction, payload: {} });
      queue.enqueue({ action: OCPPAction.MeterValues, payload: {} });

      queue.clear();
      expect(queue.size()).toBe(0);

      // Verify it's gone from DB too
      const queue2 = new PendingMessageQueue(repo, QUEUED);
      expect(queue2.size()).toBe(0);
    });

    it("different CPs maintain separate seq counters", () => {
      // One repository per charge point, as ChargePoint builds them; the
      // per-cp_id SQL is covered by the SQLite repository's bun test.
      const repoA = new InMemoryPendingMessageRepository();
      const repoB = new InMemoryPendingMessageRepository();
      const queueA = new PendingMessageQueue(repoA, QUEUED);
      queueA.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { cp: "a" },
      });
      queueA.enqueue({ action: OCPPAction.MeterValues, payload: { cp: "a" } });

      const queueB = new PendingMessageQueue(repoB, QUEUED);
      queueB.enqueue({
        action: OCPPAction.StartTransaction,
        payload: { cp: "b" },
      });

      const queueA2 = new PendingMessageQueue(repoA, QUEUED);
      expect(queueA2.size()).toBe(2);

      const queueB2 = new PendingMessageQueue(repoB, QUEUED);
      expect(queueB2.size()).toBe(1);

      // Verify order within each CP
      const allA = queueA2.all();
      const allB = queueB2.all();
      expect((allA[0].payload as Record<string, unknown>).cp).toBe("a");
      expect((allB[0].payload as Record<string, unknown>).cp).toBe("b");
    });

    it("deletes on load the rows of actions it does not queue (#528)", () => {
      // The table is shared by the 1.6 and 2.x handlers of one charge point.
      const v2 = new PendingMessageQueue(repo, new Set(["TransactionEvent"]));
      v2.enqueue({ action: "TransactionEvent", payload: { seqNo: 0 } });
      const before = new PendingMessageQueue(repo, QUEUED);
      before.enqueue({ action: OCPPAction.MeterValues, payload: {} });
      // Deleted from the table at once, not only skipped.
      expect(repo.rows.map((r) => r.action)).toEqual([OCPPAction.MeterValues]);
      expect(before.droppedOnLoad).toEqual(["TransactionEvent"]);

      const reloaded = new PendingMessageQueue(repo, QUEUED);
      expect(reloaded.droppedOnLoad).toEqual([]);
      expect(reloaded.all().map((m) => m.action)).toEqual([
        OCPPAction.MeterValues,
      ]);
    });
  });

  describe("StartTransaction/StopTransaction ordering", () => {
    it("maintains Start before Stop when enqueued in same millisecond", () => {
      const queue = new PendingMessageQueue(
        new NoopPendingMessageRepository(),
        QUEUED,
      );
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
      const repo = new InMemoryPendingMessageRepository();
      const queue1 = new PendingMessageQueue(repo, QUEUED);
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
      const queue2 = new PendingMessageQueue(repo, QUEUED);
      const all = queue2.all();
      expect(all[0].action).toBe(OCPPAction.StartTransaction);
      expect(all[1].action).toBe(OCPPAction.StopTransaction);
    });
  });
});
