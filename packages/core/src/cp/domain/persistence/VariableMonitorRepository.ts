import type { MonitoringBase } from "../monitoring/MonitoringStore";
import type { VariableMonitor } from "../monitoring/VariableMonitor";

export interface PersistedMonitor {
  readonly monitor: VariableMonitor;
  /** Threshold monitors: the value was beyond the threshold (N07.FR.14). */
  readonly triggered: boolean;
}

/**
 * One charge point's installed variable monitors (#457), so they survive a
 * restart (N07.FR.13), and the monitoring base last set (#538), which also
 * tells a station whose preconfigured monitors were deleted from one that
 * never stored them.
 *
 * A storage failure is logged and never thrown: a read answers as if
 * nothing were stored.
 *
 * `SqliteVariableMonitorRepository` uses the `variable_monitors` table;
 * {@link NoopVariableMonitorRepository} backs a charge point without a
 * database.
 */
export interface VariableMonitorRepository {
  /** Persisted monitors by increasing id; unreadable rows are skipped. */
  load(): PersistedMonitor[];
  /** Insert or replace a monitor; a replace keeps its triggered flag. */
  save(monitor: VariableMonitor): void;
  /** The monitoring base last stored; `undefined` when none (or unreadable). */
  loadActiveBase(): MonitoringBase | undefined;
  saveActiveBase(base: MonitoringBase): void;
  setTriggered(id: number, triggered: boolean): void;
  delete(id: number): void;
}

/** A charge point without a database: every call is a no-op. */
export class NoopVariableMonitorRepository implements VariableMonitorRepository {
  load(): PersistedMonitor[] {
    return [];
  }

  save(_monitor: VariableMonitor): void {}

  loadActiveBase(): MonitoringBase | undefined {
    return undefined;
  }

  saveActiveBase(_base: MonitoringBase): void {}

  setTriggered(_id: number, _triggered: boolean): void {}

  delete(_id: number): void {}
}
