import {
  deriveSeed32,
  draw,
  xoshiro128ss,
  cyrb128,
} from "@ocpp-cp-simulator/core/cp/shared/SeededRng";

/** Charge points that dial at once when `--bootstrap-concurrency` is absent. */
export const DEFAULT_BOOTSTRAP_CONCURRENCY = 8;

/** How a bootstrapped fleet is paced (#610). The defaults reproduce the pre-#610 behaviour. */
export interface BootstrapPacing {
  /** Charge points started at once (a positive integer). */
  readonly concurrency: number;
  /** Milliseconds between the scheduled start of consecutive charge points. */
  readonly startDelayMs: number;
  /** Each start is pushed back by a uniform draw in `[0, startJitterMs)`. */
  readonly startJitterMs: number;
  /** Seed of the jitter draws; the same seed gives the same schedule. */
  readonly startSeed: number;
}

export const DEFAULT_BOOTSTRAP_PACING: BootstrapPacing = {
  concurrency: DEFAULT_BOOTSTRAP_CONCURRENCY,
  startDelayMs: 0,
  startJitterMs: 0,
  startSeed: 0,
};

/**
 * Offset, in ms from the first start, at which the charge point at `index`
 * may begin to start: `index * startDelayMs` plus its jitter. The jitter of an
 * index depends only on the seed and the index, so the schedule is the same on
 * every run and does not change when the fleet grows. Concurrency still
 * applies on top: a start is never earlier than a free slot.
 */
export function startOffsetsMs(
  count: number,
  pacing: Pick<BootstrapPacing, "startDelayMs" | "startJitterMs" | "startSeed">,
): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    let jitter = 0;
    if (pacing.startJitterMs > 0) {
      const next = xoshiro128ss(
        cyrb128(`${deriveSeed32(pacing.startSeed, "bootstrap-jitter")}:${i}`),
      );
      jitter = draw(next, pacing.startJitterMs);
    }
    offsets.push(i * pacing.startDelayMs + jitter);
  }
  return offsets;
}

/**
 * Run `run` over `items` with at most `pacing.concurrency` in flight, no item
 * before its scheduled offset. Items are taken in order.
 */
export async function forEachPaced<T>(
  items: readonly T[],
  pacing: BootstrapPacing,
  run: (item: T) => Promise<void>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
): Promise<void> {
  const offsets = startOffsetsMs(items.length, pacing);
  const t0 = now();
  let next = 0;
  const workers = Array.from(
    { length: Math.min(pacing.concurrency, items.length) },
    async () => {
      for (let i = next++; i < items.length; i = next++) {
        const wait = t0 + offsets[i]! - now();
        if (wait > 0) await sleep(wait);
        await run(items[i]!);
      }
    },
  );
  await Promise.all(workers);
}
