import { describe, expect, it, vi } from "vitest";

import {
  cyrb128,
  deriveSeed32,
  draw,
  makeRuleRng,
  xoshiro128ss,
} from "../SeededRng";

describe("SeededRng", () => {
  it("matches the pinned cyrb128 vector", () => {
    expect(cyrb128("1:CP-001")).toEqual([
      1_428_295_881, 1_997_150_177, 152_309_323, 883_304_730,
    ]);
  });

  it("matches the pinned xoshiro128** vector", () => {
    const next = xoshiro128ss([1, 2, 3, 4]);

    expect(Array.from({ length: 5 }, () => next())).toEqual([
      11_520, 0, 5_927_040, 70_819_200, 2_031_721_883,
    ]);
  });

  it("derives the pinned charger seed", () => {
    expect(deriveSeed32(1, "CP-001")).toBe(1_428_295_881);
  });

  it("draws values within the requested bound", () => {
    const next = xoshiro128ss([1, 2, 3, 4]);

    for (let index = 0; index < 1_000; index += 1) {
      const value = draw(next, 1_000);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1_000);
    }
  });

  it("returns zero when drawing with a zero bound", () => {
    expect(draw(xoshiro128ss([1, 2, 3, 4]), 0)).toBe(0);
  });

  it("keeps charger rule streams independent", () => {
    const chargerARng = makeRuleRng(deriveSeed32(1, "CP-A"), "latency");
    const chargerBRng = makeRuleRng(deriveSeed32(1, "CP-B"), "latency");
    const untouchedChargerBRng = makeRuleRng(
      deriveSeed32(1, "CP-B"),
      "latency",
    );

    Array.from({ length: 100 }, () => chargerARng());

    expect(Array.from({ length: 10 }, () => chargerBRng())).toEqual(
      Array.from({ length: 10 }, () => untouchedChargerBRng()),
    );
  });

  it("replaces derivation with an explicit identical charger seed", () => {
    const first = makeRuleRng(123_456_789, "periodic-disconnect");
    const second = makeRuleRng(123_456_789, "periodic-disconnect");

    expect(Array.from({ length: 10 }, () => first())).toEqual(
      Array.from({ length: 10 }, () => second()),
    );
  });

  it("guards an all-zero rule state with the pinned fallback stream", () => {
    const multiply = vi.spyOn(Math, "imul").mockReturnValue(0);
    const next = makeRuleRng(1, "all-zero");
    multiply.mockRestore();

    // xoshiro128** seeded with the fixed fallback state [0x9E3779B9, 0, 0, 0].
    expect(Array.from({ length: 5 }, () => next())).toEqual([
      0, 3761423075, 3761423075, 990365089, 63450941,
    ]);
  });
});
