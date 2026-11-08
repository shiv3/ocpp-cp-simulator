/**
 * The simulated charger's view of time (docs/concepts/charger-engine.md).
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

/** The longest delay the platform timers honour; above it they fire at once. */
const MAX_PLATFORM_DELAY_MS = 2_147_483_647;

/** A timeout longer than the platform allows, armed link by link. */
class ChainedTimer {
  link: unknown;
  cancelled = false;
  private unrefd = false;

  unref(): void {
    this.unrefd = true;
    (this.link as { unref?: () => void } | undefined)?.unref?.();
  }

  get isUnrefd(): boolean {
    return this.unrefd;
  }
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
    if (!(ms > MAX_PLATFORM_DELAY_MS)) {
      return globalThis.setTimeout(fn, ms) as unknown as TimerHandle;
    }
    // The platform would fire a delay past 2^31-1 ms at once. Wait in links
    // against the deadline, so `ctx.sleep(30 days)` sleeps for 30 days.
    const deadline = this.now() + ms;
    const chain = new ChainedTimer();
    const arm = (): void => {
      const left = deadline - this.now();
      if (left <= 0) {
        fn();
        return;
      }
      chain.link = globalThis.setTimeout(
        arm,
        Math.min(left, MAX_PLATFORM_DELAY_MS),
      );
      if (chain.isUnrefd) {
        (chain.link as { unref?: () => void }).unref?.();
      }
    };
    arm();
    return chain as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    if (handle instanceof ChainedTimer) {
      handle.cancelled = true;
      globalThis.clearTimeout(handle.link as number);
      return;
    }
    globalThis.clearTimeout(handle as unknown as number);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    return globalThis.setInterval(
      fn,
      Math.min(ms, MAX_PLATFORM_DELAY_MS),
    ) as unknown as TimerHandle;
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

// Browsers have no setImmediate. `setTimeout(0)` is a macrotask hop too, but a
// browser clamps nested timers to 4 ms, which makes a virtual run crawl (25
// chargers for a virtual hour took 17 s there, 40 ms on Bun). A MessageChannel
// message is a macrotask without the clamp.
interface HopChannel {
  readonly port1: { onmessage: ((event: unknown) => void) | null };
  readonly port2: { postMessage(message: unknown): void };
}
const nativeMessageChannel = (
  globalThis as { MessageChannel?: new () => HopChannel }
).MessageChannel;
let hopQueue: Array<() => void> | undefined;
let hopChannel: HopChannel | undefined;

function hopWithMessageChannel(resolve: () => void): void {
  if (!nativeMessageChannel) {
    nativeSetTimeout(resolve, 0);
    return;
  }
  if (!hopChannel) {
    hopQueue = [];
    hopChannel = new nativeMessageChannel();
    hopChannel.port1.onmessage = () => hopQueue?.shift()?.();
  }
  hopQueue?.push(resolve);
  hopChannel.port2.postMessage(0);
}

/** Resolves after every microtask queued so far, and the ones they queue, ran. */
export function drainMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (nativeSetImmediate) nativeSetImmediate(resolve);
    else hopWithMessageChannel(resolve);
  });
}

/** Timers one instant may fire, on top of ten per pending timer, before the run is stopped. */
const ZERO_DELAY_STORM_BASE = 10_000;

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
  /** The advance in progress or last queued; the next one waits for it. */
  private chain: Promise<void> = Promise.resolve();

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

  /**
   * Move time forward by `ms`, firing every timer that falls due. Advances
   * run one after the other, in call order: two `advanceBy(100)` made at once
   * move time by 200, and one made from inside a timer callback runs after
   * the advance that fired it. `ms` must be a finite number.
   */
  advanceBy(ms: number): Promise<void> {
    return this.serially(() => this.advance(this.current + ms));
  }

  /**
   * Move time to `target` (never backwards), firing every timer due up to it.
   * `target` must be a finite number; see {@link advanceBy} for the order of
   * concurrent advances.
   */
  advanceTo(target: number): Promise<void> {
    return this.serially(() => this.advance(target));
  }

  /** Fire timers until none is left. Throws if `maxTimers` fire first. */
  runUntilIdle(options: RunUntilIdleOptions = {}): Promise<void> {
    return this.serially(() => this.drain(options));
  }

  private serially<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async advance(target: number): Promise<void> {
    if (!Number.isFinite(target)) {
      throw new RangeError(
        `VirtualClock: cannot advance to ${String(target)}; the target must be a finite number`,
      );
    }
    await drainMicrotasks();
    let atInstant = 0;
    let instant = this.current;
    for (;;) {
      const next = this.peek();
      if (!next || next.time > target) break;
      // A timer that re-arms itself with no delay never lets time move: stop
      // it instead of hanging. A fleet may legitimately put many timers on
      // one instant, so the allowance grows with the timers pending.
      if (next.time > instant) {
        instant = next.time;
        atInstant = 0;
      }
      if (++atInstant > ZERO_DELAY_STORM_BASE + 10 * this.live) {
        throw new Error(
          `VirtualClock: more than ${atInstant - 1} timers fired at one instant; a timer re-arms itself with no delay`,
        );
      }
      await this.fire(next);
    }
    if (target > this.current) this.current = target;
  }

  private async drain(options: RunUntilIdleOptions): Promise<void> {
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
    // An interval is at least 1 ms, as on the platform; a NaN period is 1 ms.
    const interval =
      period === undefined
        ? undefined
        : Number.isFinite(period)
          ? Math.max(1, period)
          : 1;
    const timer: VirtualTimer = {
      time: this.current + delay,
      owner,
      seq: this.seq++,
      fn,
      period: interval,
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
