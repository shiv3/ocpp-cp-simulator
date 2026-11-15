import { afterEach, describe, expect, it, vi } from "vitest";

import { CallWaiters, type RpcClock } from "@ocpp-cp-simulator/ocpp-rpc/index";

describe("CallWaiters (ocpp-rpc)", () => {
  afterEach(() => vi.useRealTimers());

  it("runs on the platform timers by default", async () => {
    vi.useFakeTimers();
    const waiters = new CallWaiters<string>(100, (id) => new Error(id));
    const answer = waiters.register("a");
    vi.advanceTimersByTime(100);
    await expect(answer).rejects.toThrow("a");
  });

  it("reads the injected clock when a waiter is registered", async () => {
    const armed: number[] = [];
    const cleared: unknown[] = [];
    const clock: RpcClock = {
      setTimeout: (_fn, ms) => {
        armed.push(ms);
        return `t${armed.length}`;
      },
      clearTimeout: (handle) => cleared.push(handle),
    };
    let current: RpcClock = clock;
    const waiters = new CallWaiters<string>(
      250,
      (id) => new Error(id),
      () => current,
    );
    const answer = waiters.register("a");
    waiters.resolve("a", "ok");
    await expect(answer).resolves.toBe("ok");
    expect(armed).toEqual([250]);
    expect(cleared).toEqual(["t1"]);

    // A clock swapped in later is the one the next waiter uses.
    const later: unknown[] = [];
    current = {
      setTimeout: () => "late",
      clearTimeout: (handle) => later.push(handle),
    };
    const second = waiters.register("b");
    waiters.reject("b", new Error("no"));
    await expect(second).rejects.toThrow("no");
    expect(later).toEqual(["late"]);
  });
});
