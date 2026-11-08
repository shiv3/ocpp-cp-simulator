import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECONNECT_POLICY,
  nextReconnectDelayMs,
  resolveReconnectPolicy,
  retryBackOffDefaults,
} from "../ReconnectPolicy";

const never = () => {
  throw new Error("no jitter expected");
};

const delays = (
  policy = DEFAULT_RECONNECT_POLICY,
  n = 8,
  random: () => number = never,
  vars?: Parameters<typeof nextReconnectDelayMs>[3],
) =>
  Array.from({ length: n }, (_, i) => {
    const d = nextReconnectDelayMs(policy, i + 1, random, vars);
    return d.kind === "retry" ? d.delayMs : "give-up";
  });

describe("ReconnectPolicy (#609)", () => {
  it("defaults to the schedule the transport had: 1 s doubling to 30 s, forever", () => {
    expect(delays(DEFAULT_RECONNECT_POLICY, 8)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
    expect(
      nextReconnectDelayMs(DEFAULT_RECONNECT_POLICY, 10_000, never).kind,
    ).toBe("retry");
  });

  it("fixed mode waits the base delay every time", () => {
    const p = resolveReconnectPolicy({ mode: "fixed", baseDelayMs: 250 });
    expect(delays(p, 4)).toEqual([250, 250, 250, 250]);
  });

  it("gives up after maxAttempts, and maxAttempts 0 never reconnects", () => {
    const p = resolveReconnectPolicy({ maxAttempts: 2 });
    expect(delays(p, 4)).toEqual([1000, 2000, "give-up", "give-up"]);
    expect(delays(resolveReconnectPolicy({ maxAttempts: 0 }), 1)).toEqual([
      "give-up",
    ]);
  });

  it("adds a jitter in [0, jitterMs] from the supplied random", () => {
    const p = resolveReconnectPolicy({ jitterMs: 100 });
    expect(delays(p, 1, () => 0)).toEqual([1000]);
    expect(delays(p, 1, () => 0.999999)).toEqual([1100]);
    expect(delays(p, 1, () => 0.5)).toEqual([1050]);
  });

  it("rejects values it cannot honour", () => {
    expect(() => resolveReconnectPolicy({ maxAttempts: -2 })).toThrow(
      /maxAttempts/,
    );
    expect(() => resolveReconnectPolicy({ mode: "linear" as never })).toThrow(
      /mode/,
    );
    expect(() =>
      resolveReconnectPolicy({ baseDelayMs: 5000, maxDelayMs: 1000 }),
    ).toThrow(/maxDelayMs/);
    expect(() => resolveReconnectPolicy({ jitterMs: -1 })).toThrow(/jitterMs/);
  });

  describe("OCPP 2.x RetryBackOff variables (Part 4 §5.4)", () => {
    it("derives variable defaults that reproduce the default schedule", () => {
      const vars = retryBackOffDefaults(DEFAULT_RECONNECT_POLICY);
      expect(vars).toEqual({
        waitMinimumSeconds: 1,
        randomRangeSeconds: 0,
        repeatTimes: 5,
      });
      expect(delays(DEFAULT_RECONNECT_POLICY, 8, never, vars)).toEqual(
        delays(DEFAULT_RECONNECT_POLICY, 8),
      );
    });

    it("doubles the minimum RepeatTimes times, then stays constant", () => {
      const vars = {
        waitMinimumSeconds: 10,
        randomRangeSeconds: 0,
        repeatTimes: 2,
      };
      expect(delays(DEFAULT_RECONNECT_POLICY, 5, never, vars)).toEqual([
        10_000, 20_000, 40_000, 40_000, 40_000,
      ]);
    });

    // TC_B_57_CS (2.0.1 Part 6): the station follows what the CSMS set, not
    // the simulator's own 30 s ceiling.
    it("follows WaitMinimum 20 / RepeatTimes 2 with the default policy", () => {
      const vars = {
        waitMinimumSeconds: 20,
        randomRangeSeconds: 0,
        repeatTimes: 2,
      };
      expect(delays(DEFAULT_RECONNECT_POLICY, 4, never, vars)).toEqual([
        20_000, 40_000, 80_000, 80_000,
      ]);
    });

    it("keeps the 30 s ceiling while the variables are the derived defaults", () => {
      const vars = retryBackOffDefaults(DEFAULT_RECONNECT_POLICY);
      expect(delays(DEFAULT_RECONNECT_POLICY, 7, never, vars)).toEqual([
        1000, 2000, 4000, 8000, 16000, 30000, 30000,
      ]);
    });

    it("never exceeds the timer limit, with or without variables", () => {
      const vars = {
        waitMinimumSeconds: 2_000_000,
        randomRangeSeconds: 1_000_000,
        repeatTimes: 30,
      };
      const max = 2_147_483_647;
      expect(delays(DEFAULT_RECONNECT_POLICY, 3, () => 0.999, vars)).toEqual([
        max,
        max,
        max,
      ]);
      const p = resolveReconnectPolicy({
        baseDelayMs: max,
        maxDelayMs: max,
        jitterMs: max,
      });
      expect(delays(p, 1, () => 0.999)).toEqual([max]);
    });

    it("adds a random time in [0, RandomRange] seconds", () => {
      const vars = {
        waitMinimumSeconds: 10,
        randomRangeSeconds: 10,
        repeatTimes: 2,
      };
      const p = DEFAULT_RECONNECT_POLICY;
      expect(delays(p, 1, () => 0, vars)).toEqual([10_000]);
      expect(delays(p, 2, () => 0.999999, vars).at(-1)).toBe(30_000);
    });

    it("never waits less than the minimum, whatever maxDelayMs says", () => {
      const vars = {
        waitMinimumSeconds: 60,
        randomRangeSeconds: 0,
        repeatTimes: 3,
      };
      expect(delays(DEFAULT_RECONNECT_POLICY, 3, never, vars)).toEqual([
        60_000, 120_000, 240_000,
      ]);
    });

    it("still gives up after maxAttempts", () => {
      const vars = {
        waitMinimumSeconds: 1,
        randomRangeSeconds: 0,
        repeatTimes: 0,
      };
      const p = resolveReconnectPolicy({ maxAttempts: 1 });
      expect(delays(p, 2, never, vars)).toEqual([1000, "give-up"]);
    });
  });
});
