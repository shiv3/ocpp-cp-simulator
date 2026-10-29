const DAY_MS = 86_400_000;

/**
 * The first clock-aligned boundary strictly after `nowMs` (#454).
 *
 * OCPP 1.6 `ClockAlignedDataInterval` and 2.x `AlignedDataCtrlr.Interval`
 * split every day into evenly spaced intervals "starting at 00:00:00
 * (midnight)", so the grid restarts each midnight: with an interval that
 * does not divide a day, the day's last slot is shorter and the next
 * midnight is itself a boundary. Midnight is UTC so the grid does not depend
 * on the host's time zone.
 */
export function nextClockAlignedBoundary(
  nowMs: number,
  intervalSeconds: number,
): number {
  const intervalMs = intervalSeconds * 1000;
  const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const next =
    midnight + (Math.floor((nowMs - midnight) / intervalMs) + 1) * intervalMs;
  return Math.min(next, midnight + DAY_MS);
}

/**
 * Charge-point-level clock-aligned metering timer (#454). Independent of the
 * per-connector `MeterValueScheduler`: it never advances a register, it only
 * says "a boundary was reached" and which one.
 *
 * The interval is configuration and is kept while the scheduler is
 * disabled; the timer only runs between `enable()` and `disable()`.
 *
 * Each fire reports the boundary the timer was armed for, never one derived
 * from the clock at fire time, so a timer that runs a little early or late
 * still stamps the right instant. Arming never targets a boundary at or
 * before the last one reported, so a reconnect or a reconfiguration landing
 * on a boundary that was already reported does not report it again.
 */
export class ClockAlignedMeterScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private intervalSeconds = 0;
  private enabled = false;
  private lastEmittedBoundary = Number.NEGATIVE_INFINITY;

  constructor(private readonly onBoundary: (boundaryMs: number) => void) {}

  /** Change the interval; `0` disables. Takes effect at once if enabled. */
  setIntervalSeconds(intervalSeconds: number): void {
    this.intervalSeconds = intervalSeconds;
    if (this.enabled) this.rearm();
  }

  enable(): void {
    this.enabled = true;
    this.rearm();
  }

  disable(): void {
    this.enabled = false;
    this.clearTimer();
  }

  private rearm(): void {
    this.clearTimer();
    if (this.intervalSeconds > 0) {
      this.arm(Math.max(Date.now(), this.lastEmittedBoundary));
    }
  }

  /** Arm on the first boundary strictly after `afterMs`. */
  private arm(afterMs: number): void {
    const boundary = nextClockAlignedBoundary(afterMs, this.intervalSeconds);
    this.timer = setTimeout(
      () => this.fire(boundary),
      Math.max(0, boundary - Date.now()),
    );
  }

  private fire(boundary: number): void {
    this.timer = null;
    this.lastEmittedBoundary = boundary;
    this.onBoundary(boundary);
    // `onBoundary` may have disabled or re-armed the scheduler. Otherwise an
    // early fire must not re-arm on the boundary it just reported, and a
    // late one must not replay the boundaries it slept through.
    if (this.timer !== null || !this.enabled) return;
    this.arm(Math.max(Date.now(), boundary));
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
