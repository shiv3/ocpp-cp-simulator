import { realClock } from "../../shared/clock";
import type { SimClock, TimerHandle } from "../../shared/clock";

/**
 * Callers waiting for the CSMS's answer to one CP→CSMS CALL, keyed by CALL
 * id (#348 DataTransfer, #389 expert calls). Each waiter settles exactly
 * once — answer, CALLERROR, drop, close — and rejects on its own timer if
 * nothing else settles it first.
 */
export class CallWaiters<T> {
  private readonly _waiters = new Map<
    string,
    {
      resolve: (value: T) => void;
      reject: (error: Error) => void;
      timer: TimerHandle;
    }
  >();

  constructor(
    private readonly _timeoutMs: number,
    private readonly _timeoutError: (id: string) => Error,
    /** The clock the timeout runs on, read when a waiter is registered. */
    private readonly _clock: () => SimClock = () => realClock,
  ) {}

  register(id: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this._clock().setTimeout(() => {
        this._waiters.delete(id);
        reject(this._timeoutError(id));
      }, this._timeoutMs);
      this._waiters.set(id, { resolve, reject, timer });
    });
  }

  resolve(id: string, value: T): void {
    this.take(id)?.resolve(value);
  }

  reject(id: string, error: Error): void {
    this.take(id)?.reject(error);
  }

  rejectAll(errorFor: (id: string) => Error): void {
    for (const id of [...this._waiters.keys()]) this.reject(id, errorFor(id));
  }

  private take(id: string) {
    const waiter = this._waiters.get(id);
    if (!waiter) return undefined;
    this._waiters.delete(id);
    this._clock().clearTimeout(waiter.timer);
    return waiter;
  }
}
