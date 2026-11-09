import type { LogEntry } from "../../shared/Logger";

/**
 * Where a charge point's log entries are persisted (#575). The default is
 * `infrastructure/persistence/LogRepository`, one per charge point.
 */
export interface LogSink {
  /** Buffer an entry; called for every log line, so it must be cheap. */
  append(cpId: string, entry: LogEntry): void;
  /** Write any buffered entries now. */
  flush(): void;
  /** Flush, then drop every later entry. */
  close(): void;
}
