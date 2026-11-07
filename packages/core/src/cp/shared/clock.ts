/**
 * The simulated charger's view of time (docs/analyses/charger-engine.md).
 *
 * Everything under `domain/` and `application/` reads the time and arms its
 * timers through a {@link SimClock}, so one switch decides whether a run uses
 * the platform clock ({@link RealClock}, the default, behaviour unchanged) or
 * a {@link VirtualClock} that only moves when it is told to.
 */

declare const timerBrand: unique symbol;

/**
 * Opaque handle of a pending timer. What it is depends on the clock: the
 * platform's own timer object for {@link RealClock}, a record of the queue for
 * {@link VirtualClock}. Hand it back to the clock that issued it, nothing else.
 */
export interface TimerHandle {
  readonly [timerBrand]: true;
}

export interface SimClock {
  /** Epoch milliseconds. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/**
 * The platform clock. It reads `Date`, `setTimeout` and `setInterval` from the
 * global object at call time, not at load time, so a test that fakes the
 * globals (vitest fake timers) still steers a charge point that uses it.
 */
export class RealClock implements SimClock {
  now(): number {
    // Read through the Date constructor, as the code that now calls this did
    // with `new Date()`: a test that stubs the global Date steers it too.
    return new Date().getTime();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return globalThis.setTimeout(fn, ms) as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    globalThis.clearTimeout(handle as unknown as number);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    return globalThis.setInterval(fn, ms) as unknown as TimerHandle;
  }

  clearInterval(handle: TimerHandle): void {
    globalThis.clearInterval(handle as unknown as number);
  }
}

/** The shared platform clock; the default of everything that takes a clock. */
export const realClock: SimClock = new RealClock();

/**
 * The clock of something that carries one (a charge point), or the platform
 * clock for a stand-in that carries none, such as a partial test double.
 */
export function clockOf(owner: { readonly clock?: SimClock }): SimClock {
  return owner.clock ?? realClock;
}

/**
 * Let the process exit while `handle` is pending (Node / Bun). Browser timers
 * are plain numbers and a virtual timer is no timer at all: both have nothing
 * to unref.
 */
export function unrefTimerHandle(handle: TimerHandle): void {
  (handle as unknown as { unref?: () => void }).unref?.();
}

// A macrotask hop is the only way to be sure every promise continuation that is
// already queued has run, whatever its depth. It is read once, before anything
// can fake the global timers.
const nativeSetImmediate: ((fn: () => void) => unknown) | undefined = (
  globalThis as { setImmediate?: (fn: () => void) => unknown }
).setImmediate;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

/** Resolves after every microtask queued so far, and the ones they queue, ran. */
export function drainMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (nativeSetImmediate) nativeSetImmediate(resolve);
    else nativeSetTimeout(resolve, 0);
  });
}

interface VirtualTimer {
  time: number;
  readonly owner: string;
  seq: number;
  readonly fn: () => void;
  /** Present for an interval. */
  readonly period?: number;
  cancelled: boolean;
}

function earlier(a: VirtualTimer, b: VirtualTimer): boolean {
  if (a.time !== b.time) return a.time < b.time;
  if (a.owner !== b.owner) return a.owner < b.owner;
  return a.seq < b.seq;
}

export interface VirtualClockOptions {
  /** Epoch ms the clock starts at. Default 2030-01-01T00:00:00Z. */
  readonly start?: number;
}

export interface RunUntilIdleOptions {
  /**
   * Upper bound on the timers fired. A periodic timer never lets the queue
   * run dry, so a run that never goes idle ends with an error instead of
   * spinning. Default 10 000 000.
   */
  readonly maxTimers?: number;
}

/**
 * A clock that moves only when asked. Timers wait in one queue ordered by
 * (time, owner id, sequence), so the order of two timers due at the same
 * instant is fixed by who armed them and when, never by the platform.
 *
 * Between two timers the advance methods wait for a macrotask hop, so every
 * promise continuation a timer set off has settled before time moves on: an
 * async behaviour that `await`s a sleep resumes, runs to its next sleep, and
 * only then does the next timer fire. This holds for code that waits on
 * timers and promises of this process; it says nothing of real I/O, which a
 * virtual-time run keeps out (an in-process fake CSMS, a trace replay).
 *
 * The clock itself is the root `SimClock` (owner `""`). {@link scoped} gives a
 * view whose timers belong to one charger, which is what the tie-break uses.
 */
