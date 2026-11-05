import { ScenarioRunStateError } from "../../domain/errors/ScenarioRunStateError";

/** What an operator asked a parked wait to do instead of waiting on (#240). */
export type WaitSignal = "retry" | "continue";

/**
 * The deadline and operator controls of one armed trigger-wait attempt
 * (#240). The executor owns the timeout of every trigger node through this
 * object, so an operator can extend it while the wait is parked, and a
 * client reads the countdown from a single `deadlineAt` instead of
 * recomputing it from the node's configured timeout.
 *
 * `expired` rejects with `timeoutError(totalSeconds)` when the deadline
 * passes; `signal` resolves with the first retry / continue request. Both
 * are meant to be raced against the wait itself; `dispose()` must run once
 * the race settles.
 */
export class WaitControl {
  readonly expired: Promise<never>;
  readonly signal: Promise<WaitSignal>;

  private readonly startedAt = Date.now();
  private totalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rejectExpired: (error: Error) => void = () => {};
  private resolveSignal: (signal: WaitSignal) => void = () => {};
  private readonly timeoutError: (totalSeconds: number) => Error;

  constructor(
    timeoutMs: number,
    timeoutError: (totalSeconds: number) => Error,
  ) {
    this.timeoutError = timeoutError;
    this.totalMs = Math.max(0, timeoutMs);
    this.expired = new Promise<never>((_, reject) => {
      this.rejectExpired = reject;
    });
    // The losing side of a settled race must not surface as an unhandled
    // rejection.
    this.expired.catch(() => {});
    this.signal = new Promise<WaitSignal>((resolve) => {
      this.resolveSignal = resolve;
    });
    this.schedule();
  }

  /** Epoch ms when the wait times out; null when it waits forever. */
  get deadlineAt(): number | null {
    return this.totalMs > 0 ? this.startedAt + this.totalMs : null;
  }

  /** Ms left before the deadline (never negative); null without one. */
  remainingMs(now = Date.now()): number | null {
    const deadline = this.deadlineAt;
    return deadline === null ? null : Math.max(0, deadline - now);
  }

  /** Configured timeout plus every extension, in seconds. */
  get totalSeconds(): number {
    return this.totalMs / 1000;
  }

  /** Push the deadline back by `ms`. */
  extend(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new RangeError(
        "Wait extension must be a positive number of seconds",
      );
    }
    if (this.deadlineAt === null) {
      throw new ScenarioRunStateError(
        "The current wait has no timeout to extend",
      );
    }
    this.totalMs += ms;
    this.schedule();
  }

  /** Ask the parked wait to retry or continue; the first request wins. */
  request(signal: WaitSignal): void {
    this.resolveSignal(signal);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.dispose();
    const remaining = this.remainingMs();
    if (remaining === null) return;
    this.timer = setTimeout(
      () => this.rejectExpired(this.timeoutError(this.totalSeconds)),
      remaining,
    );
  }
}
