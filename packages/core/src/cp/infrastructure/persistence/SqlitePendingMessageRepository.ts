import type { Database } from "../../domain/persistence/Database";
import type {
  PendingMessageRepository,
  StoredPendingMessage,
} from "../../domain/persistence/PendingMessageRepository";

/** One charge point's rows of the `pending_messages` table (#878). */
export class SqlitePendingMessageRepository implements PendingMessageRepository {
  constructor(
    private readonly chargePointId: string,
    private readonly database: Database,
  ) {}

  loadAll(): StoredPendingMessage[] {
    return this.database
      .all<{
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
      )
      .map((row) => ({
        messageId: row.message_id,
        action: row.action,
        connectorId: row.connector_id,
        payload: row.payload,
        attempts: row.attempts,
        createdAt: row.created_at,
        seq: row.seq,
      }));
  }

  insert(message: StoredPendingMessage): void {
    this.database.run(
      "INSERT INTO pending_messages " +
        "(cp_id, message_id, action, connector_id, payload, attempts, created_at, seq) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        this.chargePointId,
        message.messageId,
        message.action,
        message.connectorId,
        message.payload,
        message.attempts,
        message.createdAt,
        message.seq,
      ],
    );
  }

  delete(messageId: string): void {
    this.database.run(
      "DELETE FROM pending_messages WHERE cp_id = ? AND message_id = ?",
      [this.chargePointId, messageId],
    );
  }

  updateAttempts(messageId: string, attempts: number): void {
    this.database.run(
      "UPDATE pending_messages SET attempts = ? WHERE cp_id = ? AND message_id = ?",
      [attempts, this.chargePointId, messageId],
    );
  }

  clear(): void {
    this.database.run("DELETE FROM pending_messages WHERE cp_id = ?", [
      this.chargePointId,
    ]);
  }
}
