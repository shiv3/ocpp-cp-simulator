import type { OCPPAction } from "../types/OcppTypes";
import type { Database } from "../persistence/Database";

/**
 * One queued CALL waiting to be (re)delivered. Stored verbatim — the
 * payload is `unknown` because each action has its own generated request
 * type. `A` is the action vocabulary of the protocol that owns the queue:
 * {@link OCPPAction} for 1.6, the 2.x handler's own action union for 2.0.1 /
 * 2.1 (#528).
 */
export interface PendingMessage<A extends string = OCPPAction> {
  /** Action name (1.6: StartTransaction / StopTransaction / MeterValues;
   *  2.x: TransactionEvent). */
  action: A;
  /** Serialized request payload. */
  payload: unknown;
  /** Connector this message belongs to, for logging/diagnostics. */
  connectorId?: number;
  /** Enqueue timestamp (epoch ms) for retry-interval calculation. */
  queuedAt: number;
  /** How many send attempts have already been made. */
  attempts: number;
}

/**
 * Internal row shape — `messageId` is the PRIMARY KEY in the
 * `pending_messages` table but isn't part of the public PendingMessage
 * shape, so we keep it next to the payload here. `seq` is a monotonic
 * per-CP sequence number for stable ordering across restarts.
 */
interface PendingRow<A extends string> extends PendingMessage<A> {
  messageId: string;
  seq: number;
}

/**
 * Persistent queue of transaction-related messages that failed to deliver
 * (typically because the WebSocket was offline). Each protocol handler owns
 * one; both share the `pending_messages` table, keyed by charge point.
 *
 * OCPP 2.0.1 / 2.1 (#528): the 2.x handler queues TransactionEvent requests
 * under E11.FR.01 and replays them with `offline = true` (E11.FR.02); it
 * reads the queue with `dequeue`, not `flush`, since E13 owns the attempt
 * counting there.
 *
 * OCPP 1.6: matches OCPP 1.6 §4.7 /
 * §4.8 / §4.10 + errata 3.18: "When the Central System fails to process
 * a transaction-related message, the Charge Point SHALL retry up to
 * `TransactionMessageAttempts` times at `TransactionMessageRetryInterval`
 * intervals." Queue contents persist across reboots so a power outage
 * during an active transaction doesn't lose StartTransaction.req.
 *
 * On 1.6 only StartTransaction / StopTransaction / MeterValues(with
 * transactionId) belong here. Heartbeats, StatusNotifications, etc. are
 * informational and are fine to drop while offline.
 *
 * Backed by the SQLite `pending_messages` table when a {@link Database}
 * is provided; falls back to an in-memory queue otherwise (tests / future
 * memory-only daemon mode).
 */
export class PendingMessageQueue<A extends string = OCPPAction> {
  private items: PendingRow<A>[] = [];
  /** Persisted FIFO ordering key; seeded from MAX(seq) for this cp on load. */
  private nextSeq = 0;
  /** Independent counter for the user-visible message id — keeping it apart
   *  from `nextSeq` stops an id allocation from perturbing the ordering key. */
  private nextIdSuffix = 0;

  constructor(
    private readonly chargePointId: string,
    private readonly database: Database | null = null,
  ) {
    this.load();
  }

  /** Snapshot of the current queue (FIFO order). */
  all(): PendingMessage<A>[] {
    return this.items.map(toPendingMessage);
  }

  size(): number {
    return this.items.length;
  }

  enqueue(message: Omit<PendingMessage<A>, "queuedAt" | "attempts">): void {
    const row: PendingRow<A> = {
      ...message,
      queuedAt: Date.now(),
      attempts: 0,
      messageId: this.nextMessageId(),
      seq: this.nextSeq++,
    };
    this.items.push(row);
    this.insertRow(row);
  }

  /** Remove the head and persist. Returns the dequeued message or undefined. */
  dequeue(): PendingMessage<A> | undefined {
    const row = this.items.shift();
    if (!row) return undefined;
    this.deleteRow(row.messageId);
    return toPendingMessage(row);
  }

