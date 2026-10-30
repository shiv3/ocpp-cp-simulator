import type { Database, SqlParam } from "../persistence/Database";
import { parseMonitoringBase, type MonitoringBase } from "./MonitoringStore";
import type { VariableMonitor } from "./VariableMonitor";

/**
 * The row holding the charge point's monitoring base (#538). Monitor ids
 * start at 1, so id 0 is free; an older simulator skips the row, whose JSON
 * is not a monitor.
 */
const BASE_ROW_ID = 0;

export interface PersistedMonitor {
  readonly monitor: VariableMonitor;
  /** Threshold monitors: the value was beyond the threshold (N07.FR.14). */
  readonly triggered: boolean;
}

/**
 * Installed variable monitors of one charge point in the
 * `variable_monitors` table, so they survive a restart (N07.FR.13). The
 * monitor is stored as JSON, like the other domain DTO columns. The row
 * with id 0 holds the monitoring base last set (#538), which also tells a
 * station whose preconfigured monitors were deleted from one that never
 * stored them. Without a {@link Database} every call is a no-op.
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
          "WHERE cp_id = ? AND monitor_id <> ? ORDER BY monitor_id ASC",
        [this.chargePointId, BASE_ROW_ID],
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

  /** The monitoring base last stored; `undefined` when none (or unreadable). */
  loadActiveBase(): MonitoringBase | undefined {
    if (!this.database) return undefined;
    try {
      const row = this.database.get<{ monitor: string }>(
        "SELECT monitor FROM variable_monitors WHERE cp_id = ? AND monitor_id = ?",
        [this.chargePointId, BASE_ROW_ID],
      );
      if (!row) return undefined;
      const value = JSON.parse(row.monitor) as {
        activeMonitoringBase?: unknown;
      } | null;
      const raw = value?.activeMonitoringBase;
      return (typeof raw === "string" && parseMonitoringBase(raw)) || undefined;
    } catch (err) {
      console.error("Failed to load the monitoring base:", err);
      return undefined;
    }
  }

  saveActiveBase(base: MonitoringBase): void {
    this.run(
      "INSERT INTO variable_monitors (cp_id, monitor_id, monitor, triggered) " +
        "VALUES (?, ?, ?, 0) " +
        "ON CONFLICT (cp_id, monitor_id) DO UPDATE SET monitor = excluded.monitor",
      [
        this.chargePointId,
        BASE_ROW_ID,
        JSON.stringify({ activeMonitoringBase: base }),
      ],
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
