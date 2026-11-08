// The fleet of the V1 determinism check (docs/concepts/charger-engine.md): N
// simulated chargers run behavior-shaped async loops on a VirtualClock and the
// ordered effects are recorded. Shared by the Bun test and by the browser
// check (scripts/verify/browser), which hashes the same effects to show that
// both engines agree. No Node or Bun API in here.
import { VirtualClock, type SimClock } from "../clock";
import { RngStreams, type Rng, type RngSource } from "../rng";

export const HOUR_MS = 3_600_000;

export interface Effects {
  /** Every effect in the order it happened, fleet-wide. */
  readonly all: string[];
  /** The same effects per charger. */
  readonly byCharger: Map<string, string[]>;
}

function record(effects: Effects, id: string, clock: SimClock, what: string) {
  const line = `${clock.now()}|${id}|${what}`;
  effects.all.push(line);
  const own = effects.byCharger.get(id) ?? [];
  own.push(line);
  effects.byCharger.set(id, own);
}

/** A sleep that is a promise on the charger's clock, like `ctx.sleep`. */
const sleep = (clock: SimClock, ms: number) =>
  new Promise<void>((resolve) => {
    clock.setTimeout(resolve, ms);
  });

/** `ctx.until(promise, { ms })`: the promise, or a timeout, whichever is first. */
async function until<T>(
  clock: SimClock,
  promise: Promise<T>,
  ms: number,
): Promise<{ timedOut: boolean; value?: T }> {
  let timer: ReturnType<SimClock["setTimeout"]> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = clock.setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}

/** A chain of awaits that does nothing but cost microtask turns. */
async function deepChain(depth: number): Promise<number> {
  if (depth === 0) return 0;
  return 1 + (await deepChain(depth - 1));
}

/**
 * Behavior-shaped: a charger that idles a random while, then runs a session
 * whose steps race against a timeout, with a periodic heartbeat alongside.
 */
async function chargerBehavior(
  id: string,
  clock: SimClock,
  rng: Rng,
  untilMs: number,
  effects: Effects,
): Promise<void> {
  let session = 0;
  const heartbeat = clock.setInterval(
    () => record(effects, id, clock, "heartbeat"),
    rng.int(50_000, 70_000),
  );
  try {
    while (clock.now() < untilMs) {
      await sleep(clock, rng.int(30_000, 300_000));
      session++;
      record(effects, id, clock, `plug-in#${session}`);

      // Two steps run at once and race a deadline.
      const authorize = sleep(clock, rng.int(100, 4_000)).then(() => "auth");
      const lock = sleep(clock, rng.int(100, 4_000)).then(() => "lock");
      const first = await until(clock, Promise.race([authorize, lock]), 2_000);
      record(
        effects,
        id,
        clock,
        `first=${first.timedOut ? "timeout" : first.value}`,
      );
      await Promise.all([authorize, lock]);

      const depth = await deepChain(rng.int(1, 40));
      record(effects, id, clock, `chain=${depth}`);

      // A few meter ticks of random spacing.
      const ticks = rng.int(2, 6);
      for (let i = 0; i < ticks; i++) {
        await sleep(clock, rng.int(1_000, 60_000));
        record(effects, id, clock, `meter#${i}=${rng.int(0, 1_000_000)}`);
        await Promise.resolve();
        queueMicrotask(() => record(effects, id, clock, `micro#${i}`));
      }
      try {
        if (rng.next() < 0.1) throw new Error("fault");
        record(effects, id, clock, "stop");
      } catch {
        record(effects, id, clock, "fault");
      } finally {
        await sleep(clock, 0);
        record(effects, id, clock, "unplug");
      }
    }
  } finally {
    clock.clearInterval(heartbeat);
  }
}

export interface RunResult extends Effects {
  readonly virtualMs: number;
  readonly realMs: number;
  readonly timers: number;
}

export async function runFleet(
  seed: string | number,
  chargers: number,
  hours: number,
  options: { extraCharger?: boolean; streams?: RngSource } = {},
): Promise<RunResult> {
  const clock = new VirtualClock({ start: Date.UTC(2030, 0, 1) });
  const streams = options.streams ?? new RngStreams(seed);
  const effects: Effects = { all: [], byCharger: new Map() };
  const untilMs = clock.now() + hours * HOUR_MS;
  const ids = Array.from({ length: chargers }, (_, i) => `CP-${i}`);
  if (options.extraCharger) ids.push("CP-EXTRA");
  const started = performance.now();
  const runs = ids.map((id) =>
    chargerBehavior(
      id,
      clock.scoped(id),
      streams.stream(id, "behavior"),
      untilMs,
      effects,
    ),
  );
  await clock.advanceTo(untilMs);
  // Let every loop notice the deadline and finish its last session.
  await clock.runUntilIdle();
  await Promise.all(runs);
  return {
    ...effects,
    virtualMs: clock.now() - (untilMs - hours * HOUR_MS),
    realMs: performance.now() - started,
    timers: clock.fired,
  };
}

/** sha256 of the effect lines joined by "\n", as lowercase hex (Web Crypto). */
export async function sha256Lines(lines: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(lines.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
