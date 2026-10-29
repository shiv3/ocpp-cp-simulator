import type { Database, SqlParam } from "../persistence/Database";
import type { VariableMonitor } from "./VariableMonitor";

export interface PersistedMonitor {
  readonly monitor: VariableMonitor;
  /** Threshold monitors: the value was beyond the threshold (N07.FR.14). */
  readonly triggered: boolean;
}

/**
 * Installed variable monitors of one charge point in the
 * `variable_monitors` table, so they survive a restart (N07.FR.13). The
 * monitor is stored as JSON, like the other domain DTO columns. Without a
 * {@link Database} every call is a no-op.
 */
export class VariableMonitorRepository {
  constructor(
    private readonly chargePointId: string,
    private readonly database: Database | null = null,
  ) {}

  /** Persisted monitors by increasing id; unreadable rows are skipped. */
  load(): PersistedMonitor[] {
    if (!this.database) return [];
    try {
      const rows = this.database.all<{ monitor: string; triggered: number }>(
        "SELECT monitor, triggered FROM variable_monitors " +
          "WHERE cp_id = ? ORDER BY monitor_id ASC",
        [this.chargePointId],
      );
      const out: PersistedMonitor[] = [];
      for (const row of rows) {
        const monitor = parseMonitor(row.monitor);
        if (monitor) out.push({ monitor, triggered: row.triggered === 1 });
      }
      return out;
    } catch (err) {
      console.error("Failed to load variable monitors:", err);
      return [];
    }
  }

  /** Insert or replace a monitor; a replace keeps its triggered flag. */
  save(monitor: VariableMonitor): void {
    this.run(
      "INSERT INTO variable_monitors (cp_id, monitor_id, monitor, triggered) " +
        "VALUES (?, ?, ?, 0) " +
        "ON CONFLICT (cp_id, monitor_id) DO UPDATE SET monitor = excluded.monitor",
      [this.chargePointId, monitor.id, JSON.stringify(monitor)],
    );
  }

  setTriggered(id: number, triggered: boolean): void {
    this.run(
      "UPDATE variable_monitors SET triggered = ? WHERE cp_id = ? AND monitor_id = ?",
      [triggered ? 1 : 0, this.chargePointId, id],
    );
  }

  delete(id: number): void {
    this.run(
      "DELETE FROM variable_monitors WHERE cp_id = ? AND monitor_id = ?",
      [this.chargePointId, id],
    );
  }

  private run(sql: string, params: SqlParam[]): void {
    if (!this.database) return;
    try {
      this.database.run(sql, params);
    } catch (err) {
      console.error("Failed to persist variable monitor:", err);
    }
  }
}

function parseMonitor(raw: string): VariableMonitor | null {
  try {
    const value = JSON.parse(raw) as Partial<VariableMonitor> | null;
    if (
      value === null ||
      typeof value !== "object" ||
      typeof value.id !== "number" ||
      typeof value.valueKey !== "string" ||
      typeof value.component?.name !== "string" ||
      typeof value.variable?.name !== "string" ||
      (value.type !== "UpperThreshold" &&
        value.type !== "LowerThreshold" &&
        value.type !== "Delta")
    ) {
      return null;
    }
    return value as VariableMonitor;
  } catch {
    return null;
  }
}
