import { describe, expect, it } from "bun:test";

import { selectLogWindow } from "../logWindow";

/**
 * `logs.get {limit}` used to answer with the OLDEST N entries, so on a charge
 * point that had been up for days no limit could reach recent activity. These
 * pin the tail semantics and the paging direction.
 */
const entries = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

describe("selectLogWindow", () => {
  it("returns the newest N, chronologically, for a bare limit", () => {
    expect(selectLogWindow(entries, { limit: 3 })).toEqual([8, 9, 10]);
  });

  it("returns everything when no limit is given", () => {
    expect(selectLogWindow(entries)).toEqual(entries);
    expect(selectLogWindow(entries, { order: "asc" })).toEqual(entries);
  });

  it("pages backwards from the newest with offset", () => {
    expect(selectLogWindow(entries, { limit: 3, offset: 0 })).toEqual([
      8, 9, 10,
    ]);
    expect(selectLogWindow(entries, { limit: 3, offset: 3 })).toEqual([
      5, 6, 7,
    ]);
    expect(selectLogWindow(entries, { limit: 3, offset: 6 })).toEqual([
      2, 3, 4,
    ]);
    // Partial final page rather than a wrap-around or a throw.
    expect(selectLogWindow(entries, { limit: 3, offset: 9 })).toEqual([1]);
    expect(selectLogWindow(entries, { limit: 3, offset: 10 })).toEqual([]);
    expect(selectLogWindow(entries, { limit: 3, offset: 99 })).toEqual([]);
  });

  it("reverses the window for order: desc, keeping the same members", () => {
    expect(selectLogWindow(entries, { limit: 3, order: "desc" })).toEqual([
      10, 9, 8,
    ]);
    expect(selectLogWindow(entries, { order: "desc" })).toEqual(
      [...entries].reverse(),
    );
    // desc paging still walks backwards through history.
    expect(
      selectLogWindow(entries, { limit: 3, offset: 3, order: "desc" }),
    ).toEqual([7, 6, 5]);
  });

  it("offset alone drops the newest entries", () => {
    expect(selectLogWindow(entries, { offset: 8 })).toEqual([1, 2]);
  });

  it("handles a limit past the end, zero, and an empty buffer", () => {
    expect(selectLogWindow(entries, { limit: 99 })).toEqual(entries);
    expect(selectLogWindow(entries, { limit: 0 })).toEqual([]);
    expect(selectLogWindow([], { limit: 5 })).toEqual([]);
    expect(selectLogWindow([], {})).toEqual([]);
  });

  it("does not mutate the input", () => {
    const source = [...entries];
    selectLogWindow(source, { order: "desc" });
    expect(source).toEqual(entries);
  });
});
