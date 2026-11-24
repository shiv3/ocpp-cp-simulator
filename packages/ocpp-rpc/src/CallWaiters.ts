import { platformClock, type RpcClock } from "./platformClock";

/**
 * Callers waiting for the answer to one CALL, keyed by message id (#348
 * DataTransfer, #389 expert calls, moved here for #978). Each waiter settles
 * exactly once — answer, CALLERROR, drop, close — and rejects on its own timer
 * if nothing else settles it first.
 */
export class CallWaiters<T> {
  private readonly _waiters = new Map<
    string,
    {
      resolve: (value: T) => void;
      reject: (error: Error) => void;
      timer: unknown;
      /** The clock that armed `timer`, the only one that can clear it. */
      clock: RpcClock;
    }
  >();

  constructor(
    private readonly _timeoutMs: number,
    private readonly _timeoutError: (id: string) => Error,
    /** The clock the timeout runs on, read when a waiter is registered; the
     *  waiter keeps that clock to clear its timer. */
    private readonly _clock: () => RpcClock = () => platformClock,
  ) {}

  register(id: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const clock = this._clock();
      const timer = clock.setTimeout(() => {
        this._waiters.delete(id);
        reject(this._timeoutError(id));
      }, this._timeoutMs);
      this._waiters.set(id, { resolve, reject, timer, clock });
    });
  }

  /** True while a waiter is registered under `id`. */
  has(id: string): boolean {
    return this._waiters.has(id);
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
    waiter.clock.clearTimeout(waiter.timer);
    return waiter;
  }
}
