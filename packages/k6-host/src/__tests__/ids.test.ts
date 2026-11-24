import { describe, expect, it } from "vitest";
import {
  chargerId,
  chargerIndex,
  parseDurationSeconds,
  startDelayMs,
  vusFor,
} from "../ids";

describe("charger ids across virtual users and k6 instances", () => {
  const shape = { chargers: 23, chargersPerVu: 5 };

  it("needs ceil(chargers / perVu) VUs", () => {
    expect(vusFor(shape)).toBe(5);
    expect(vusFor({ chargers: 50, chargersPerVu: 50 })).toBe(1);
  });

  it("gives every charger of the fleet exactly one index", () => {
    const seen: number[] = [];
    for (let vu = 1; vu <= vusFor(shape); vu++) {
      for (let slot = 0; slot < shape.chargersPerVu; slot++) {
        const i = chargerIndex(shape, vu, slot);
        if (i !== null) seen.push(i);
      }
    }
    expect(seen.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 23 }, (_, i) => i),
    );
  });

  it("two instances running complementary VU ranges never share an id", () => {
    // k6 hands instance A the VU ids 1..3 and instance B 4..5 (idInTest).
    const ids = (vus: number[]): string[] =>
      vus.flatMap((vu) =>
        Array.from({ length: shape.chargersPerVu }, (_, slot) => {
          const i = chargerIndex(shape, vu, slot);
          return i === null
            ? []
            : [chargerId({ prefix: "CP-", pad: 5, offset: 0 }, i)];
        }).flat(),
      );
    const a = ids([1, 2, 3]);
    const b = ids([4, 5]);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect(new Set([...a, ...b]).size).toBe(23);
  });

  it("formats ids with prefix, padding and offset", () => {
    expect(chargerId({ prefix: "CP-", pad: 5, offset: 0 }, 0)).toBe("CP-00001");
    expect(chargerId({ prefix: "X", pad: 3, offset: 1000 }, 41)).toBe("X1042");
  });

  it("spreads connect starts over the ramp", () => {
    expect(startDelayMs(0, 10, 10_000)).toBe(0);
    expect(startDelayMs(5, 10, 10_000)).toBe(5000);
    expect(startDelayMs(3, 1, 10_000)).toBe(0);
    expect(startDelayMs(3, 10, 0)).toBe(0);
  });
});

describe("parseDurationSeconds", () => {
  it("reads k6-style durations", () => {
    expect(parseDurationSeconds("30s")).toBe(30);
    expect(parseDurationSeconds("5m")).toBe(300);
    expect(parseDurationSeconds("1h30m")).toBe(5400);
    expect(parseDurationSeconds("500ms")).toBe(0.5);
    expect(parseDurationSeconds("45")).toBe(45);
  });
  it("rejects garbage", () => {
    expect(() => parseDurationSeconds("soon")).toThrow(/invalid duration/);
    expect(() => parseDurationSeconds("5mx")).toThrow(/invalid duration/);
  });
});
