import type { Database } from "./Database";
import type { LogEntry } from "../../shared/Logger";
import { LogLevel, LogType } from "../../shared/Logger";

/**
 * Persists `LogEntry` records to the `logs` table.
 *
 * Log volume is high — every OCPP message, scenario tick and state
 * transition logs an entry. Naively committing per-entry would tank the
 * browser path (each sql.js write triggers a debounced IndexedDB flush) and
 * grow the DB without bound. To keep both paths cheap:
 *
 *   - `append()` queues into an in-memory buffer.
 *   - We flush either when the buffer hits `FLUSH_BATCH_SIZE` or after
 *     `FLUSH_INTERVAL_MS` of inactivity (whichever comes first).
 *   - After each flush we trim per-CP rows back to {@link MAX_PER_CP}
 *     so the on-disk size stays bounded.
 *
 * `database = null` (remote-mode browser) makes every method a no-op —
 * the daemon owns the durable log; the browser still gets the live event
 * stream through ChargePointService "log" events for its in-memory viewer.
 */
export class LogRepository {
  private static readonly FLUSH_BATCH_SIZE = 50;
  private static readonly FLUSH_INTERVAL_MS = 500;
  /** Retention cap. ~10 k rows × ~200 B = ~2 MB per CP; fine for IndexedDB. */
  private static readonly MAX_PER_CP = 10_000;
  /** Trim hysteresis: only sweep when a CP exceeds this multiple of MAX. */
  private static readonly TRIM_TRIGGER_RATIO = 1.1;

  private readonly buffer: Array<{ cpId: string; entry: LogEntry }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly touchedCps = new Set<string>();
  private rowsSinceLastTrim = 0;
  private closed = false;

  constructor(private readonly db: Database | null) {}

  /** Buffer a log entry; flushes implicitly when the batch threshold or
   *  the idle window fires. Safe to call frequently. */
  append(cpId: string, entry: LogEntry): void {
    if (!this.db || this.closed) return;
    this.buffer.push({ cpId, entry });
    if (this.buffer.length >= LogRepository.FLUSH_BATCH_SIZE) {
      this.flush();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(
      () => this.flush(),
      LogRepository.FLUSH_INTERVAL_MS,
    );
  }

  /** Force-write any buffered entries (e.g. on shutdown / explicit reload). */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.db || this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    for (const { cpId, entry } of batch) {
      this.db.run(
        "INSERT INTO logs (cp_id, timestamp, level, log_type, message) " +
          "VALUES (?, ?, ?, ?, ?)",
        [
          cpId,
          entry.timestamp.toISOString(),
          LogLevel[entry.level] ?? "INFO",
          entry.type,
          entry.message,
        ],
      );
      this.touchedCps.add(cpId);
    }
    this.rowsSinceLastTrim += batch.length;
    // Sweep retention occasionally — once every ~10 batches is plenty,
    // a tight loop would dominate the daemon's CPU on hot CPs.
    if (this.rowsSinceLastTrim >= LogRepository.FLUSH_BATCH_SIZE * 10) {
      this.trimRetention();
      this.rowsSinceLastTrim = 0;
    }
  }

  /** Read most-recent logs for a CP. Newest-first ordering matches the
   *  in-memory log viewer's expectation. */
  list(cpId: string, limit = 500): LogEntry[] {
    if (!this.db) return [];
    this.flush(); // make sure caller sees their own writes
    const rows = this.db.all<{
      timestamp: string;
      level: string;
      log_type: string;
      message: string;
    }>(
      "SELECT timestamp, level, log_type, message FROM logs " +
        "WHERE cp_id = ? ORDER BY id DESC LIMIT ?",
      [cpId, limit],
    );
    // Reverse so consumers can append rather than prepend.
    return rows.reverse().map((row) => ({
      timestamp: new Date(row.timestamp),
      level:
        (LogLevel[row.level as keyof typeof LogLevel] as LogLevel) ??
        LogLevel.INFO,
      type: row.log_type as LogType,
      message: row.message,
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
  }

  // Per-CP retention: keep the latest MAX_PER_CP rows, drop the rest.
  // Uses a subquery rather than NOT IN to avoid quadratic plans on
  // larger tables.
  private trimRetention(): void {
    if (!this.db) return;
    for (const cpId of this.touchedCps) {
      const row = this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM logs WHERE cp_id = ?",
        [cpId],
      );
      const count = row?.count ?? 0;
      if (
        count <=
        LogRepository.MAX_PER_CP * LogRepository.TRIM_TRIGGER_RATIO
      ) {
        continue;
      }
      this.db.run(
        "DELETE FROM logs WHERE cp_id = ? AND id NOT IN (" +
          "  SELECT id FROM logs WHERE cp_id = ? ORDER BY id DESC LIMIT ?" +
          ")",
        [cpId, cpId, LogRepository.MAX_PER_CP],
      );
    }
    this.touchedCps.clear();
  }
}
