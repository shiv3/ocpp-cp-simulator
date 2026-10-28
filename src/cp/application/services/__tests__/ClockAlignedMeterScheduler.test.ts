import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClockAlignedMeterScheduler,
  nextClockAlignedBoundary,
} from "../ClockAlignedMeterScheduler";

// #454: clock-aligned samples land on boundaries counted from UTC midnight,
// not every N seconds from whenever the scheduler happened to start.

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe("nextClockAlignedBoundary (#454)", () => {
  it("rounds up to the next multiple of the interval", () => {
    expect(iso(nextClockAlignedBoundary(at("2026-10-28T12:00:17Z"), 60))).toBe(
      "2026-10-28T12:01:00.000Z",
    );
    expect(iso(nextClockAlignedBoundary(at("2026-10-28T12:07:00Z"), 900))).toBe(
      "2026-10-28T12:15:00.000Z",
    );
  });

  it("is strictly after an instant that is itself a boundary", () => {
    expect(iso(nextClockAlignedBoundary(at("2026-10-28T12:15:00Z"), 900))).toBe(
      "2026-10-28T12:30:00.000Z",
    );
  });

  it("counts from midnight and truncates the day's last slot when the interval does not divide a day", () => {
    // 86400 / 420 = 205.7: the last full slot starts at 23:55:00, the next
    // would be 00:02:00 the following day, so midnight itself is a boundary.
    expect(iso(nextClockAlignedBoundary(at("2026-10-28T23:50:00Z"), 420))).toBe(
      "2026-10-28T23:55:00.000Z",
    );
    expect(iso(nextClockAlignedBoundary(at("2026-10-28T23:56:00Z"), 420))).toBe(
      "2026-10-29T00:00:00.000Z",
    );
    expect(iso(nextClockAlignedBoundary(at("2026-10-29T00:00:00Z"), 420))).toBe(
      "2026-10-29T00:07:00.000Z",
    );
  });
});

describe("ClockAlignedMeterScheduler (#454)", () => {
  let fired: string[];
  let scheduler: ClockAlignedMeterScheduler;

  beforeEach(() => {
    vi.useFakeTimers({ now: at("2026-10-28T12:00:17Z") });
    fired = [];
    scheduler = new ClockAlignedMeterScheduler({
      onBoundary: (boundary) => fired.push(iso(boundary)),
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it("fires on true clock boundaries from a non-boundary start", () => {
    scheduler.start(60);
    vi.advanceTimersByTime(42_999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual(["2026-10-28T12:01:00.000Z"]);
    vi.advanceTimersByTime(120_000);
    expect(fired).toEqual([
      "2026-10-28T12:01:00.000Z",
      "2026-10-28T12:02:00.000Z",
      "2026-10-28T12:03:00.000Z",
    ]);
  });

  it("interval 0 disables emissions", () => {
    scheduler.start(0);
    vi.advanceTimersByTime(3_600_000);
    expect(fired).toEqual([]);
    expect(scheduler.intervalSeconds).toBe(0);
  });

  it("changing the interval mid-wait reschedules on the new grid", () => {
    scheduler.start(60);
    vi.advanceTimersByTime(43_000); // 12:01:00
    scheduler.start(900);
    vi.advanceTimersByTime(13 * 60_000); // 12:14:00
    expect(fired).toEqual(["2026-10-28T12:01:00.000Z"]);
    vi.advanceTimersByTime(60_000); // 12:15:00
    expect(fired).toEqual([
      "2026-10-28T12:01:00.000Z",
      "2026-10-28T12:15:00.000Z",
    ]);
  });

  it("changing the interval to 0 stops emissions", () => {
    scheduler.start(60);
    vi.advanceTimersByTime(43_000);
    scheduler.start(0);
    vi.advanceTimersByTime(600_000);
    expect(fired).toEqual(["2026-10-28T12:01:00.000Z"]);
  });

  it("stop() halts emissions", () => {
    scheduler.start(60);
    scheduler.stop();
    vi.advanceTimersByTime(600_000);
    expect(fired).toEqual([]);
  });

  it("never emits the same boundary twice across a stop/restart", () => {
    const early = new ClockAlignedMeterScheduler({
      onBoundary: (boundary) => fired.push(iso(boundary)),
      setTimer: (fn, ms) => setTimeout(fn, Math.max(0, ms - 1)),
    });
    early.start(60);
    vi.advanceTimersByTime(42_999); // 12:00:59.999 — reports 12:01:00
    // A reconnect right now re-arms on 12:01:00, the boundary just reported.
    early.stop();
    early.start(60);
    vi.advanceTimersByTime(60_001);
    expect(fired).toEqual([
      "2026-10-28T12:01:00.000Z",
      "2026-10-28T12:02:00.000Z",
    ]);
    early.stop();
  });

  it("stamps the boundary it was armed for, even when the timer fires early or late", () => {
    const early = new ClockAlignedMeterScheduler({
      onBoundary: (boundary) => fired.push(iso(boundary)),
      // A timer that fires one millisecond before its deadline.
      setTimer: (fn, ms) => setTimeout(fn, Math.max(0, ms - 1)),
    });
    early.start(60);
    vi.advanceTimersByTime(42_999); // 12:00:59.999
    expect(fired).toEqual(["2026-10-28T12:01:00.000Z"]);
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([
      "2026-10-28T12:01:00.000Z",
      "2026-10-28T12:02:00.000Z",
    ]);
    early.stop();
  });

  it("re-arms on the next boundary after a late fire instead of replaying missed ones", () => {
    const late = new ClockAlignedMeterScheduler({
      onBoundary: (boundary) => fired.push(iso(boundary)),
      // The event loop was blocked for 2.5 minutes past the deadline.
      setTimer: (fn, ms) => setTimeout(fn, ms + 150_000),
    });
    late.start(60);
    vi.advanceTimersByTime(193_000); // 12:03:30
    expect(fired).toEqual(["2026-10-28T12:01:00.000Z"]);
    late.stop();
  });
});
