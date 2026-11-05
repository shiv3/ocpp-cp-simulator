import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WaitControl } from "../WaitControl";

const timeoutError = (seconds: number) =>
  new Error(`Timeout waiting for test (${seconds}s)`);

describe("WaitControl (#240)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects `expired` with the timeout error once the deadline passes", async () => {
    const control = new WaitControl(5_000, timeoutError);
    const expired = expect(control.expired).rejects.toThrow(
      "Timeout waiting for test (5s)",
    );

    expect(control.deadlineAt).toBe(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expired;
    control.dispose();
  });

  it("has no deadline and never expires when the timeout is 0", async () => {
    const control = new WaitControl(0, timeoutError);
    const settled = vi.fn();
    control.expired.then(settled, settled);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(control.deadlineAt).toBeNull();
    expect(control.remainingMs()).toBeNull();
    expect(settled).not.toHaveBeenCalled();
    control.dispose();
  });

  it("extend postpones the deadline and reports the effective total", async () => {
    const control = new WaitControl(5_000, timeoutError);
    const settled = vi.fn();
    control.expired.catch(settled);

    await vi.advanceTimersByTimeAsync(4_000);
    control.extend(10_000);
    expect(control.remainingMs()).toBe(11_000);

    await vi.advanceTimersByTimeAsync(10_999);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Timeout waiting for test (15s)",
      }),
    );
    control.dispose();
  });

  it("refuses to extend a wait that has no deadline", () => {
    const control = new WaitControl(0, timeoutError);
    expect(() => control.extend(1_000)).toThrow(/no timeout/);
    control.dispose();
  });

  it("refuses a non-positive extension", () => {
    const control = new WaitControl(5_000, timeoutError);
    expect(() => control.extend(0)).toThrow(/positive/);
    expect(() => control.extend(Number.NaN)).toThrow(/positive/);
    control.dispose();
  });

  it("resolves `signal` with the first operator request", async () => {
    const control = new WaitControl(5_000, timeoutError);
    control.request("retry");
    control.request("continue");

    await expect(control.signal).resolves.toBe("retry");
    control.dispose();
  });

  it("resolves `signal` with continue", async () => {
    const control = new WaitControl(0, timeoutError);
    control.request("continue");

    await expect(control.signal).resolves.toBe("continue");
    control.dispose();
  });

  it("dispose stops the deadline from firing", async () => {
    const control = new WaitControl(1_000, timeoutError);
    const settled = vi.fn();
    control.expired.catch(settled);

    control.dispose();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).not.toHaveBeenCalled();
  });
});
