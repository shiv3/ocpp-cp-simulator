import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import type { StoredLogEntry } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import { LogLevel } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import { redactSensitiveText } from "@ocpp-cp-simulator/core/cp/shared/redaction";
import type { CPRegistry } from "./CPRegistry";

export async function listStoredLogs(
  registry: CPRegistry,
  database: Database | null,
  cpId: string,
): Promise<StoredLogEntry[]> {
  const service = registry.get(cpId);
  service?.flushLogs();

  let entries: StoredLogEntry[] = [];
  if (database) {
    const rows = database.all<{
      timestamp: string;
      level: string;
      log_type: string;
      message: string;
    }>(
      "SELECT timestamp, level, log_type, message FROM logs " +
        "WHERE cp_id = ? ORDER BY id ASC",
      [cpId],
    );
    entries = rows.map((row) => ({
      timestamp: row.timestamp,
      level: row.level,
      type: row.log_type,
      cpId,
      message: redactSensitiveText(row.message),
    }));
  }

  if (entries.length > 0) return entries;
  return (service?.getInMemoryLogs() ?? []).map((entry) => ({
    timestamp: entry.timestamp.toISOString(),
    level: LogLevel[entry.level] ?? "INFO",
    type: entry.type,
    cpId,
    message: redactSensitiveText(entry.message),
  }));
}
