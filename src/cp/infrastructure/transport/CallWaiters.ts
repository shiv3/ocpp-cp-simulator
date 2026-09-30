/**
 * Callers waiting for the CSMS's answer to one CP→CSMS CALL, keyed by CALL
 * id (#348 DataTransfer, #389 expert calls). Each waiter carries caller
 * metadata, settles exactly once — answer, CALLERROR, drop, close — and
 * rejects on its own timer if nothing else settles it first.
 */
export class CallWaiters<T, M = undefined> {
  private readonly _waiters = new Map<
    string,
    {
      meta: M;
      resolve: (value: T) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly _timeoutMs: number,
    private readonly _timeoutError: (id: string) => Error,
  ) {}

  register(id: string, meta: M): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        reject(this._timeoutError(id));
      }, this._timeoutMs);
      this._waiters.set(id, { meta, resolve, reject, timer });
    });
  }

  /** The metadata of the waiter on `id`, undefined when nobody waits. */
  get(id: string): M | undefined {
    return this._waiters.get(id)?.meta;
  }

  has(id: string): boolean {
    return this._waiters.has(id);
  }

  resolve(id: string, value: T): boolean {
    const waiter = this.take(id);
    waiter?.resolve(value);
    return waiter !== undefined;
  }

  reject(id: string, error: Error): boolean {
    const waiter = this.take(id);
    waiter?.reject(error);
    return waiter !== undefined;
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
