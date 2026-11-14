import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NetworkSimController,
  type ControllerHost,
} from "../NetworkSimController";
import { PIPELINE_BUDGET, type Settlement } from "../NetworkSimPipeline";

/**
 * #930: byte-aware throughput caps. A frame occupies the link for
 * bytes/cap seconds, one at a time per direction, so larger frames are
 * delayed more, in order, and independently of the latency rules.
 */
const frame = (id: string, size: number) =>
  JSON.stringify([2, id, "MeterValues", { pad: "x".repeat(size) }]);
const bytes = (raw: string) => new TextEncoder().encode(raw).byteLength;

function setup() {
  const written: Array<{ raw: string; at: number }> = [];
  const dispatched: Array<{ raw: string; at: number }> = [];
  const logs: string[] = [];
  const host: ControllerHost = {
    writeUpstream: (raw) => written.push({ raw, at: Date.now() }),
    dispatchDownstream: (raw) => dispatched.push({ raw, at: Date.now() }),
    requestSimulatedDisconnect: () => {},
    log: (m) => logs.push(m),
  };
  const controller = new NetworkSimController(host, "CP-1");
  controller.onSocketOpen();
  return { controller, written, dispatched, logs };
}

describe("NetworkSimController bandwidth (#930)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("is a no-op without a cap: frames go out synchronously", () => {
    const { controller, written } = setup();
    controller.sendUpstream(frame("a", 100));
    expect(written).toHaveLength(1);
  });

  it("delays frames by their size, in order, one at a time", () => {
    const { controller, written } = setup();
    controller.setBandwidthLimits({
      upstreamBytesPerSecond: 1000,
      downstreamBytesPerSecond: null,
    });
    const a = frame("a", 400);
    const b = frame("b", 100);
    const c = frame("c", 900);
    const t0 = Date.now();
    for (const raw of [a, b, c]) controller.sendUpstream(raw);
    expect(written).toHaveLength(0);
    const finish = [a, b, c].reduce<number[]>((acc, raw) => {
      const prev = acc.at(-1) ?? t0;
      acc.push(prev + Math.ceil((bytes(raw) * 1000) / 1000));
      return acc;
    }, []);
    vi.advanceTimersByTime(finish[0] - t0 - 1);
    expect(written).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(written.map((w) => JSON.parse(w.raw)[1])).toEqual(["a"]);
    vi.advanceTimersByTime(finish[1] - finish[0]);
    vi.advanceTimersByTime(finish[2] - finish[1]);
    expect(written.map((w) => JSON.parse(w.raw)[1])).toEqual(["a", "b", "c"]);
    expect(written.map((w) => w.at)).toEqual(finish);
    // The small frame behind a large one waited its turn: order, not size, decides.
    expect(finish[1] - finish[0]).toBe(bytes(b));
  });

  it("caps each direction independently and downstream frames are dispatched late", () => {
    const { controller, written, dispatched } = setup();
    controller.setBandwidthLimits({
      upstreamBytesPerSecond: null,
      downstreamBytesPerSecond: 500,
    });
    const raw = frame("d", 250);
    controller.sendUpstream(raw);
    expect(written).toHaveLength(1);
    controller.receiveDownstream(raw);
    expect(dispatched).toHaveLength(0);
    vi.advanceTimersByTime(Math.ceil((bytes(raw) * 1000) / 500));
    expect(dispatched).toHaveLength(1);
  });

  it("adds to latency rules instead of replacing them", () => {
    const { controller, written } = setup();
    controller.applyConfig({
      enabled: true,
      seed: 1,
      rules: {
        slow: {
          type: "latency",
          direction: "upstream",
          delayMs: 300,
          jitterMs: 0,
        },
      },
    } as never);
    controller.setBandwidthLimits({
      upstreamBytesPerSecond: 1000,
      downstreamBytesPerSecond: null,
    });
    const raw = frame("a", 200);
    controller.sendUpstream(raw);
    vi.advanceTimersByTime(300 + bytes(raw) - 1);
    expect(written).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(written).toHaveLength(1);
  });

  it("is in force while the latency simulation is disabled", () => {
    const { controller, written } = setup();
    controller.applyConfig({ enabled: false, seed: 1, rules: {} } as never);
    controller.setBandwidthLimits({
      upstreamBytesPerSecond: 100,
      downstreamBytesPerSecond: null,
    });
    controller.sendUpstream(frame("a", 100));
    expect(written).toHaveLength(0);
  });

  it("rejects explicitly when the bounded queue is full", () => {
    const { controller } = setup();
    controller.setBandwidthLimits({
      upstreamBytesPerSecond: 1,
      downstreamBytesPerSecond: null,
    });
    const accepted: boolean[] = [];
    for (let i = 0; i < PIPELINE_BUDGET.maxFrames + 5; i++) {
      accepted.push(controller.sendUpstream(frame(String(i), 1)));
    }
    expect(accepted.filter(Boolean)).toHaveLength(PIPELINE_BUDGET.maxFrames);
    expect(accepted.slice(PIPELINE_BUDGET.maxFrames)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("settles queued frames as socket_closed when the link goes down (cancellation)", () => {
    const { controller, written } = setup();
    controller.setBandwidthLimits({
      upstreamBytesPerSecond: 10,
      downstreamBytesPerSecond: null,
    });
    const settled: Settlement[] = [];
    controller.sendUpstream(frame("a", 100), (s) => settled.push(s));
    controller.sendUpstream(frame("b", 100), (s) => settled.push(s));
    controller.shutdownPipelines({
      reason: "socket_closed",
      closeCause: "simulated",
    });
    expect(settled).toEqual([
      { outcome: "socket_closed", closeCause: "simulated" },
      { outcome: "socket_closed", closeCause: "simulated" },
    ]);
    vi.advanceTimersByTime(60_000);
    expect(written).toHaveLength(0);
  });

  it("a new limit starts from an idle link and removing it restores direct sends", () => {
    const { controller, written } = setup();
    controller.setBandwidthLimits({
      upstreamBytesPerSecond: 100,
      downstreamBytesPerSecond: null,
    });
    controller.sendUpstream(frame("a", 1000));
    controller.setBandwidthLimits({
      upstreamBytesPerSecond: null,
      downstreamBytesPerSecond: null,
    });
    controller.sendUpstream(frame("b", 10));
    // "b" queues behind "a" (FIFO is kept), then both are released.
    vi.advanceTimersByTime(60_000);
    expect(written.map((w) => JSON.parse(w.raw)[1])).toEqual(["a", "b"]);
  });
});
