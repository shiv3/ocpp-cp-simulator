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

export interface ClockAlignedMeterSchedulerOptions {
  /** Called once per boundary with the boundary instant (epoch ms). */
  onBoundary: (boundaryMs: number) => void;
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Charge-point-level clock-aligned metering timer (#454). Independent of the
 * per-connector `MeterValueScheduler`: it never advances a register, it only
 * says "a boundary was reached" and which one.
 *
 * Each fire reports the boundary the timer was armed for, never one derived
 * from the clock at fire time, so a timer that runs a little early or late
 * still stamps the right instant. The last reported boundary survives
 * `stop()`, so a reconnect or a reconfiguration landing on a boundary that
 * was already reported does not report it again.
 */
export class ClockAlignedMeterScheduler {
  private readonly onBoundary: (boundaryMs: number) => void;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<
    ClockAlignedMeterSchedulerOptions["setTimer"]
  >;
  private readonly clearTimer: NonNullable<
    ClockAlignedMeterSchedulerOptions["clearTimer"]
  >;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _intervalSeconds = 0;
  private lastEmittedBoundary = Number.NEGATIVE_INFINITY;

  constructor(options: ClockAlignedMeterSchedulerOptions) {
    this.onBoundary = options.onBoundary;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /** Interval in force; `0` while stopped or disabled. */
  get intervalSeconds(): number {
    return this._intervalSeconds;
  }

  /** (Re)start on the grid of `intervalSeconds`; `0` disables. */
  start(intervalSeconds: number): void {
    this.stop();
    const interval = Math.floor(intervalSeconds);
    if (!(interval > 0)) return;
    this._intervalSeconds = interval;
    this.arm(nextClockAlignedBoundary(this.now(), interval));
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this._intervalSeconds = 0;
  }

  private arm(boundary: number): void {
    this.timer = this.setTimer(
      () => this.fire(boundary),
      Math.max(0, boundary - this.now()),
    );
  }

  private fire(boundary: number): void {
    this.timer = null;
    if (boundary > this.lastEmittedBoundary) {
      this.lastEmittedBoundary = boundary;
      this.onBoundary(boundary);
    }
    // `onBoundary` may have stopped or restarted the scheduler.
    if (this.timer !== null || this._intervalSeconds === 0) return;
    // An early fire must not re-arm on the boundary it just reported, and a
    // late one must not replay the boundaries it slept through.
    this.arm(
      nextClockAlignedBoundary(
        Math.max(this.now(), boundary),
        this._intervalSeconds,
      ),
    );
  }
}
