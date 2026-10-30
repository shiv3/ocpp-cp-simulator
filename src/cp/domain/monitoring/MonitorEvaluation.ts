import {
  evaluateMonitor,
  type MonitoredReading,
  type MonitorNotice,
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
  /** The transaction the event is linked to, if any (#538). */
  readonly transactionId?: string;
}

export interface MonitorEvaluationDeps {
  readonly store: MonitoringStore;
  /** The device-model value behind a configuration key, if it exists. */
  read(valueKey: string): MonitoredReading | undefined;
  /**
   * Called with the events that pass the monitoring level, once per
   * evaluation pass (one value change, one install, one resumption of
   * reporting), by increasing monitor id. Never called with an empty list
   * and never while reporting is off.
   */
  emit(events: readonly MonitoringEvent[]): void;
  /** Whether a transaction is running on the charge point. */
  transactionActive(): boolean;
  /**
   * The id of the transaction an event of `monitor` is linked to, read when
   * the event is created; `undefined` leaves the event unlinked (#538).
   */
  transactionIdOf?(monitor: VariableMonitor): string | undefined;
  now?: () => Date;
  /** Told whenever a threshold monitor's triggered flag flips. */
  onTriggeredChange?(id: number, triggered: boolean): void;
}

/**
 * Evaluates the monitors of a {@link MonitoringStore} whenever the value
 * they watch changes (N07). The monitoring level (N05.FR.03, N07.FR.15) and
 * the transaction flag only decide whether the resulting event is emitted:
 * a filtered threshold still records that it is triggered, while a
 * filtered Delta keeps its baseline, since its step is measured from the
 * last notice sent (N07.FR.18).
 *
 * While reporting is off (BootNotification not Accepted, B02.FR.02) nothing
 * is emitted and the thresholds keep the state the CSMS was last told;
 * turning it on re-checks every threshold against the current value.
 */
export class MonitorEvaluation {
  private readonly states = new Map<number, MonitorState>();
  private nextEventId = 1;
  private reporting = true;

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

  /**
   * Turn event reporting off (until the boot is Accepted, B02.FR.02) or
   * back on. Turning it on re-checks every threshold monitor against the
   * current value, so a trigger or a `cleared` the CSMS has not been told
   * about goes out now, including a restored trigger whose value returned
   * within range before the station started (N07.FR.14).
   */
  setReporting(enabled: boolean): void {
    if (enabled === this.reporting) return;
    this.reporting = enabled;
    if (!enabled) return;
    const events: MonitoringEvent[] = [];
    for (const monitor of this.deps.store.list()) {
      if (monitor.type === "Delta") continue;
      const event = this.step(monitor, this.states.get(monitor.id));
      if (event) events.push(event);
    }
    this.flush(events);
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
        const wasTriggered = this.isTriggered(monitor.id);
        const events: MonitoringEvent[] = [];
        const result = this.step(
          monitor,
          keepsState ? this.states.get(monitor.id) : undefined,
          wasTriggered,
        );
        if (result) events.push(result);
        // N07.FR.11: a triggered threshold replaced by a monitor of another
        // type that is not triggered is cleared, with the old condition.
        if (
          replaced !== undefined &&
          !keepsState &&
          wasTriggered &&
          !this.isTriggered(monitor.id)
        ) {
          const reading = this.deps.read(replaced.valueKey);
          if (reading !== undefined && this.sendable(replaced)) {
            events.push(
              this.event(
                replaced,
                { trigger: "Alerting", cleared: true },
                reading,
              ),
            );
          }
        }
        this.flush(events);
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
    const sent = notice !== undefined && this.sendable(monitor);
    let next = state;
    if (monitor.type === "Delta") {
      // N07.FR.18: the step counts from the last notice sent.
      if (notice !== undefined && !sent && previous) next = previous;
    } else if (!this.reporting) {
      // Keep what the CSMS was last told; setReporting(true) re-checks it.
      // A monitor starting afresh (new, or replacing one of another type)
      // that is exceeded owes its trigger: hold it as not triggered.
      const held =
        previous === undefined && state.triggered ? false : wasTriggered;
      next = { triggered: held, baseline: reading };
    }
    this.states.set(monitor.id, next);
    if (next.triggered !== wasTriggered) {
      this.deps.onTriggeredChange?.(monitor.id, next.triggered);
    }
    return sent ? this.event(monitor, notice, reading) : undefined;
  }

  private event(
    monitor: VariableMonitor,
    notice: MonitorNotice,
    reading: MonitoredReading,
  ): MonitoringEvent {
    const transactionId = this.deps.transactionIdOf?.(monitor);
    return {
      eventId: this.nextEventId++,
      timestamp: this.deps.now?.() ?? new Date(),
      monitor,
      trigger: notice.trigger,
      cleared: notice.cleared,
      actualValue: reading.text,
      ...(transactionId !== undefined && { transactionId }),
    };
  }

  private flush(events: readonly MonitoringEvent[]): void {
    if (events.length > 0) this.deps.emit(events);
  }

  private sendable(monitor: VariableMonitor): boolean {
    if (!this.reporting) return false;
    if (monitor.severity > this.deps.store.monitoringLevel) return false;
    return !monitor.transaction || this.deps.transactionActive();
  }
}
