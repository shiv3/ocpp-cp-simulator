import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NetworkSimPipeline,
  PIPELINE_BUDGET,
  type Settlement,
} from "../NetworkSimPipeline";

describe("NetworkSimPipeline", () => {
  const queuedBytes = (pipeline: NetworkSimPipeline): number =>
    (
      pipeline as unknown as {
        queuedBytes: number;
      }
    ).queuedBytes;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves FIFO when a delayed head blocks an earlier-due follower", () => {
    const sink = vi.fn();
    const pipeline = new NetworkSimPipeline(sink);

    expect(pipeline.enqueue("A", 500)).toBe(true);
    expect(pipeline.enqueue("B", 10)).toBe(true);
    expect(pipeline.size).toBe(2);

    vi.advanceTimersByTime(499);
    expect(sink).not.toHaveBeenCalled();
    expect(pipeline.size).toBe(2);

    vi.advanceTimersByTime(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenLastCalledWith("A");
    expect(pipeline.size).toBe(1);

    vi.runOnlyPendingTimers();
    expect(sink.mock.calls.map(([raw]) => raw)).toEqual(["A", "B"]);
    expect(pipeline.size).toBe(0);
  });

  it("writes and settles a zero-delay frame synchronously on an empty queue", () => {
    const events: string[] = [];
    const sink = vi.fn((raw: string) => {
      events.push(`sink:${raw}`);
    });
    const pipeline = new NetworkSimPipeline(sink);

    expect(
      pipeline.enqueue("A", 0, (settlement) => {
        events.push(`settled:${settlement.outcome}`);
      }),
    ).toBe(true);

    expect(events).toEqual(["sink:A", "settled:written"]);
    expect(pipeline.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("queues a zero-delay frame behind a delayed head", () => {
    const sink = vi.fn();
    const pipeline = new NetworkSimPipeline(sink);

    pipeline.enqueue("A", 100);
    pipeline.enqueue("B", 0);

    expect(sink).not.toHaveBeenCalled();
    expect(pipeline.size).toBe(2);

    vi.advanceTimersByTime(100);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenLastCalledWith("A");
    expect(pipeline.size).toBe(1);

    vi.runOnlyPendingTimers();
    expect(sink.mock.calls.map(([raw]) => raw)).toEqual(["A", "B"]);
    expect(pipeline.size).toBe(0);
  });

  it("settles each accepted frame exactly once", () => {
    const first = vi.fn();
    const second = vi.fn();
    const pipeline = new NetworkSimPipeline(vi.fn());

    pipeline.enqueue("A", 20, first);
    pipeline.enqueue("B", 20, second);
    vi.runAllTimers();

    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith({ outcome: "written" });
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith({ outcome: "written" });
    expect(pipeline.size).toBe(0);

    pipeline.shutdown({ reason: "disposed" });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("settles a throwing sink as write_failed and continues the queue", () => {
    const settlements: Settlement[] = [];
    const sink = vi.fn((raw: string) => {
      if (raw === "A") {
        throw new Error("write failed");
      }
    });
    const pipeline = new NetworkSimPipeline(sink);

    pipeline.enqueue("A", 10, (settlement) => settlements.push(settlement));
    pipeline.enqueue("B", 10, (settlement) => settlements.push(settlement));
    vi.runAllTimers();

    expect(sink.mock.calls.map(([raw]) => raw)).toEqual(["A", "B"]);
    expect(settlements).toEqual([
      { outcome: "write_failed" },
      { outcome: "written" },
    ]);
    expect(pipeline.size).toBe(0);
  });

  it("discards a callback-less frame exactly once when its sink throws", () => {
    const onDiscard = vi.fn();
    const pipeline = new NetworkSimPipeline(
      () => {
        throw new Error("write failed");
      },
      { onDiscard },
    );

    expect(pipeline.enqueue("delayed", 10)).toBe(true);
    vi.runAllTimers();

    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledWith("delayed", {
      outcome: "write_failed",
    });

    onDiscard.mockClear();
    expect(pipeline.enqueue("synchronous", 0)).toBe(true);
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledWith("synchronous", {
      outcome: "write_failed",
    });
  });

  it("re-arms the head timer when wall time says the frame is not due", () => {
    const sink = vi.fn();
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_050)
      .mockReturnValue(1_100);
    const pipeline = new NetworkSimPipeline(sink);

    pipeline.enqueue("A", 100);
    vi.advanceTimersByTime(100);

    expect(sink).not.toHaveBeenCalled();
    expect(pipeline.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(49);
    expect(sink).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith("A");
    expect(pipeline.size).toBe(0);

    now.mockRestore();
  });

  it("isolates custody callback exceptions from later releases", () => {
    const second = vi.fn();
    const sink = vi.fn();
    const pipeline = new NetworkSimPipeline(sink);

    pipeline.enqueue("A", 10, () => {
      throw new Error("custody failed");
    });
    pipeline.enqueue("B", 20, second);

    expect(() => vi.runAllTimers()).not.toThrow();
    expect(sink.mock.calls.map(([raw]) => raw)).toEqual(["A", "B"]);
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith({ outcome: "written" });
    expect(pipeline.size).toBe(0);
  });

  it("drains shutdown settlements synchronously in FIFO order and cancels the timer", () => {
    const events: Array<[string, Settlement]> = [];
    const discarded: Array<[string, Settlement]> = [];
    const drainOrder: string[] = [];
    const sink = vi.fn();
    const pipeline = new NetworkSimPipeline(sink, {
      onDiscard: (raw, settlement) => {
        drainOrder.push(raw);
        discarded.push([raw, settlement]);
      },
    });

    pipeline.enqueue("A", 100, (settlement) => {
      drainOrder.push("A");
      events.push(["A", settlement]);
    });
    pipeline.enqueue("B", 50);
    pipeline.enqueue("C", 0, (settlement) => {
      drainOrder.push("C");
      events.push(["C", settlement]);
    });
    expect(pipeline.size).toBe(3);
    expect(vi.getTimerCount()).toBe(1);

    pipeline.shutdown({
      reason: "socket_closed",
      closeCause: "simulated",
    });

    const shutdownSettlement = {
      outcome: "socket_closed",
      closeCause: "simulated",
    } as const;
    expect(events).toEqual([
      ["A", shutdownSettlement],
      ["C", shutdownSettlement],
    ]);
    expect(discarded).toEqual([["B", shutdownSettlement]]);
    expect(drainOrder).toEqual(["A", "B", "C"]);
    expect(pipeline.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    vi.runAllTimers();
    expect(sink).not.toHaveBeenCalled();
  });

  it("isolates a throwing shutdown callback and drains every frame exactly once", () => {
    const first = vi.fn(() => {
      throw new Error("custody failed");
    });
    const second = vi.fn();
    const onDiscard = vi.fn();
    const pipeline = new NetworkSimPipeline(vi.fn(), { onDiscard });

    pipeline.enqueue("A", 100, first);
    pipeline.enqueue("B", 100, second);
    pipeline.enqueue("C", 100);

    expect(() => pipeline.shutdown({ reason: "disposed" })).not.toThrow();

    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith({ outcome: "disposed" });
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith({ outcome: "disposed" });
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledWith("C", { outcome: "disposed" });
    expect(queuedBytes(pipeline)).toBe(0);
    expect(pipeline.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects enqueue after shutdown without settlement", () => {
    const onSettled = vi.fn();
    const pipeline = new NetworkSimPipeline(vi.fn());

    pipeline.shutdown({ reason: "disposed" });

    expect(pipeline.enqueue("A", 0, onSettled)).toBe(false);
    expect(onSettled).not.toHaveBeenCalled();
    expect(pipeline.size).toBe(0);
  });

  it("rejects a frame beyond the frame-count budget without settlement", () => {
    const overflowSettlement = vi.fn();
    const pipeline = new NetworkSimPipeline(vi.fn());

    for (let index = 0; index < PIPELINE_BUDGET.maxFrames; index += 1) {
      expect(pipeline.enqueue(`${index}`, 1_000)).toBe(true);
    }

    expect(pipeline.size).toBe(PIPELINE_BUDGET.maxFrames);
    expect(pipeline.enqueue("overflow", 1_000, overflowSettlement)).toBe(false);
    expect(overflowSettlement).not.toHaveBeenCalled();
    expect(pipeline.size).toBe(PIPELINE_BUDGET.maxFrames);
  });

  it("uses UTF-8 bytes for the queued-byte budget", () => {
    const overflowSettlement = vi.fn();
    const pipeline = new NetworkSimPipeline(vi.fn());
    const almostFull = "a".repeat(PIPELINE_BUDGET.maxBytes - 2);
    const multiByte = "界";

    expect(multiByte.length).toBe(1);
    expect(new TextEncoder().encode(multiByte).byteLength).toBe(3);
    expect(pipeline.enqueue(almostFull, 1_000)).toBe(true);
    expect(pipeline.size).toBe(1);

    expect(pipeline.enqueue(multiByte, 1_000, overflowSettlement)).toBe(false);
    expect(overflowSettlement).not.toHaveBeenCalled();
    expect(pipeline.size).toBe(1);
  });

  it("reclaims queued bytes after a successful release", () => {
    const nearLimit = "a".repeat(PIPELINE_BUDGET.maxBytes - 1);
    const pipeline = new NetworkSimPipeline(vi.fn());

    expect(pipeline.enqueue(nearLimit, 10)).toBe(true);
    expect(queuedBytes(pipeline)).toBe(PIPELINE_BUDGET.maxBytes - 1);
    vi.runAllTimers();
    expect(queuedBytes(pipeline)).toBe(0);

    expect(pipeline.enqueue(nearLimit, 10)).toBe(true);
  });

  it("reclaims queued bytes after a write_failed release", () => {
    const nearLimit = "a".repeat(PIPELINE_BUDGET.maxBytes - 1);
    const onDiscard = vi.fn();
    const pipeline = new NetworkSimPipeline(
      () => {
        throw new Error("write failed");
      },
      { onDiscard },
    );

    expect(pipeline.enqueue(nearLimit, 10)).toBe(true);
    vi.runAllTimers();
    expect(queuedBytes(pipeline)).toBe(0);
    expect(onDiscard).toHaveBeenCalledOnce();

    expect(pipeline.enqueue(nearLimit, 10)).toBe(true);
  });

  it("reclaims queued bytes during shutdown drain", () => {
    const nearLimit = "a".repeat(PIPELINE_BUDGET.maxBytes - 1);
    const pipeline = new NetworkSimPipeline(vi.fn());

    expect(pipeline.enqueue(nearLimit, 10)).toBe(true);
    pipeline.shutdown({ reason: "disposed" });

    expect(queuedBytes(pipeline)).toBe(0);
    expect(pipeline.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a sustained flood bounded by the frame budget", () => {
    const pipeline = new NetworkSimPipeline(vi.fn());
    let accepted = 0;

    for (let index = 0; index < 10_000; index += 1) {
      if (pipeline.enqueue(`${index}`, 60_000)) {
        accepted += 1;
      }
      expect(pipeline.size).toBeLessThanOrEqual(PIPELINE_BUDGET.maxFrames);
    }

    expect(accepted).toBe(PIPELINE_BUDGET.maxFrames);
    expect(pipeline.size).toBe(PIPELINE_BUDGET.maxFrames);
  });
});
