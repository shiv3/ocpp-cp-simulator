import { describe, expect, it, vi } from "vitest";
import {
  RealClock,
  VirtualClock,
  drainMicrotasks,
  realClock,
  type SimClock,
} from "../clock";
import { RngStreams, systemRngStreams } from "../rng";

describe("RealClock", () => {
  it("reads the globals at call time, so fake timers steer it", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2031-02-03T04:05:06.000Z"));
      const fn = vi.fn();
      const handle = realClock.setTimeout(fn, 1000);
      expect(realClock.now()).toBe(Date.parse("2031-02-03T04:05:06.000Z"));
      vi.advanceTimersByTime(999);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
      realClock.clearTimeout(handle);
      const tick = vi.fn();
      const interval = realClock.setInterval(tick, 10);
      vi.advanceTimersByTime(35);
      realClock.clearInterval(interval);
      vi.advanceTimersByTime(100);
      expect(tick).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a SimClock", () => {
    const clock: SimClock = new RealClock();
    expect(typeof clock.now()).toBe("number");
  });
});

describe("VirtualClock", () => {
  it("fires timers in (time, owner, sequence) order", async () => {
    const clock = new VirtualClock({ start: 0 });
    const a = clock.scoped("cp-a");
    const b = clock.scoped("cp-b");
    const order: string[] = [];
    b.setTimeout(() => order.push("b1"), 10);
    a.setTimeout(() => order.push("a1"), 10);
    a.setTimeout(() => order.push("a2"), 10);
    b.setTimeout(() => order.push("b0"), 5);
    await clock.advanceBy(10);
    expect(order).toEqual(["b0", "a1", "a2", "b1"]);
    expect(clock.now()).toBe(10);
  });

  it("does not run a timer that is not yet due, and never goes backwards", async () => {
    const clock = new VirtualClock({ start: 100 });
    const fn = vi.fn();
    clock.setTimeout(fn, 50);
    await clock.advanceTo(149);
    expect(fn).not.toHaveBeenCalled();
    await clock.advanceTo(50);
    expect(clock.now()).toBe(149);
    await clock.advanceTo(150);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("settles an async continuation before the next timer fires", async () => {
    const clock = new VirtualClock({ start: 0 });
    const log: string[] = [];
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => clock.setTimeout(resolve, ms));
    void (async () => {
      await sleep(10);
      log.push("first");
      await Promise.resolve();
      await Promise.resolve();
      await sleep(0);
      log.push("second");
    })();
    clock.setTimeout(() => log.push("plain"), 10);
    await clock.advanceBy(10);
    // "first" resumed and re-armed its sleep(0) before "plain" ran; the new
    // timer is due at 10 too and sorts after the one armed earlier.
    expect(log).toEqual(["first", "plain", "second"]);
  });

  it("cancels timers and intervals", async () => {
    const clock = new VirtualClock({ start: 0 });
    const fn = vi.fn();
    const timer = clock.setTimeout(fn, 5);
    clock.clearTimeout(timer);
    const tick = vi.fn();
    const interval = clock.setInterval(() => {
      tick();
      if (tick.mock.calls.length === 3) clock.clearInterval(interval);
    }, 10);
    await clock.advanceBy(1000);
    expect(fn).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledTimes(3);
    expect(clock.pending).toBe(0);
  });

  it("runUntilIdle drains the queue and refuses to spin on an interval", async () => {
    const clock = new VirtualClock({ start: 0 });
    const hits: number[] = [];
    clock.setTimeout(() => {
      hits.push(clock.now());
      clock.setTimeout(() => hits.push(clock.now()), 7);
    }, 3);
    await clock.runUntilIdle();
    expect(hits).toEqual([3, 10]);

    clock.setInterval(() => undefined, 5);
    await expect(clock.runUntilIdle({ maxTimers: 50 })).rejects.toThrow(
      /still busy/,
    );
  });

  it("a timer callback that throws surfaces from the advance", async () => {
    const clock = new VirtualClock({ start: 0 });
    clock.setTimeout(() => {
      throw new Error("boom");
    }, 1);
    await expect(clock.advanceBy(5)).rejects.toThrow("boom");
  });

  it("drainMicrotasks lets queued promise chains finish", async () => {
    let done = false;
    void Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => Promise.resolve())
      .then(() => {
        done = true;
      });
    await drainMicrotasks();
    expect(done).toBe(true);
  });
});

describe("RngStreams", () => {
  it("replays: the same seed, charger and stream give the same numbers", () => {
    const a = new RngStreams("seed-1").stream("cp-1", "wait");
    const b = new RngStreams("seed-1").stream("cp-1", "wait");
    expect(Array.from({ length: 8 }, () => a.next())).toEqual(
      Array.from({ length: 8 }, () => b.next()),
    );
  });

  it("differs by seed, charger and stream", () => {
    const draw = (seed: string, cp: string, name: string) =>
      new RngStreams(seed).stream(cp, name).next();
    const base = draw("s", "cp-1", "wait");
    expect(draw("t", "cp-1", "wait")).not.toBe(base);
    expect(draw("s", "cp-2", "wait")).not.toBe(base);
    expect(draw("s", "cp-1", "other")).not.toBe(base);
  });

  it("adding a charger or a stream does not move another stream", () => {
    const alone = new RngStreams("s");
    const crowded = new RngStreams("s");
    crowded.stream("cp-0", "x").next();
    crowded.stream("cp-2", "wait").next();
    const expected = Array.from({ length: 5 }, () =>
      alone.stream("cp-1", "wait").next(),
    );
    const actual = Array.from({ length: 5 }, () =>
      crowded.stream("cp-1", "wait").next(),
    );
    expect(actual).toEqual(expected);
  });

  it("returns one stream per key, so draws continue", () => {
    const streams = new RngStreams(7);
    const first = streams.stream("cp", "s").next();
    expect(streams.stream("cp", "s").next()).not.toBe(first);
  });

  it("stays in range and mints v4-shaped uuids", () => {
    const rng = new RngStreams("range").stream("cp", "r");
    for (let i = 0; i < 1000; i++) {
      const n = rng.next();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
      const k = rng.int(5, 9);
      expect(k).toBeGreaterThanOrEqual(5);
      expect(k).toBeLessThan(9);
    }
    expect(rng.uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(() => rng.pick([])).toThrow();
  });

  it("system streams are the platform's", () => {
    const rng = systemRngStreams.stream("cp", "x");
    expect(rng.uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(rng.int(0, 1)).toBe(0);
  });
});
