import type { OCPPAction } from "../types/OcppTypes";

/**
 * One queued transaction-related CALL waiting to be (re)delivered. Stored
 * verbatim — the payload is `unknown` because each action has its own
 * generated request type.
 */
export interface PendingMessage {
  /** Action name (StartTransaction / StopTransaction / MeterValues). */
  action: OCPPAction;
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
 * Persistent queue of transaction-related messages that failed to deliver
 * (typically because the WebSocket was offline). Matches OCPP 1.6 §4.7 /
 * §4.8 / §4.10 + errata 3.18: "When the Central System fails to process
 * a transaction-related message, the Charge Point SHALL retry up to
 * `TransactionMessageAttempts` times at `TransactionMessageRetryInterval`
 * intervals." Queue contents persist across reboots so a power outage
 * during an active transaction doesn't lose StartTransaction.req.
 *
 * Only StartTransaction / StopTransaction / MeterValues(with
 * transactionId) belong here. Heartbeats, StatusNotifications, etc. are
 * informational and are fine to drop while offline.
 */
export class PendingMessageQueue {
  private readonly storageKey: string;
  private items: PendingMessage[] = [];

  constructor(chargePointId: string) {
    this.storageKey = `pending_transaction_messages_${chargePointId}`;
    this.load();
  }

  /** Snapshot of the current queue (FIFO order). */
  all(): PendingMessage[] {
    return [...this.items];
  }

  size(): number {
    return this.items.length;
  }

  enqueue(message: Omit<PendingMessage, "queuedAt" | "attempts">): void {
    this.items.push({
      ...message,
      queuedAt: Date.now(),
      attempts: 0,
    });
    this.persist();
  }

  /** Remove the head and persist. Returns the dequeued message or undefined. */
  dequeue(): PendingMessage | undefined {
    const item = this.items.shift();
    if (item) this.persist();
    return item;
  }

  /**
   * Pop entries from the front while `accept` consumes them. The callback
   * returns whether the send succeeded (true → discard, false → put back
   * at front with attempts++). Stops as soon as one entry fails to send
   * so retries respect order. Returns the count delivered.
   */
  flush(
    send: (message: PendingMessage) => boolean,
    maxAttempts: number,
  ): number {
    let delivered = 0;
    while (this.items.length > 0) {
      const head = this.items[0];
      const ok = send(head);
      if (!ok) {
        head.attempts += 1;
        if (head.attempts >= maxAttempts) {
          this.items.shift();
          delivered += 0;
          continue;
        }
        // Could not send (still offline?). Stop flushing; leave the
        // queue intact for the next attempt.
        break;
      }
      this.items.shift();
      delivered += 1;
    }
    this.persist();
    return delivered;
  }

  clear(): void {
    this.items = [];
    this.persist();
  }

  private load(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PendingMessage[];
      if (Array.isArray(parsed)) {
        this.items = parsed.filter(
          (m): m is PendingMessage =>
            m !== null &&
            typeof m === "object" &&
            typeof (m as PendingMessage).action === "string" &&
            typeof (m as PendingMessage).queuedAt === "number",
        );
      }
    } catch (err) {
      console.error("Failed to load pending transaction queue:", err);
    }
  }

  private persist(): void {
    if (typeof localStorage === "undefined") return;
    try {
      if (this.items.length === 0) {
        localStorage.removeItem(this.storageKey);
      } else {
        localStorage.setItem(this.storageKey, JSON.stringify(this.items));
      }
    } catch (err) {
      console.error("Failed to persist pending transaction queue:", err);
    }
  }
}
