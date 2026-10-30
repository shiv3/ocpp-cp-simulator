import {
  evaluateMonitor,
  type MonitoredReading,
  type MonitorNotice,
  type MonitorState,
} from "./evaluateMonitor";
import type { MonitoringStore, MonitoringStoreEvent } from "./MonitoringStore";
import { isQueuedOffline } from "./monitoringCtrlrKeys";
import { PeriodicMonitorScheduler } from "./PeriodicMonitorScheduler";
import {
  isAlertMonitorType,
  isPeriodicMonitorType,
  monitorBehaviour,
  type VariableMonitor,
} from "./VariableMonitor";

/** One monitor event, ready to be reported by NotifyEvent (N07). */
export interface MonitoringEvent {
  /** Increasing per charge point, from 1, or from past the highest
   *  eventId still queued when the station starts (#538). */
  readonly eventId: number;
  readonly timestamp: Date;
  /** The monitor that fired (N07.FR.06). */
  readonly monitor: VariableMonitor;
  readonly trigger: MonitorNotice["trigger"];
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
   * reporting, one periodic tick), by increasing monitor id. Never called
   * with an empty list and never while reporting is off.
   */
  emit(events: readonly MonitoringEvent[]): void;
  /**
   * Called instead of `emit` while the station is offline, with the events
   * to queue for delivery once back online (N07.FR.04, N08.FR.03, #538).
   * Without it nothing is queued.
   */
  queue?(events: readonly MonitoringEvent[]): void;
  /** `MonitoringCtrlr.OfflineQueuingSeverity`, read at each evaluation;
   *  `undefined` (unset) queues nothing. */
  offlineQueuingSeverity?(): number | undefined;
  /** Whether a transaction is running on the charge point. */
  transactionActive(): boolean;
  /**
   * The id of the transaction an event of `monitor` is linked to, read when
   * the event is created; `undefined` leaves the event unlinked (#538).
   */
  transactionIdOf?(monitor: VariableMonitor): string | undefined;
  /**
   * The highest eventId of the events still queued from a previous run,
   * read once at construction: the new events are numbered past it (#538).
   */
  lastQueuedEventId?(): number;
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
 *
 * Periodic and PeriodicClockAligned monitors (N08, #538) ignore value
 * changes: their timers run while reporting is on, each tick reporting the
 * current value with trigger `Periodic` (N08.FR.05).
 *
 * Offline (#538, N07.FR.04, N08.FR.03): a monitor whose severity is at or
 * below `OfflineQueuingSeverity` is evaluated as if online and its events
 * go to `queue`; a queued event counts as told. The other monitors are
 * held as while reporting is off, and reported by the re-check once
 * reporting resumes (the "delayed evaluation" of the N07 Remark). The
 * periodic timers keep running offline.
 */
export class MonitorEvaluation {
  private readonly states = new Map<number, MonitorState>();
  private readonly periodic: PeriodicMonitorScheduler;
  private nextEventId: number;
  /** `on`: reporting; `held`: boot not Accepted while connected (B02.FR.02);
   *  `offline`: no connection or no boot yet; `disposed`: terminal. */
  private mode: "on" | "held" | "offline" | "disposed" = "on";

  /**
   * @param restoredTriggered triggered flags of monitors restored from
   *   persistence (N07.FR.14). Restoring is silent: no event is emitted.
   */
  constructor(
    private readonly deps: MonitorEvaluationDeps,
    restoredTriggered: ReadonlyMap<number, boolean> = new Map(),
  ) {
    this.nextEventId = (deps.lastQueuedEventId?.() ?? 0) + 1;
    this.periodic = new PeriodicMonitorScheduler((id) => this.periodicTick(id));
    for (const monitor of deps.store.list()) {
      if (isPeriodicMonitorType(monitor.type)) {
        this.periodic.arm(monitor);
        continue;
      }
      const reading = deps.read(monitor.valueKey);
      if (reading === undefined) continue;
      this.states.set(monitor.id, {
        triggered:
          isAlertMonitorType(monitor.type) &&
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
      if (isPeriodicMonitorType(monitor.type)) continue;
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
   *
   * The periodic monitors' timers stop with reporting and restart from
   * scratch with it: a Periodic monitor's next tick is a full interval
   * after reporting resumes. Coming back from offline, where they kept
   * running (N08.FR.03), they keep their period.
   */
  setReporting(enabled: boolean): void {
    const next = enabled ? "on" : "held";
    if (this.mode === "disposed" || this.mode === next) return;
    const timersRan = this.timersRun();
    this.mode = next;
    if (!enabled) {
      this.periodic.disarmAll();
      return;
    }
    const events: MonitoringEvent[] = [];
    for (const monitor of this.deps.store.list()) {
      if (isPeriodicMonitorType(monitor.type)) {
        if (!timersRan) this.periodic.arm(monitor);
        continue;
      }
      if (!isAlertMonitorType(monitor.type)) continue;
      const event = this.step(monitor, this.states.get(monitor.id));
      if (event) events.push(event);
    }
    this.flush(events);
  }

  /**
   * The station is offline: no connection, or connected without a boot
   * answer yet (#538). Events of the monitors at or below
   * `OfflineQueuingSeverity` go to `queue` (N07.FR.04); the others are held
   * as while reporting is off. The periodic timers run (N08.FR.03).
   */
  setOffline(): void {
    if (this.mode === "disposed" || this.mode === "offline") return;
    const timersRan = this.timersRun();
    this.mode = "offline";
    if (timersRan) return;
    for (const monitor of this.deps.store.list()) {
      if (isPeriodicMonitorType(monitor.type)) this.periodic.arm(monitor);
    }
  }

  /** Terminal: stop every timer; later mode changes are ignored. */
  dispose(): void {
    this.mode = "disposed";
    this.periodic.disarmAll();
  }

  /** Whether {@link dispose} ran: an event still in flight is dropped. */
  get disposed(): boolean {
    return this.mode === "disposed";
  }

  /** N08.FR.05-FR.07: report the current value of a periodic monitor;
   *  offline, queue it when its severity allows (N08.FR.03). */
  private periodicTick(id: number): void {
    const monitor = this.deps.store.get(id);
    if (monitor === undefined || !isPeriodicMonitorType(monitor.type)) return;
    const reading = this.deps.read(monitor.valueKey);
    if (reading === undefined || !this.sendable(monitor)) return;
    this.flush([
      this.event(monitor, { trigger: "Periodic", cleared: false }, reading),
    ]);
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
          isAlertMonitorType(monitor.type);
        if (isPeriodicMonitorType(monitor.type)) {
          if (this.timersRun()) this.periodic.arm(monitor);
        } else if (replaced !== undefined) {
          this.periodic.disarm(monitor.id);
        }
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
        this.periodic.disarm(event.monitor.id);
        return;
      case "levelChanged":
      case "baseChanged":
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
    if (monitorBehaviour(monitor.type) === "delta") {
      // N07.FR.18: the step counts from the last notice sent.
      if (notice !== undefined && !sent && previous) next = previous;
    } else if (isAlertMonitorType(monitor.type) && !this.live(monitor)) {
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
    if (events.length === 0) return;
    if (this.mode === "offline") this.deps.queue?.(events);
    else this.deps.emit(events);
  }

  private timersRun(): boolean {
    return this.mode === "on" || this.mode === "offline";
  }

  /** Whether the monitor's events are reported now: sent, or queued while
   *  offline (N07.FR.04). A queued event counts as told. */
  private live(monitor: VariableMonitor): boolean {
    switch (this.mode) {
      case "on":
        return true;
      case "offline":
        return (
          this.deps.queue !== undefined &&
          isQueuedOffline(
            monitor.severity,
            this.deps.offlineQueuingSeverity?.(),
          )
        );
      default:
        return false;
    }
  }

  private sendable(monitor: VariableMonitor): boolean {
    if (!this.live(monitor)) return false;
    if (monitor.severity > this.deps.store.monitoringLevel) return false;
    return !monitor.transaction || this.deps.transactionActive();
  }
}
