// The pure helpers of a behavior iteration (the k6 modules are stubbed; the
// iteration itself is exercised by the real-k6 run).
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HOLD_MS,
  identitiesOfVu,
  parseDurationMs,
  stopAtMs,
} from "@ocpp-cp-sim/k6-runtime/behaviorRun";

vi.mock("k6", () => ({ check: () => true }));
vi.mock("k6/websockets", () => ({ WebSocket: class {} }));
vi.mock("k6/metrics", () => ({
  Trend: class {
    add(): void {}
  },
  Counter: class {
    add(): void {}
  },
  Rate: class {
    add(): void {}
  },
}));
vi.mock("k6/timers", () => ({
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
}));
vi.mock("k6/execution", () => ({
  default: { scenario: { startTime: 0, name: "" }, vu: { idInTest: 1 } },
}));

describe("parseDurationMs", () => {
  it("reads k6 durations", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("1h30m")).toBe(5_400_000);
    expect(parseDurationMs("250ms")).toBe(250);
    expect(parseDurationMs("oops")).toBeNull();
    expect(parseDurationMs("10x")).toBeNull();
    expect(parseDurationMs(undefined)).toBeNull();
  });
});

describe("identitiesOfVu", () => {
  it("is one id per VU, or a numbered group", () => {
    expect(identitiesOfVu({}, null, 3)).toEqual([{ cpId: "CP-3" }]);
    expect(
      identitiesOfVu(
        { CHARGERS_PER_VU: "3", CP_ID_TEMPLATE: "X-${__VU}" },
        null,
        2,
      ).map((i) => i.cpId),
    ).toEqual(["X-2-1", "X-2-2", "X-2-3"]);
    const ids = [{ cpId: "a" }, { cpId: "b" }, { cpId: "c" }, { cpId: "d" }];
    expect(
      identitiesOfVu({ CHARGERS_PER_VU: "2" }, ids, 2).map((i) => i.cpId),
    ).toEqual(["c", "d"]);
    expect(() => identitiesOfVu({ CHARGERS_PER_VU: "0" }, null, 1)).toThrow(
      /CHARGERS_PER_VU/,
    );
  });
});

describe("stopAtMs", () => {
  it("takes the earliest of RUN_FOR_MS and the end of the run", () => {
    expect(stopAtMs({ RUN_FOR_MS: "5000" }, 1000, 0, true)).toBe(6000);
    expect(
      stopAtMs({ RUN_FOR_MS: "5000", DURATION: "4s" }, 1000, 0, true),
    ).toBe(2000);
    expect(
      stopAtMs({ PROFILE: "spike", DURATION: "4s" }, 1000, 0, true),
    ).toBeNull();
  });
  it("holds a behavior with no main, and lets mains end the others", () => {
    expect(stopAtMs({}, 1000, 0, false)).toBe(1000 + DEFAULT_HOLD_MS);
    expect(stopAtMs({}, 1000, 0, true)).toBeNull();
    expect(() => stopAtMs({ RUN_FOR_MS: "1.5" }, 0, 0, true)).toThrow(
      /RUN_FOR_MS/,
    );
  });
});
