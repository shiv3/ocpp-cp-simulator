import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CallWaiters } from "../CallWaiters";

describe("CallWaiters", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () =>
    new CallWaiters<string>(100, (id) => new Error(`${id} timed out`));

  it("resolves the waiter registered under an id, once", async () => {
    const waiters = make();
    const answer = waiters.register("a");
    waiters.resolve("a", "ok");
    waiters.resolve("a", "again");
    await expect(answer).resolves.toBe("ok");
  });

  it("rejects on its timer and forgets the id", async () => {
    const waiters = make();
    const answer = waiters.register("a");
    vi.advanceTimersByTime(100);
    await expect(answer).rejects.toThrow("a timed out");
    // Settling a forgotten id is a no-op.
    waiters.reject("a", new Error("late"));
  });

  it("rejects every pending waiter", async () => {
    const waiters = make();
    const a = waiters.register("a");
    const b = waiters.register("b");
    waiters.rejectAll((id) => new Error(`${id} closed`));
    await expect(a).rejects.toThrow("a closed");
    await expect(b).rejects.toThrow("b closed");
    vi.advanceTimersByTime(100);
  });

  it("ignores an id nobody waits for", () => {
    expect(() => make().resolve("nobody", "x")).not.toThrow();
  });
});
