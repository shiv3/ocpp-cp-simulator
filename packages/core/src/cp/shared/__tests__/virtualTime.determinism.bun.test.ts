// Verification V1 of docs/analyses/charger-engine.md: async functions on a
// VirtualClock are deterministic on Bun. 1,000 simulated chargers run
// behavior-shaped async loops (sleeps, random waits, racing timeouts,
// periodic timers, deep promise chains); the ordered effects of the whole
// fleet are hashed. The same seed gives the same hash, another seed another
// one, and hours of virtual time pass in seconds of real time.
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { VirtualClock, type SimClock } from "../clock";
import { RngStreams, systemRngStreams, type Rng, type RngSource } from "../rng";

const HOUR_MS = 3_600_000;
const PINNED_HASH =
  "c745d5ba4e9f72906fb5354884de37fbcc4e53d7c8d6a747ebc3919a399307ea";

interface Effects {
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

const hash = (lines: readonly string[]) =>
  createHash("sha256").update(lines.join("\n")).digest("hex");

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

interface RunResult extends Effects {
  readonly virtualMs: number;
  readonly realMs: number;
  readonly timers: number;
}

async function runFleet(
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

describe("V1: async behavior on a VirtualClock is deterministic on Bun", () => {
  it("1,000 chargers: the same seed gives the same effect hash, another seed another", async () => {
    const a = await runFleet("seed-A", 1000, 1);
    const b = await runFleet("seed-A", 1000, 1);
    const c = await runFleet("seed-B", 1000, 1);
    expect(a.all.length).toBeGreaterThan(50_000);
    expect(hash(a.all)).toBe(hash(b.all));
    expect(a.all).toEqual(b.all);
    expect(hash(c.all)).not.toBe(hash(a.all));
  }, 120_000);

  it("advances hours of virtual time in seconds of real time", async () => {
    const run = await runFleet("seed-hours", 1000, 6);
    expect(run.virtualMs).toBeGreaterThanOrEqual(6 * HOUR_MS);
    expect(run.timers).toBeGreaterThan(100_000);
    // 6 hours x 1,000 chargers; the budget is generous for a loaded CI host.
    expect(run.realMs).toBeLessThan(60_000);
    console.log(
      `V1: ${run.timers} timers, ${(run.virtualMs / HOUR_MS).toFixed(1)} virtual hours x 1000 chargers in ${(run.realMs / 1000).toFixed(2)} s real`,
    );
  }, 120_000);

  it("adding a charger does not change what another charger does", async () => {
    const without = await runFleet("seed-C", 200, 1);
    const withExtra = await runFleet("seed-C", 200, 1, { extraCharger: true });
    for (const [id, lines] of without.byCharger) {
      expect(hash(withExtra.byCharger.get(id)!)).toBe(hash(lines));
    }
    expect(withExtra.byCharger.has("CP-EXTRA")).toBe(true);
  }, 120_000);

  it("the hash is sensitive: unseeded randomness gives two different runs", async () => {
    const a = await runFleet("x", 50, 1, { streams: systemRngStreams });
    const b = await runFleet("x", 50, 1, { streams: systemRngStreams });
    expect(hash(a.all)).not.toBe(hash(b.all));
  }, 60_000);

  it("is stable across processes: a pinned hash for a small fleet", async () => {
    const run = await runFleet("pinned", 25, 1);
    // If this changes, the RNG, the VirtualClock order or a platform
    // guarantee changed; look before updating it.
    expect(hash(run.all)).toBe(PINNED_HASH);
  }, 60_000);
});
