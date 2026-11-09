import type { OCPPAction } from "../types/OcppTypes";
import {
  NoopPendingMessageRepository,
  type PendingMessageRepository,
} from "../persistence/PendingMessageRepository";
import { realClock } from "../../shared/clock";
import type { SimClock } from "../../shared/clock";

/**
 * One queued CALL waiting to be (re)delivered. Stored verbatim — the
 * payload is `unknown` because each action has its own generated request
 * type. `A` is the action vocabulary of the protocol that owns the queue:
 * {@link OCPPAction} for 1.6, the 2.x handler's own action union for 2.0.1 /
 * 2.1 (#528).
 */
export interface PendingMessage<A extends string = OCPPAction> {
  /** Action name (1.6: StartTransaction / StopTransaction / MeterValues;
   *  2.x: TransactionEvent, NotifyEvent, SecurityEventNotification). */
  action: A;
  /** Serialized request payload. */
  payload: unknown;
  /** Connector this message belongs to, for logging/diagnostics. */
  connectorId?: number;
  /** Enqueue timestamp (epoch ms) for retry-interval calculation. */
  queuedAt: number;
  /** How many send attempts have already been made. A 1.6 resend salvaged
   *  here enqueues with its count so far (#527, §3.7.1). */
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
 * Each handler names the actions it queues. The table is shared by charge
 * point id and `cp.update` can switch ocppVersion over the same
 * --state-db, so a row of any other action (the other protocol's) is
 * deleted when the queue loads and listed in {@link droppedOnLoad} (#528).
 *
 * OCPP 2.0.1 / 2.1 (#528): the 2.x handler queues TransactionEvent requests
 * under E11.FR.01 and replays them with `offline = true` (E11.FR.02); it
 * flushes with no attempt limit, since E13 owns the attempt counting there.
 * It also queues NotifyEvent reports (#538, N07.FR.04), replayed in the
 * same pass without `offline`, and critical SecurityEventNotification
 * requests (#552, A04.FR.02), replayed as built.
 *
 * OCPP 1.6: matches OCPP 1.6 §4.7 /
 * §4.8 / §4.10 + errata 3.18: "When the Central System fails to process
 * a transaction-related message, the Charge Point SHALL retry up to
 * `TransactionMessageAttempts` times at `TransactionMessageRetryInterval`
 * intervals." Queue contents persist across reboots so a power outage
 * during an active transaction doesn't lose StartTransaction.req.
 *
 * On 1.6 StartTransaction / StopTransaction / MeterValues(with
 * transactionId) and a critical SecurityEventNotification (#793) belong
 * here. Heartbeats, StatusNotifications, etc. are informational and are
 * fine to drop while offline.
 *
 * Stored through a {@link PendingMessageRepository} (#878): the SQLite
 * `pending_messages` table when the charge point has a database, nothing
 * otherwise (an in-memory queue: tests, `:memory:` daemon mode).
 */
export class PendingMessageQueue<A extends string = OCPPAction> {
  private items: PendingRow<A>[] = [];
  /** Persisted FIFO ordering key; seeded from MAX(seq) for this cp on load. */
  private nextSeq = 0;
  /** Independent counter for the user-visible message id — keeping it apart
   *  from `nextSeq` stops an id allocation from perturbing the ordering key. */
  private nextIdSuffix = 0;
  /** Rows handed to the socket whose answer is still awaited (#554). In
   *  memory only: after a restart every row is replayed. */
  private readonly delivering = new Set<string>();
  /** Actions of the persisted rows `load` deleted: not queued by this
   *  handler (#528). */
  readonly droppedOnLoad: string[] = [];
  private readonly queuedActions: ReadonlySet<string>;

  constructor(
    private readonly repository: PendingMessageRepository = new NoopPendingMessageRepository(),
    queuedActions: ReadonlySet<A>,
    private readonly clock: SimClock = realClock,
  ) {
    this.queuedActions = queuedActions;
    this.load();
  }

  /** Snapshot of the current queue (FIFO order). */
  all(): PendingMessage<A>[] {
    return this.items.map(toPendingMessage);
  }

  size(): number {
    return this.items.length;
  }

  /** Enqueue and return the row id, which {@link remove}, {@link markDelivering}
   *  and {@link release} take (#554). */
  enqueue(
    message: Omit<PendingMessage<A>, "queuedAt" | "attempts"> & {
      attempts?: number;
    },
  ): string {
    const row: PendingRow<A> = {
      ...message,
      queuedAt: this.clock.now(),
      attempts: message.attempts ?? 0,
      messageId: this.nextMessageId(),
      seq: this.nextSeq++,
    };
    this.items.push(row);
    this.insertRow(row);
    return row.messageId;
  }

  /**
   * #554: the oldest rows of `action` not delivering, `payload` accepted by
   * `where`, as row ids (oldest first). Used to pick a row to drop.
   */
  idleRows(action: A, where?: (payload: unknown) => boolean): string[] {
    return this.items
      .filter(
        (item) =>
          item.action === action &&
          !this.delivering.has(item.messageId) &&
          (where === undefined || where(item.payload)),
      )
      .map((item) => item.messageId);
  }

  /** #554: the payload of the row `messageId`, if queued. */
  payloadOfRow(messageId: string): unknown {
    return this.items.find((item) => item.messageId === messageId)?.payload;
  }

  /** Queued payloads of `action`, delivering ones included (#554). */
  payloadsOf(action: A): unknown[] {
    return this.items
      .filter((item) => item.action === action)
      .map((item) => item.payload);
  }

  /** Remove the row `messageId`, wherever it stands. Returns whether it was
   *  there (#554). */
  remove(messageId: string): boolean {
    const index = this.items.findIndex((item) => item.messageId === messageId);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.delivering.delete(messageId);
    this.deleteRow(messageId);
    return true;
  }

  /** The row was handed to the socket and awaits the CSMS's answer: it stays
   *  in the table (and so survives a crash) but a replay pass skips it. */
  markDelivering(messageId: string): void {
    if (this.items.some((item) => item.messageId === messageId)) {
      this.delivering.add(messageId);
    }
  }

  /** The delivery of the row ended without an answer (a close): it waits for
   *  the next replay in its place. Returns whether the row exists. */
  release(messageId: string): boolean {
    this.delivering.delete(messageId);
    return this.items.some((item) => item.messageId === messageId);
  }

  /**
   * #554: replay pass that keeps the rows. `send` gets each queued message
   * that is not delivering, in order, with its row id; it returns whether the
   * send went through (the row stays and is marked delivering, or `send`
   * removes it itself) or was refused (the pass stops, the row stays
   * idle). Returns the count sent.
   */
  replay(send: (message: PendingMessage<A>, rowId: string) => boolean): number {
    let sent = 0;
    for (const row of [...this.items]) {
      if (this.delivering.has(row.messageId)) continue;
      if (!this.items.includes(row)) continue;
      if (!send(toPendingMessage(row), row.messageId)) break;
      sent += 1;
    }
    return sent;
  }

  /** How many queued messages carry `action`. */
  countOf(action: A): number {
    let count = 0;
    for (const item of this.items) if (item.action === action) count++;
    return count;
  }

  /**
   * Remove the oldest queued message carrying `action` (and whose payload
   * `where` accepts, when given) and persist; the other actions are never
   * touched. Returns whether one was removed.
   */
  removeOldest(action: A, where?: (payload: unknown) => boolean): boolean {
    const index = this.items.findIndex(
      (item) =>
        item.action === action && (where === undefined || where(item.payload)),
    );
    if (index < 0) return false;
    const [row] = this.items.splice(index, 1);
    this.deleteRow(row.messageId);
    return true;
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
    this.delivering.clear();
    this.repository.clear();
  }

  // ── persistence helpers ────────────────────────────────────────────────

  private load(): void {
    try {
      // Nothing stored (no database): both counters start at their floor.
      const rows = this.repository.loadAll();
      this.items = [];
      for (const r of rows) {
        const action = r.action;
        if (!this.isQueued(action)) {
          this.droppedOnLoad.push(action);
          this.deleteRow(r.messageId);
          continue;
        }
        this.items.push({
          messageId: r.messageId,
          action,
          payload: safeParse(r.payload),
          connectorId: r.connectorId ?? undefined,
          queuedAt: Date.parse(r.createdAt) || this.clock.now(),
          attempts: r.attempts,
          seq: r.seq ?? 0,
        });
      }
      // Initialize seq counter to 1 + MAX(seq) to avoid collisions.
      const maxSeq = rows.reduce((max, r) => Math.max(max, r.seq ?? 0), 0);
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

  private isQueued(action: string): action is A {
    return this.queuedActions.has(action);
  }

  private insertRow(row: PendingRow<A>): void {
    try {
      this.repository.insert({
        messageId: row.messageId,
        action: row.action,
        connectorId: row.connectorId ?? null,
        payload: JSON.stringify(row.payload),
        attempts: row.attempts,
        createdAt: new Date(row.queuedAt).toISOString(),
        seq: row.seq,
      });
    } catch (err) {
      console.error("Failed to enqueue pending message:", err);
    }
  }

  private deleteRow(messageId: string): void {
    try {
      this.repository.delete(messageId);
    } catch (err) {
      console.error("Failed to delete pending message:", err);
    }
  }

  private updateAttempts(messageId: string, attempts: number): void {
    try {
      this.repository.updateAttempts(messageId, attempts);
    } catch (err) {
      console.error("Failed to update pending message attempts:", err);
    }
  }

  private nextMessageId(): string {
    // Per-instance monotonic id; mixed with the wall-clock so concurrent
    // queues for different cps don't collide (cp_id is part of the PK
    // anyway, but the id is also user-visible in logs).
    const suffix = (this.nextIdSuffix += 1);
    return `${this.clock.now().toString(36)}-${suffix.toString(36)}`;
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
