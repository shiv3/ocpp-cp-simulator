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
    scheduler = new ClockAlignedMeterScheduler((boundary) =>
      fired.push(iso(boundary)),
    );
  });

  afterEach(() => {
    scheduler.disable();
    vi.useRealTimers();
  });

  /** Moves the wall clock without moving pending timers, so the next timer
   *  fires `skewMs` late (positive) or early (negative) by the clock. */
  const skewClock = (skewMs: number) => vi.setSystemTime(Date.now() + skewMs);

  it("fires on true clock boundaries from a non-boundary start", () => {
    scheduler.setIntervalSeconds(60);
    scheduler.enable();
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

  it("interval 0 sends nothing, even when enabled", () => {
    scheduler.enable();
    vi.advanceTimersByTime(3_600_000);
    expect(fired).toEqual([]);
  });

  it("does not fire until enabled, then uses the interval set before", () => {
    scheduler.setIntervalSeconds(60);
    vi.advanceTimersByTime(120_000); // 12:02:17
    expect(fired).toEqual([]);
    scheduler.enable();
    vi.advanceTimersByTime(43_000); // 12:03:00
    expect(fired).toEqual(["2026-10-28T12:03:00.000Z"]);
  });

  it("changing the interval mid-wait reschedules on the new grid", () => {
    scheduler.setIntervalSeconds(60);
    scheduler.enable();
    vi.advanceTimersByTime(43_000); // 12:01:00
    scheduler.setIntervalSeconds(900);
    vi.advanceTimersByTime(13 * 60_000); // 12:14:00
    expect(fired).toEqual(["2026-10-28T12:01:00.000Z"]);
    vi.advanceTimersByTime(60_000); // 12:15:00
    expect(fired).toEqual([
      "2026-10-28T12:01:00.000Z",
      "2026-10-28T12:15:00.000Z",
    ]);
  });

  it("changing the interval to 0 stops emissions", () => {
    scheduler.setIntervalSeconds(60);
    scheduler.enable();
    vi.advanceTimersByTime(43_000);
    scheduler.setIntervalSeconds(0);
    vi.advanceTimersByTime(600_000);
    expect(fired).toEqual(["2026-10-28T12:01:00.000Z"]);
  });

  it("disable() halts emissions", () => {
    scheduler.setIntervalSeconds(60);
    scheduler.enable();
    scheduler.disable();
    vi.advanceTimersByTime(600_000);
    expect(fired).toEqual([]);
  });

  it("stamps the boundary it was armed for when the timer fires early, and never emits it twice across a disable/enable", () => {
    scheduler.setIntervalSeconds(60);
    scheduler.enable();
    skewClock(-1);
    vi.advanceTimersByTime(43_000); // clock 12:00:59.999
    expect(fired).toEqual(["2026-10-28T12:01:00.000Z"]);
    // A reconnect right now would re-arm on 12:01:00, the boundary just
    // reported, if arming went by the clock alone.
    scheduler.disable();
    scheduler.enable();
    vi.advanceTimersByTime(60_001);
    expect(fired).toEqual([
      "2026-10-28T12:01:00.000Z",
      "2026-10-28T12:02:00.000Z",
    ]);
  });

  it("re-arms on the next boundary after a late fire instead of replaying missed ones", () => {
    scheduler.setIntervalSeconds(60);
    scheduler.enable();
    skewClock(150_000); // the event loop was blocked for 2.5 minutes
    vi.advanceTimersByTime(43_000); // clock 12:03:30
    expect(fired).toEqual(["2026-10-28T12:01:00.000Z"]);
    vi.advanceTimersByTime(30_000); // clock 12:04:00
    expect(fired).toEqual([
      "2026-10-28T12:01:00.000Z",
      "2026-10-28T12:04:00.000Z",
    ]);
  });
});
