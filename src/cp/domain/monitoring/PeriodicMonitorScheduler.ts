import { nextClockAlignedBoundary } from "../charge-point/ClockAlignedMeterScheduler";
import type { VariableMonitor } from "./VariableMonitor";

/** setTimeout's longest delay; a longer wait is chained. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The timers behind Periodic and PeriodicClockAligned monitors (N08, #538),
 * one per monitor id. Each fire calls `onTick` with the monitor id.
 *
 * - `Periodic` fires every `value` seconds from the time it is armed
 *   (N08.FR.06).
 * - `PeriodicClockAligned` fires on the clock-aligned grid of `value`
 *   seconds (N08.FR.07), the grid `AlignedDataCtrlr.Interval` uses (#454):
 *   it restarts at each UTC midnight.
 *
 * A late timer never replays the boundaries it slept through, and a wait
 * beyond setTimeout's limit is chained instead of firing at once.
 */
export class PeriodicMonitorScheduler {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly onTick: (monitorId: number) => void) {}

  /** (Re)start the timer of a periodic monitor, from now. */
  arm(monitor: Pick<VariableMonitor, "id" | "type" | "value">): void {
    this.disarm(monitor.id);
    this.schedule(monitor, this.nextFire(monitor, Date.now()));
  }

  disarm(monitorId: number): void {
    const timer = this.timers.get(monitorId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(monitorId);
  }

  disarmAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(
    monitor: Pick<VariableMonitor, "id" | "type" | "value">,
    fireAt: number,
  ): void {
    const delay = Math.min(
      Math.max(0, fireAt - Date.now()),
      MAX_TIMER_DELAY_MS,
    );
    this.timers.set(
      monitor.id,
      setTimeout(() => {
        if (Date.now() < fireAt) {
          this.schedule(monitor, fireAt);
          return;
        }
        this.schedule(
          monitor,
          this.nextFire(monitor, Math.max(Date.now(), fireAt)),
        );
        this.onTick(monitor.id);
      }, delay),
    );
  }

  /** The first fire strictly after `afterMs`. */
  private nextFire(
    monitor: Pick<VariableMonitor, "type" | "value">,
    afterMs: number,
  ): number {
    if (monitor.type === "PeriodicClockAligned") {
      return nextClockAlignedBoundary(afterMs, monitor.value);
    }
    return afterMs + monitor.value * 1000;
  }
}
