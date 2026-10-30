import { setTimeoutAt } from "../../shared/timers";
import { nextClockAlignedBoundary } from "../charge-point/ClockAlignedMeterScheduler";
import type { VariableMonitor } from "./VariableMonitor";

const DAY_SECONDS = 86_400;

/**
 * The timers behind Periodic and PeriodicClockAligned monitors (N08, #538),
 * one per monitor id. Each fire calls `onTick` with the monitor id.
 *
 * - `Periodic` fires every `value` seconds from the time it is armed
 *   (N08.FR.06).
 * - `PeriodicClockAligned` fires on the clock-aligned grid of `value`
 *   seconds (N08.FR.07), the grid `AlignedDataCtrlr.Interval` uses (#454):
 *   it restarts at each UTC midnight. Above a day that grid would fire at
 *   every midnight, before `value` seconds have passed, so the grid is the
 *   one of `value` seconds counted from the Unix epoch (a UTC midnight):
 *   a whole number of days fires at midnight, and a re-arm keeps the grid.
 *
 * A late timer never replays the boundaries it slept through, and a wait
 * beyond setTimeout's limit is chained instead of firing at once.
 */
export class PeriodicMonitorScheduler {
  /** The cancel function of each monitor's pending timer. */
  private readonly timers = new Map<number, () => void>();

  constructor(private readonly onTick: (monitorId: number) => void) {}

  /** (Re)start the timer of a periodic monitor, from now. */
  arm(monitor: Pick<VariableMonitor, "id" | "type" | "value">): void {
    this.disarm(monitor.id);
    this.schedule(monitor, this.nextFire(monitor, Date.now()));
  }

  disarm(monitorId: number): void {
    const cancel = this.timers.get(monitorId);
    if (cancel === undefined) return;
    cancel();
    this.timers.delete(monitorId);
  }

  disarmAll(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  private schedule(
    monitor: Pick<VariableMonitor, "id" | "type" | "value">,
    fireAt: number,
  ): void {
    this.timers.set(
      monitor.id,
      setTimeoutAt(fireAt, () => {
        this.schedule(
          monitor,
          this.nextFire(monitor, Math.max(Date.now(), fireAt)),
        );
        this.onTick(monitor.id);
      }),
    );
  }

  /** The first fire strictly after `afterMs`. */
  private nextFire(
    monitor: Pick<VariableMonitor, "type" | "value">,
    afterMs: number,
  ): number {
    if (monitor.type === "PeriodicClockAligned") {
      if (monitor.value <= DAY_SECONDS) {
        return nextClockAlignedBoundary(afterMs, monitor.value);
      }
      const periodMs = monitor.value * 1000;
      return (Math.floor(afterMs / periodMs) + 1) * periodMs;
    }
    return afterMs + monitor.value * 1000;
  }
}