export class VirtualClock implements SimClock {
  private current: number;
  private seq = 0;
  private readonly heap: VirtualTimer[] = [];
  private live = 0;
  private firedCount = 0;

  constructor(options: VirtualClockOptions = {}) {
    this.current = options.start ?? Date.UTC(2030, 0, 1);
  }

  now(): number {
    return this.current;
  }

  /** Timers that are armed and not cancelled. */
  get pending(): number {
    return this.live;
  }

  /** Timers fired since the clock was made. */
  get fired(): number {
    return this.firedCount;
  }

  /** A view of this clock whose timers are owned by `ownerId`. */
  scoped(ownerId: string): SimClock {
    return {
      now: () => this.current,
      setTimeout: (fn, ms) => this.arm(ownerId, fn, ms, undefined),
      clearTimeout: (handle) => this.cancel(handle),
      setInterval: (fn, ms) => this.arm(ownerId, fn, ms, ms),
      clearInterval: (handle) => this.cancel(handle),
    };
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.arm("", fn, ms, undefined);
  }

  clearTimeout(handle: TimerHandle): void {
    this.cancel(handle);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    return this.arm("", fn, ms, ms);
  }

  clearInterval(handle: TimerHandle): void {
    this.cancel(handle);
  }

  /** Move time forward by `ms`, firing every timer that falls due. */
  advanceBy(ms: number): Promise<void> {
    return this.advanceTo(this.current + ms);
  }

  /** Move time to `target` (never backwards), firing every timer due up to it. */
  async advanceTo(target: number): Promise<void> {
    await drainMicrotasks();
    for (;;) {
      const next = this.peek();
      if (!next || next.time > target) break;
      await this.fire(next);
    }
    if (target > this.current) this.current = target;
  }

  /** Fire timers until none is left. Throws if `maxTimers` fire first. */
  async runUntilIdle(options: RunUntilIdleOptions = {}): Promise<void> {
    const limit = options.maxTimers ?? 10_000_000;
    await drainMicrotasks();
    let count = 0;
    for (;;) {
      const next = this.peek();
      if (!next) return;
      if (++count > limit) {
        throw new Error(
          `VirtualClock.runUntilIdle: still busy after ${limit} timers (a periodic timer never lets the queue run dry)`,
        );
      }
      await this.fire(next);
    }
  }

  private async fire(timer: VirtualTimer): Promise<void> {
    this.pop();
    if (timer.time > this.current) this.current = timer.time;
    if (timer.period !== undefined) {
      // Re-armed before the callback, so the callback can clear it.
      timer.time = this.current + Math.max(1, timer.period);
      timer.seq = this.seq++;
      this.push(timer);
    } else {
      timer.cancelled = true;
      this.live--;
    }
    this.firedCount++;
    timer.fn();
    await drainMicrotasks();
  }

  private arm(
    owner: string,
    fn: () => void,
    ms: number,
    period: number | undefined,
  ): TimerHandle {
    const delay = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    const timer: VirtualTimer = {
      time: this.current + delay,
      owner,
      seq: this.seq++,
      fn,
      period,
      cancelled: false,
    };
    this.live++;
    this.push(timer);
    return timer as unknown as TimerHandle;
  }

  private cancel(handle: TimerHandle): void {
    const timer = handle as unknown as VirtualTimer | undefined;
    if (!timer || timer.cancelled) return;
    timer.cancelled = true;
    this.live--;
  }

  /** The earliest live timer, dropping cancelled ones off the top. */
  private peek(): VirtualTimer | undefined {
    while (this.heap.length > 0 && this.heap[0]!.cancelled) this.pop();
    return this.heap[0];
  }

  private push(timer: VirtualTimer): void {
    const heap = this.heap;
    heap.push(timer);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!earlier(heap[i]!, heap[parent]!)) break;
      [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
      i = parent;
    }
  }

  private pop(): VirtualTimer | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && earlier(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && earlier(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  }
}
