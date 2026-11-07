// A browser has no setImmediate: drainMicrotasks hops with a MessageChannel
// (not setTimeout(0), which a browser clamps to 4 ms when nested). Verified in
// real Chromium by scripts/verify/browser; here the same path on Bun, by
// importing the clock with the global removed.
import { describe, expect, it } from "bun:test";

describe("drainMicrotasks without setImmediate", () => {
  it("resolves after queued microtasks, many times, without a timer clamp", async () => {
    const real = globalThis.setImmediate;
    // @ts-expect-error simulate a browser
    delete globalThis.setImmediate;
    let clock: typeof import("../clock");
    try {
      // A query makes a second module instance, which reads the global again.
      const specifier = "../clock?no-set-immediate";
      clock = (await import(specifier)) as typeof import("../clock");
    } finally {
      globalThis.setImmediate = real;
    }
    let depth = 0;
    const chain = async (n: number): Promise<void> => {
      if (n === 0) return;
      await Promise.resolve();
      depth++;
      await chain(n - 1);
    };
    const started = performance.now();
    for (let i = 0; i < 500; i++) {
      depth = 0;
      void chain(30);
      await clock.drainMicrotasks();
      expect(depth).toBe(30);
    }
    // 500 setTimeout(0) hops nested in a browser would take 2 s; this is a
    // message hop. Generous bound for a loaded host.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("behaviorsOfModule", () => {
  it("accepts one behavior or an array, and names the module in the error", async () => {
    const { behaviorsOfModule } =
      await import("../../application/engine/behaviorModule");
    const b = { api: 1 as const, id: "x" };
    expect(behaviorsOfModule("m", { default: b })).toEqual([b]);
    expect(
      behaviorsOfModule("m", { default: [b, { ...b, id: "y" }] }),
    ).toHaveLength(2);
    expect(() => behaviorsOfModule("blob", { default: { id: "x" } })).toThrow(
      /blob:.*api: 1/,
    );
    expect(() => behaviorsOfModule("blob", {})).toThrow(/blob:/);
  });
});
