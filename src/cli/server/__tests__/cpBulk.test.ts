import { afterEach, describe, expect, it, vi } from "vitest";

import { runCpBulk } from "../cpBulk";

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

afterEach(() => {
  vi.useRealTimers();
});

describe("runCpBulk (#470)", () => {
  it("reports every id, successes and failures in selection order", async () => {
    const result = await runCpBulk(
      ["A", "B", "C"],
      async (cpId) => {
        if (cpId === "B") throw new Error("Connection failed: code=1006");
      },
      { waitMs: 1_000, failureReason: reason },
    );

    expect(result).toEqual({
      matched: ["A", "B", "C"],
      succeeded: ["A", "C"],
      failed: [{ cpId: "B", reason: "Connection failed: code=1006" }],
    });
  });

  it("returns an empty report when nothing is selected", async () => {
    const act = vi.fn(async () => {});
    expect(
      await runCpBulk([], act, { waitMs: 1_000, failureReason: reason }),
    ).toEqual({ matched: [], succeeded: [], failed: [] });
    expect(act).not.toHaveBeenCalled();
  });

  it("starts every action before any finishes", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const pending = runCpBulk(
      ["A", "B"],
      (cpId) => {
        started.push(cpId);
        return new Promise<void>((resolve) => release.push(resolve));
      },
      { waitMs: 1_000, failureReason: reason },
    );

    expect(started).toEqual(["A", "B"]);
    release.forEach((resolve) => resolve());
    expect((await pending).succeeded).toEqual(["A", "B"]);
  });

  it("fails a charge point whose action outlasts the wait, without waiting for it", async () => {
    vi.useFakeTimers();
    let rejectLate: (err: Error) => void = () => {};
    const pending = runCpBulk(
      ["SLOW", "FAST"],
      (cpId) =>
        cpId === "FAST"
          ? Promise.resolve()
          : new Promise<void>((_resolve, reject) => {
              rejectLate = reject;
            }),
      { waitMs: 10_000, failureReason: reason },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result.succeeded).toEqual(["FAST"]);
    expect(result.failed).toEqual([
      { cpId: "SLOW", reason: "no outcome within 10000 ms; still running" },
    ]);
    // The connect keeps running; its eventual rejection must stay handled.
    rejectLate(new Error("Connection timeout (30s)"));
    await vi.advanceTimersByTimeAsync(0);
  });
});
