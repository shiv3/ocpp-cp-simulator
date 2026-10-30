import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_MS, setTimeoutAt } from "../timers";

describe("setTimeoutAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires at the deadline, not before", () => {
    const callback = vi.fn();
    setTimeoutAt(1_000, callback);
    vi.advanceTimersByTime(999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("fires asynchronously for a past deadline", () => {
    const callback = vi.fn();
    setTimeoutAt(-5, callback);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("chains a wait beyond the setTimeout limit", () => {
    const callback = vi.fn();
    const fireAt = MAX_TIMER_MS + 10_000;
    setTimeoutAt(fireAt, callback);
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("cancels whichever link of the chain is pending", () => {
    const callback = vi.fn();
    const cancel = setTimeoutAt(MAX_TIMER_MS + 10_000, callback);
    vi.advanceTimersByTime(MAX_TIMER_MS);
    cancel();
    vi.advanceTimersByTime(20_000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("re-arms when its clock is still before the deadline", () => {
    let clock = 0;
    const callback = vi.fn();
    setTimeoutAt(1_000, callback, { now: () => clock });
    vi.advanceTimersByTime(1_000);
    expect(callback).not.toHaveBeenCalled();
    clock = 1_000;
    vi.advanceTimersByTime(1_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
