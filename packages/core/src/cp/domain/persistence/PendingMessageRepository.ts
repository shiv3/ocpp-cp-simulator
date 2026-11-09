/**
 * One stored pending message, as `PendingMessageQueue` persists it: the
 * payload JSON-encoded, the enqueue instant as an ISO string. `seq` is
 * `null` on rows written before the column existed.
 */
export interface StoredPendingMessage {
  readonly messageId: string;
  readonly action: string;
  readonly connectorId: number | null;
  /** JSON-encoded request payload. */
  readonly payload: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly seq: number | null;
}

/**
 * Where one charge point's undelivered transaction-related messages are kept
 * (#878), so a restart replays them. Both protocol handlers' queues share it;
 * FIFO ordering, the action filter, the delivering set and the id allocation
 * stay in `PendingMessageQueue`. A failure throws.
 *
 * `SqlitePendingMessageRepository` uses the `pending_messages` table;
 * {@link NoopPendingMessageRepository} backs a charge point without a
 * database, whose queue lives in memory only.
 */
export interface PendingMessageRepository {
  /** Every stored message, by ascending `seq` then `createdAt`. */
  loadAll(): StoredPendingMessage[];
  insert(message: StoredPendingMessage): void;
  delete(messageId: string): void;
  updateAttempts(messageId: string, attempts: number): void;
  clear(): void;
}

/** A charge point without a database: nothing is stored. */
export class NoopPendingMessageRepository implements PendingMessageRepository {
  loadAll(): StoredPendingMessage[] {
    return [];
  }

  insert(_message: StoredPendingMessage): void {}

  delete(_messageId: string): void {}

  updateAttempts(_messageId: string, _attempts: number): void {}

  clear(): void {}
}
