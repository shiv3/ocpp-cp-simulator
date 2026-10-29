import {
  evaluateMonitor,
  type MonitoredReading,
  type MonitorState,
} from "./evaluateMonitor";
import type { MonitoringStore, MonitoringStoreEvent } from "./MonitoringStore";
import type { VariableMonitor } from "./VariableMonitor";

/** One monitor event, ready to be reported by NotifyEvent (N07). */
export interface MonitoringEvent {
  /** Increasing per charge point, from 1. */
  readonly eventId: number;
  readonly timestamp: Date;
  /** The monitor that fired (N07.FR.06). */
  readonly monitor: VariableMonitor;
  readonly trigger: "Alerting" | "Delta";
  readonly cleared: boolean;
  /** The value as GetVariables reports it; empty when write-only. */
  readonly actualValue: string;
}

export interface MonitorEvaluationDeps {
  readonly store: MonitoringStore;
  /** The device-model value behind a configuration key, if it exists. */
  read(valueKey: string): MonitoredReading | undefined;
  /**
   * Called with the events that pass the monitoring level, once per
   * evaluation pass (one value change, one install), by increasing
   * monitor id. Never called with an empty list.
   */
  emit(events: readonly MonitoringEvent[]): void;
  /** Whether a transaction is running on the charge point. */
  transactionActive(): boolean;
  now?: () => Date;
  /** Told whenever a threshold monitor's triggered flag flips. */
  onTriggeredChange?(id: number, triggered: boolean): void;
}

/**
 * Evaluates the monitors of a {@link MonitoringStore} whenever the value
 * they watch changes (N07). The state of every monitor is updated on every
 * evaluation; the monitoring level (N05.FR.03, N07.FR.15) and the
 * transaction flag only decide whether the resulting event is emitted. A
 * filtered Delta event still moves its baseline.
 */
export class MonitorEvaluation {
  private readonly states = new Map<number, MonitorState>();
  private nextEventId = 1;

  /**
   * @param restoredTriggered triggered flags of monitors restored from
   *   persistence (N07.FR.14). Restoring is silent: no event is emitted.
   */
  constructor(
    private readonly deps: MonitorEvaluationDeps,
    restoredTriggered: ReadonlyMap<number, boolean> = new Map(),
  ) {
    for (const monitor of deps.store.list()) {
      const reading = deps.read(monitor.valueKey);
      if (reading === undefined) continue;
      this.states.set(monitor.id, {
        triggered:
          monitor.type !== "Delta" &&
          (restoredTriggered.get(monitor.id) ?? false),
        baseline: reading,
      });
    }
    deps.store.onChange((event) => this.onStore(event));
  }

  /** Re-evaluate the monitors watching `valueKey` after it changed. */
  valueChanged(valueKey: string): void {
    const events: MonitoringEvent[] = [];
    for (const monitor of this.deps.store.byValueKey(valueKey)) {
      const event = this.step(monitor, this.states.get(monitor.id));
      if (event) events.push(event);
    }
    this.flush(events);
  }

  isTriggered(id: number): boolean {
    return this.states.get(id)?.triggered ?? false;
  }

  private onStore(event: MonitoringStoreEvent): void {
    switch (event.kind) {
      case "installed": {
        const { monitor, replaced } = event;
        // N07.FR.11: a replaced threshold keeps its state and is checked
        // against the new value; anything else starts afresh.
        const keepsState =
          replaced !== undefined &&
          replaced.type === monitor.type &&
          monitor.type !== "Delta";
        const result = this.step(
          monitor,
          keepsState ? this.states.get(monitor.id) : undefined,
          this.states.get(monitor.id)?.triggered ?? false,
        );
        this.flush(result ? [result] : []);
        return;
      }
      case "cleared":
        // N07.FR.12: removing a triggered monitor sends nothing.
        this.states.delete(event.monitor.id);
        return;
      case "levelChanged":
        return;
    }
  }

  private step(
    monitor: VariableMonitor,
    previous: MonitorState | undefined,
    wasTriggered: boolean = previous?.triggered ?? false,
  ): MonitoringEvent | undefined {
    const reading = this.deps.read(monitor.valueKey);
    if (reading === undefined) return undefined;
    const { state, notice } = evaluateMonitor(monitor, previous, reading);
    this.states.set(monitor.id, state);
    if (state.triggered !== wasTriggered) {
      this.deps.onTriggeredChange?.(monitor.id, state.triggered);
    }
    if (notice === undefined || !this.reportable(monitor)) return undefined;
    return {
      eventId: this.nextEventId++,
      timestamp: this.deps.now?.() ?? new Date(),
      monitor,
      trigger: notice.trigger,
      cleared: notice.cleared,
      actualValue: reading.text,
    };
  }

  private flush(events: readonly MonitoringEvent[]): void {
    if (events.length > 0) this.deps.emit(events);
  }

  private reportable(monitor: VariableMonitor): boolean {
    if (monitor.severity > this.deps.store.monitoringLevel) return false;
    return !monitor.transaction || this.deps.transactionActive();
  }
}
