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
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly _timeoutMs: number,
    private readonly _timeoutError: (id: string) => Error,
  ) {}

  register(id: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
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
    clearTimeout(waiter.timer);
    return waiter;
  }
}