  /**
   * Pop entries from the front while `accept` consumes them. The callback
   * returns whether the send succeeded (true → discard, false → put back
   * at front with attempts++). Stops as soon as one entry fails to send
   * so retries respect order. Returns the count delivered.
   */
  flush(
    send: (message: PendingMessage<A>) => boolean,
    maxAttempts: number,
  ): number {
    let delivered = 0;
    while (this.items.length > 0) {
      const head = this.items[0];
      const ok = send(toPendingMessage(head));
      if (!ok) {
        head.attempts += 1;
        if (head.attempts >= maxAttempts) {
          this.items.shift();
          this.deleteRow(head.messageId);
          continue;
        }
        // Could not send (still offline?). Persist the attempts bump and
        // stop flushing so the next pass picks up where we left off.
        this.updateAttempts(head.messageId, head.attempts);
        break;
      }
      this.items.shift();
      this.deleteRow(head.messageId);
      delivered += 1;
    }
    return delivered;
  }

  clear(): void {
    this.items = [];
    if (this.database) {
      this.database.run("DELETE FROM pending_messages WHERE cp_id = ?", [
        this.chargePointId,
      ]);
    }
  }

  // ── persistence helpers ────────────────────────────────────────────────

  private load(): void {
    if (!this.database) {
      // In-memory-only mode: nothing persisted, so both counters start fresh.
      this.nextSeq = 1;
      this.nextIdSuffix = 0;
      return;
    }
    try {
      const rows = this.database.all<{
        message_id: string;
        action: string;
        connector_id: number | null;
        payload: string;
        attempts: number;
        created_at: string;
        seq: number | null;
      }>(
        "SELECT message_id, action, connector_id, payload, attempts, created_at, seq " +
          "FROM pending_messages WHERE cp_id = ? ORDER BY seq ASC, created_at ASC",
        [this.chargePointId],
      );
      this.items = rows.map((r) => ({
        messageId: r.message_id,
        // Stored by this protocol's handler; a row the handler does not
        // know is refused when it is replayed.
        action: r.action as A,
        payload: safeParse(r.payload),
        connectorId: r.connector_id ?? undefined,
        queuedAt: Date.parse(r.created_at) || Date.now(),
        attempts: r.attempts,
        seq: r.seq ?? 0,
      }));
      // Initialize seq counter to 1 + MAX(seq) to avoid collisions.
      const maxSeq = this.items.reduce(
        (max, item) => Math.max(max, item.seq),
        0,
      );
      this.nextSeq = maxSeq + 1;
      // The id suffix rides the same high-water mark so a queue reopened
      // within the same millisecond cannot mint an id that collides with a
      // persisted row (message_id is part of the primary key).
      this.nextIdSuffix = maxSeq;
    } catch (err) {
      console.error("Failed to load pending transaction queue:", err);
      this.nextSeq = 1;
      this.nextIdSuffix = 0;
    }
  }

  private insertRow(row: PendingRow<A>): void {
    if (!this.database) return;
    try {
      this.database.run(
        "INSERT INTO pending_messages " +
          "(cp_id, message_id, action, connector_id, payload, attempts, created_at, seq) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          this.chargePointId,
          row.messageId,
          row.action,
          row.connectorId ?? null,
          JSON.stringify(row.payload),
          row.attempts,
          new Date(row.queuedAt).toISOString(),
          row.seq,
        ],
      );
    } catch (err) {
      console.error("Failed to enqueue pending message:", err);
    }
  }

  private deleteRow(messageId: string): void {
    if (!this.database) return;
    try {
      this.database.run(
        "DELETE FROM pending_messages WHERE cp_id = ? AND message_id = ?",
        [this.chargePointId, messageId],
      );
    } catch (err) {
      console.error("Failed to delete pending message:", err);
    }
  }

  private updateAttempts(messageId: string, attempts: number): void {
    if (!this.database) return;
    try {
      this.database.run(
        "UPDATE pending_messages SET attempts = ? WHERE cp_id = ? AND message_id = ?",
        [attempts, this.chargePointId, messageId],
      );
    } catch (err) {
      console.error("Failed to update pending message attempts:", err);
    }
  }

  private nextMessageId(): string {
    // Per-instance monotonic id; mixed with the wall-clock so concurrent
    // queues for different cps don't collide (cp_id is part of the PK
    // anyway, but the id is also user-visible in logs).
    const suffix = (this.nextIdSuffix += 1);
    return `${Date.now().toString(36)}-${suffix.toString(36)}`;
  }
}

/** Strip the persistence-only columns so callers see exactly the declared
 *  {@link PendingMessage} shape — `messageId` and `seq` are storage details. */
function toPendingMessage<A extends string>(
  row: PendingRow<A>,
): PendingMessage<A> {
  const { messageId: _id, seq: _seq, ...msg } = row;
  return msg;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
