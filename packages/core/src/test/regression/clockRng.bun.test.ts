import { describe, expect, it } from "bun:test";
import { VirtualClock } from "../../cp/shared/clock";
import { RngStreams } from "../../cp/shared/rng";

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | "HUNG"> =>
  Promise.race([
    p,
    new Promise<"HUNG">((r) => setTimeout(() => r("HUNG"), ms)),
  ]);

describe("VirtualClock", () => {
  it("setInterval(NaN) does not spin advanceBy forever (B1)", async () => {
    const c = new VirtualClock();
    let n = 0;
    const h = c.setInterval(() => void n++, Number.NaN);
    const r = await withTimeout(c.advanceBy(10), 300);
    c.clearInterval(h);
    expect(r).not.toBe("HUNG");
    expect(n).toBeLessThanOrEqual(11);
  });
  it("advanceTo(NaN) does not fire every timer (B2)", async () => {
    const c = new VirtualClock();
    let n = 0;
    c.setTimeout(() => void n++, 3_600_000);
    await c.advanceTo(Number.NaN).catch(() => undefined);
    expect(n).toBe(0);
  });
  it("a zero-delay self-rearming chain is stopped with an error, not a hang (B3)", async () => {
    const c = new VirtualClock();
    let stop = false;
    const tick = (): void => {
      if (!stop) c.setTimeout(tick, 0);
    };
    c.setTimeout(tick, 0);
    const r = await withTimeout(
      c.advanceBy(10).then(
        () => "RETURNED",
        (e: Error) => e.message,
      ),
      2000,
    );
    stop = true;
    expect(r).toMatch(/re-arms itself with no delay/);
  });
  it("two concurrent advanceBy(100) move time by 200 or refuse (B4)", async () => {
    const c = new VirtualClock({ start: 0 });
    let rejected = false;
    await Promise.all([
      c.advanceBy(100),
      c.advanceBy(100).catch(() => {
        rejected = true;
      }),
    ]);
    expect(rejected || c.now() === 200).toBe(true);
  });
  it("a callback calling advanceBy does not overrun the outer target (B5)", async () => {
    const c = new VirtualClock({ start: 0 });
    const order: string[] = [];
    c.setTimeout(() => {
      order.push(`a@${c.now()}`);
      void c.advanceBy(1000);
    }, 10);
    c.setTimeout(() => order.push(`b@${c.now()}`), 20);
    await c.advanceTo(30);
    // b must fire at its own time however re-entrancy is handled.
    expect(order).toEqual(["a@10", "b@20"]);
  });
  it("a throwing timer leaves later timers and the clock usable (B6)", async () => {
    const c = new VirtualClock({ start: 0 });
    const fired: number[] = [];
    c.setTimeout(() => {
      throw new Error("boom");
    }, 10);
    c.setTimeout(() => fired.push(c.now()), 20);
    await expect(c.advanceTo(30)).rejects.toThrow("boom");
    await c.advanceTo(30);
    expect(fired).toEqual([20]);
    expect(c.now()).toBe(30);
  });
  it("advanceTo backwards keeps time, fires nothing", async () => {
    const c = new VirtualClock({ start: 100 });
    let n = 0;
    c.setTimeout(() => void n++, 5);
    await c.advanceTo(50);
    expect(c.now()).toBe(100);
    expect(n).toBe(0);
  });
  it("order: time, owner, seq; interval no drift; clear during drain", async () => {
    const c = new VirtualClock({ start: 0 });
    const log: string[] = [];
    const b = c.scoped("b");
    const a = c.scoped("a");
    b.setTimeout(() => log.push("b1"), 10);
    a.setTimeout(() => log.push("a1"), 10);
    a.setTimeout(() => log.push("a2"), 10);
    c.setTimeout(() => log.push("root"), 10);
    const victim = b.setTimeout(() => log.push("victim"), 10);
    a.setTimeout(() => b.clearTimeout(victim), 5);
    await c.advanceTo(10);
    expect(log).toEqual(["root", "a1", "a2", "b1"]);
    const ts: number[] = [];
    const h = c.setInterval(() => ts.push(c.now()), 7);
    await c.advanceBy(30);
    c.clearInterval(h);
    expect(ts).toEqual([17, 24, 31, 38]);
    expect(c.pending).toBe(0);
  });
});

describe("RealClock", () => {
  it("ctx.sleep-sized delays past 2^31 ms do not fire at once (B12)", async () => {
    const { RealClock } = await import("../../cp/shared/clock");
    const c = new RealClock();
    let fired = false;
    const h = c.setTimeout(() => {
      fired = true;
    }, 30 * 86_400_000);
    await new Promise((r) => setTimeout(r, 30));
    c.clearTimeout(h);
    expect(fired).toBe(false);
  });
});

describe("RngStreams", () => {
  const r = () => new RngStreams("s").stream("c", "n");
  it("int honours [min,max) for a reversed range or refuses (B7)", () => {
    const x = r();
    let bad = 0;
    for (let i = 0; i < 1000; i++) {
      let v: number;
      try {
        v = x.int(5, 3);
      } catch {
        continue;
      }
      if (!(v >= 3 && v < 5)) bad++;
    }
    expect(bad).toBe(0);
  });
  it("int(0, 0) on an empty range refuses (B8)", () => {
    expect(() => r().int(0, 0)).toThrow();
  });
  it("int with a missing max does not return NaN (B8)", () => {
    let v: number | undefined;
    try {
      v = (r().int as unknown as (a: number) => number)(10);
    } catch {
      return;
    }
    expect(Number.isNaN(v)).toBe(false);
  });
  it("uuid is valid v4; pick([]) throws; concat keys are distinct", () => {
    const x = r();
    for (let i = 0; i < 500; i++) {
      expect(x.uuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(() => x.pick([])).toThrow();
    const a = new RngStreams("s").stream("ab", "c").next();
    const b = new RngStreams("s").stream("a", "bc").next();
    const c2 = new RngStreams("sa").stream("b", "c").next();
    expect(new Set([a, b, c2]).size).toBe(3);
  });
  it("int is uniform enough and a stream is independent of others", () => {
    const x = r();
    const h = new Array(7).fill(0);
    for (let i = 0; i < 70000; i++) h[x.int(0, 7)]++;
    for (const v of h) expect(Math.abs(v - 10000)).toBeLessThan(500);
    const s1 = new RngStreams(1);
    const s2 = new RngStreams(1);
    s2.stream("z", "n").next();
    s2.stream("c", "other").next();
    expect(s1.stream("c", "n").next()).toBe(s2.stream("c", "n").next());
  });
});
