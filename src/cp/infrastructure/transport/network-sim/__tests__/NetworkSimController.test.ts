import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NetworkSimController,
  type ControllerHost,
} from "../NetworkSimController";
import { PIPELINE_BUDGET } from "../NetworkSimPipeline";
import { MAX_TIMER_MS, type ResolvedNetworkSimConfig } from "../config";

const disabledConfig = (): ResolvedNetworkSimConfig => ({
  enabled: false,
  seed: 1,
  rules: {},
});

const enabledConfig = (
  rules: ResolvedNetworkSimConfig["rules"] = {},
  seed = 1,
): ResolvedNetworkSimConfig => ({
  enabled: true,
  seed,
  rules,
});

const makeHost = () =>
  ({
    writeUpstream: vi.fn<(raw: string) => void>(),
    dispatchDownstream: vi.fn<(raw: string) => void>(),
    requestSimulatedDisconnect:
      vi.fn<(reconnectDelayMs: number, ruleId: string) => void>(),
    log: vi.fn<(message: string) => void>(),
  }) satisfies ControllerHost;

describe("NetworkSimController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses a synchronous timer-free fast path before config and when disabled", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    const settlements: string[] = [];

    expect(
      controller.sendUpstream("before", (settlement) => {
        settlements.push(settlement.outcome);
      }),
    ).toBe(true);
    controller.receiveDownstream("before-down");
    controller.applyConfig(disabledConfig());
    expect(
      controller.sendUpstream("disabled", (settlement) => {
        settlements.push(settlement.outcome);
      }),
    ).toBe(true);
    controller.receiveDownstream("disabled-down");

    expect(host.writeUpstream.mock.calls).toEqual([["before"], ["disabled"]]);
    expect(host.dispatchDownstream.mock.calls).toEqual([
      ["before-down"],
      ["disabled-down"],
    ]);
    expect(settlements).toEqual(["written", "written"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies upstream latency before writing and settles on release", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    const onSettled = vi.fn();
    controller.applyConfig(
      enabledConfig({
        boot: {
          type: "latency",
          direction: "upstream",
          match: { actions: ["BootNotification"] },
          delayMs: 250,
        },
      }),
    );

    const raw = JSON.stringify([2, "id", "BootNotification", {}]);
    expect(controller.sendUpstream(raw, onSettled)).toBe(true);
    expect(host.writeUpstream).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(host.writeUpstream).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(host.writeUpstream).toHaveBeenCalledWith(raw);
    expect(onSettled).toHaveBeenCalledWith({ outcome: "written" });
  });

  it("applies downstream latency before dispatch", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        reset: {
          type: "latency",
          direction: "downstream",
          delayMs: 40,
        },
      }),
    );

    controller.receiveDownstream("raw");
    expect(host.dispatchDownstream).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(host.dispatchDownstream).toHaveBeenCalledWith("raw");
  });

  it("restarts per-rule RNG sequences whenever config is applied", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    const config = enabledConfig(
      {
        jittered: {
          type: "latency",
          delayMs: 10,
          jitterMs: 100,
        },
      },
      42,
    );

    controller.applyConfig(config);
    controller.sendUpstream("first");
    const firstDelay = vi.getTimerCount();
    vi.runAllTimers();
    const firstWriteAt = Date.now();

    vi.setSystemTime(2_000);
    controller.applyConfig(config);
    controller.sendUpstream("second");
    expect(vi.getTimerCount()).toBe(firstDelay);
    vi.runAllTimers();

    expect(Date.now() - 2_000).toBe(firstWriteAt - 1_000);
  });

  it("produces identical periodic firing schedules for the same seed", () => {
    const firstHost = makeHost();
    const secondHost = makeHost();
    const firstTimes: number[] = [];
    const secondTimes: number[] = [];
    firstHost.requestSimulatedDisconnect.mockImplementation(() => {
      firstTimes.push(Date.now());
    });
    secondHost.requestSimulatedDisconnect.mockImplementation(() => {
      secondTimes.push(Date.now());
    });
    const config = enabledConfig(
      {
        periodic: {
          type: "periodic-disconnect",
          intervalMs: 100,
          intervalJitterMs: 50,
          reconnectDelayMs: 25,
        },
      },
      1234,
    );
    const first = new NetworkSimController(firstHost, "CP-A");
    const second = new NetworkSimController(secondHost, "CP-A");

    first.applyConfig(config);
    second.applyConfig(config);
    for (let session = 0; session < 3; session += 1) {
      first.onSocketOpen();
      second.onSocketOpen();
      vi.advanceTimersByTime(1_000);
    }

    expect(firstTimes.length).toBeGreaterThan(2);
    expect(secondTimes).toEqual(firstTimes);
  });

  it("keeps jittered periodic RNG streams independent across add, remove, and reorder", () => {
    const target = {
      type: "periodic-disconnect" as const,
      intervalMs: 100,
      intervalJitterMs: 500,
      reconnectDelayMs: 1,
    };
    const other = {
      type: "periodic-disconnect" as const,
      intervalMs: 10_000,
      intervalJitterMs: 500,
      reconnectDelayMs: 2,
    };
    const scheduledTargetIntervals = (
      rules: ResolvedNetworkSimConfig["rules"],
      targetCallIndex: number,
    ): number[] => {
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const controller = new NetworkSimController(makeHost(), "CP-001");
      controller.applyConfig(enabledConfig(rules, 9876));
      const intervals: number[] = [];

      for (let session = 0; session < 4; session += 1) {
        const callsBeforeOpen = timeoutSpy.mock.calls.length;
        controller.onSocketOpen();
        const armCalls = timeoutSpy.mock.calls.slice(callsBeforeOpen);
        intervals.push(Number(armCalls[targetCallIndex]?.[1]));
        controller.shutdownPipelines({
          reason: "socket_closed",
          closeCause: "simulated",
        });
      }
      timeoutSpy.mockRestore();
      return intervals;
    };

    const targetOnly = scheduledTargetIntervals({ target }, 0);
    const targetThenOther = scheduledTargetIntervals({ target, other }, 0);
    const otherThenTarget = scheduledTargetIntervals({ other, target }, 1);

    expect(targetThenOther).toEqual(targetOnly);
    expect(otherThenTarget).toEqual(targetOnly);
    expect(new Set(targetOnly).size).toBeGreaterThan(1);
  });

  it("restarts periodic jitter RNG sequences whenever config is applied", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    const config = enabledConfig(
      {
        periodic: {
          type: "periodic-disconnect",
          intervalMs: 100,
          intervalJitterMs: 500,
          reconnectDelayMs: 1,
        },
      },
      2468,
    );

    controller.applyConfig(config);
    controller.onSocketOpen();
    const firstInterval =
      timeoutSpy.mock.calls[timeoutSpy.mock.calls.length - 1]?.[1];

    controller.applyConfig(config);
    const restartedInterval =
      timeoutSpy.mock.calls[timeoutSpy.mock.calls.length - 1]?.[1];

    expect(restartedInterval).toBe(firstInterval);
  });

  it("collapses coincident periodic rules when the first request closes the socket", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    host.requestSimulatedDisconnect.mockImplementationOnce(() => {
      controller.shutdownPipelines({
        reason: "socket_closed",
        closeCause: "simulated",
      });
    });
    controller.applyConfig(
      enabledConfig({
        first: {
          type: "periodic-disconnect",
          intervalMs: 100,
          reconnectDelayMs: 1,
        },
        second: {
          type: "periodic-disconnect",
          intervalMs: 100,
          reconnectDelayMs: 2,
        },
      }),
    );
    controller.onSocketOpen();

    vi.advanceTimersByTime(100);

    expect(host.requestSimulatedDisconnect.mock.calls).toEqual([[1, "first"]]);
  });

  it("requests one coincident periodic disconnect per session and resets on reopen", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        first: {
          type: "periodic-disconnect",
          intervalMs: 100,
          reconnectDelayMs: 1,
        },
        second: {
          type: "periodic-disconnect",
          intervalMs: 100,
          reconnectDelayMs: 2,
        },
      }),
    );
    controller.onSocketOpen();

    vi.advanceTimersByTime(100);
    expect(host.requestSimulatedDisconnect.mock.calls).toEqual([[1, "first"]]);
    expect(vi.getTimerCount()).toBe(0);

    controller.shutdownPipelines({
      reason: "socket_closed",
      closeCause: "simulated",
    });
    controller.onSocketOpen();
    vi.advanceTimersByTime(100);

    expect(host.requestSimulatedDisconnect.mock.calls).toEqual([
      [1, "first"],
      [1, "first"],
    ]);
  });

  it("caps a periodic interval plus jitter at MAX_TIMER_MS across sessions", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        saturated: {
          type: "periodic-disconnect",
          intervalMs: MAX_TIMER_MS,
          intervalJitterMs: MAX_TIMER_MS,
          reconnectDelayMs: 0,
        },
      }),
    );

    controller.onSocketOpen();

    expect(timeoutSpy).toHaveBeenCalledOnce();
    expect(timeoutSpy.mock.calls[0]?.[1]).toBe(MAX_TIMER_MS);
    controller.shutdownPipelines({
      reason: "socket_closed",
      closeCause: "simulated",
    });
    controller.onSocketOpen();
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy.mock.calls[1]?.[1]).toBe(MAX_TIMER_MS);
  });

  it("arms timers only while the socket is open", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        periodic: {
          type: "periodic-disconnect",
          intervalMs: 100,
          reconnectDelayMs: 0,
        },
      }),
    );

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(500);
    expect(host.requestSimulatedDisconnect).not.toHaveBeenCalled();

    controller.onSocketOpen();
    expect(vi.getTimerCount()).toBe(1);
    controller.shutdownPipelines({
      reason: "socket_closed",
      closeCause: "network",
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(500);
    expect(host.requestSimulatedDisconnect).not.toHaveBeenCalled();
  });

  it("does not arm periodic timers when a disabled socket opens", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(disabledConfig());

    controller.onSocketOpen();
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(host.requestSimulatedDisconnect).not.toHaveBeenCalled();
  });

  it("keeps queued frame deadlines while applying new rules to future frames", () => {
    const host = makeHost();
    const writes: Array<[string, number]> = [];
    host.writeUpstream.mockImplementation((raw: string) => {
      writes.push([raw, Date.now()]);
    });
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        old: { type: "latency", delayMs: 20 },
      }),
    );
    controller.sendUpstream("old");

    controller.applyConfig(
      enabledConfig({
        replacement: { type: "latency", delayMs: 100 },
      }),
    );
    controller.sendUpstream("new");

    vi.advanceTimersByTime(100);
    expect(writes).toEqual([
      ["old", 1_020],
      ["new", 1_100],
    ]);
  });

  it("cancels and re-derives every periodic timer on config apply", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        oldA: {
          type: "periodic-disconnect",
          intervalMs: 100,
          reconnectDelayMs: 1,
        },
        oldB: {
          type: "periodic-disconnect",
          intervalMs: 150,
          reconnectDelayMs: 2,
        },
      }),
    );
    controller.onSocketOpen();
    vi.advanceTimersByTime(50);

    controller.applyConfig(
      enabledConfig({
        replacement: {
          type: "periodic-disconnect",
          intervalMs: 200,
          reconnectDelayMs: 3,
        },
      }),
    );
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(199);
    expect(host.requestSimulatedDisconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.requestSimulatedDisconnect).toHaveBeenCalledOnce();
    expect(host.requestSimulatedDisconnect).toHaveBeenCalledWith(
      3,
      "replacement",
    );
  });

  it("re-arms periodic schedules only after close and reopen", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        first: {
          type: "periodic-disconnect",
          intervalMs: 100,
          reconnectDelayMs: 1,
        },
        second: {
          type: "periodic-disconnect",
          intervalMs: 200,
          reconnectDelayMs: 2,
        },
      }),
    );
    controller.onSocketOpen();
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(100);
    expect(host.requestSimulatedDisconnect.mock.calls).toEqual([[1, "first"]]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(host.requestSimulatedDisconnect.mock.calls).toEqual([[1, "first"]]);
    expect(vi.getTimerCount()).toBe(0);

    controller.shutdownPipelines({
      reason: "socket_closed",
      closeCause: "simulated",
    });
    controller.onSocketOpen();
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(100);

    expect(host.requestSimulatedDisconnect.mock.calls).toEqual([
      [1, "first"],
      [1, "first"],
    ]);
  });

  it("creates usable pipelines for a reopened socket", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        latency: { type: "latency", delayMs: 10 },
      }),
    );
    controller.onSocketOpen();
    controller.shutdownPipelines({
      reason: "socket_closed",
      closeCause: "network",
    });
    controller.onSocketOpen();

    expect(controller.sendUpstream("new-generation")).toBe(true);
    vi.advanceTimersByTime(10);
    expect(host.writeUpstream).toHaveBeenCalledWith("new-generation");
  });

  it("logs downstream discards during shutdown", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        latency: { type: "latency", delayMs: 100 },
      }),
    );
    controller.receiveDownstream("queued");

    controller.shutdownPipelines({
      reason: "socket_closed",
      closeCause: "simulated",
    });

    // Expects 2 calls: one for latency log, one for shutdown discard log
    expect(host.log).toHaveBeenCalledTimes(2);
    // First call is latency log (delay > 0)
    expect(host.log.mock.calls[0]?.[0]).toContain("LATENCY");
    // Second call is shutdown discard log
    expect(host.log.mock.calls[1]?.[0]).toContain("socket_closed");
  });

  it("logs a downstream frame discarded by queue overflow", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        latency: {
          type: "latency",
          direction: "downstream",
          delayMs: 100_000,
        },
      }),
    );

    for (let index = 0; index <= PIPELINE_BUDGET.maxFrames; index += 1) {
      controller.receiveDownstream(`queued-${index}`);
    }

    expect(host.dispatchDownstream).not.toHaveBeenCalled();
    // Loop runs 513 times (0 to 512 inclusive), each produces a latency log,
    // plus the 513th call also produces a queue_overflow log = 514 total
    expect(host.log).toHaveBeenCalledTimes(PIPELINE_BUDGET.maxFrames + 2);
    // Check that the last call is the queue_overflow message
    expect(host.log.mock.calls[PIPELINE_BUDGET.maxFrames + 1]?.[0]).toContain(
      "Network simulation discarded downstream frame for CP-001: queue_overflow",
    );
  });

  it("cancels timers and drains queued work on dispose", () => {
    const host = makeHost();
    const settlement = vi.fn();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        latency: { type: "latency", delayMs: 100 },
        periodic: {
          type: "periodic-disconnect",
          intervalMs: 50,
          reconnectDelayMs: 0,
        },
      }),
    );
    controller.onSocketOpen();
    controller.sendUpstream("queued", settlement);

    controller.dispose();

    expect(settlement).toHaveBeenCalledWith({ outcome: "disposed" });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(500);
    expect(host.writeUpstream).not.toHaveBeenCalled();
    expect(host.requestSimulatedDisconnect).not.toHaveBeenCalled();
  });

  it("triggers a configured manual disconnect", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        manual: {
          type: "manual-disconnect",
          reconnectDelayMs: 750,
        },
      }),
    );

    expect(controller.triggerManualDisconnect("manual")).toEqual({ ok: true });
    expect(host.requestSimulatedDisconnect).toHaveBeenCalledWith(750, "manual");
  });

  it("treats repeated manual disconnects as successful session no-ops", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        manual: {
          type: "manual-disconnect",
          reconnectDelayMs: 750,
        },
      }),
    );
    controller.onSocketOpen();

    expect(controller.triggerManualDisconnect("manual")).toEqual({ ok: true });
    expect(controller.triggerManualDisconnect("manual")).toEqual({ ok: true });
    expect(host.requestSimulatedDisconnect).toHaveBeenCalledOnce();

    controller.shutdownPipelines({
      reason: "socket_closed",
      closeCause: "manual",
    });
    controller.onSocketOpen();
    expect(controller.triggerManualDisconnect("manual")).toEqual({ ok: true });
    expect(host.requestSimulatedDisconnect).toHaveBeenCalledTimes(2);
  });

  it("maps unknown and non-manual rule ids to rule_not_manual", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(
      enabledConfig({
        latency: { type: "latency", delayMs: 10 },
      }),
    );

    expect(controller.triggerManualDisconnect("missing")).toEqual({
      ok: false,
      error: "rule_not_manual",
    });
    expect(controller.triggerManualDisconnect("latency")).toEqual({
      ok: false,
      error: "rule_not_manual",
    });
    expect(host.requestSimulatedDisconnect).not.toHaveBeenCalled();
  });

  it("rejects manual disconnect while simulation is disabled", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(disabledConfig());

    expect(controller.triggerManualDisconnect("manual")).toEqual({
      ok: false,
      error: "sim_disabled",
    });
  });

  it("preserves FIFO ordering when frames are queued during disable: upstream", () => {
    const host = makeHost();
    const writes: Array<[string, number]> = [];
    host.writeUpstream.mockImplementation((raw: string) => {
      writes.push([raw, Date.now()]);
    });
    const controller = new NetworkSimController(host, "CP-001");

    // Enable with upstream latency rule (500ms delay)
    controller.applyConfig(
      enabledConfig({
        delay: {
          type: "latency",
          direction: "upstream",
          delayMs: 500,
        },
      }),
    );

    // Send frame A while enabled; it will be delayed 500ms
    controller.sendUpstream("frameA");
    expect(host.writeUpstream).not.toHaveBeenCalled();

    // Disable the simulation
    controller.applyConfig(disabledConfig());

    // Send frame B after disabling
    controller.sendUpstream("frameB");

    // Neither frame should have been written yet
    expect(host.writeUpstream).not.toHaveBeenCalled();

    // Run all timers to process both frame A (delayed 500ms) and frame B (0-delay but queued after A)
    vi.runAllTimers();

    // Both frames should have been written, in FIFO order
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[0]).toBe("frameA");
    expect(writes[1]?.[0]).toBe("frameB");

    // Frame B should not have been written before frame A
    expect(writes[0]![1]! <= writes[1]![1]!).toBe(true);
  });

  it("preserves FIFO ordering when frames are queued during disable: downstream", () => {
    const host = makeHost();
    const dispatches: Array<[string, number]> = [];
    host.dispatchDownstream.mockImplementation((raw: string) => {
      dispatches.push([raw, Date.now()]);
    });
    const controller = new NetworkSimController(host, "CP-001");

    // Enable with downstream latency rule (400ms delay)
    controller.applyConfig(
      enabledConfig({
        delay: {
          type: "latency",
          direction: "downstream",
          delayMs: 400,
        },
      }),
    );

    // Receive frame A while enabled; it will be delayed 400ms
    controller.receiveDownstream("frameA");
    expect(host.dispatchDownstream).not.toHaveBeenCalled();

    // Disable the simulation
    controller.applyConfig(disabledConfig());

    // Receive frame B after disabling
    controller.receiveDownstream("frameB");

    // Neither frame should have been dispatched yet
    expect(host.dispatchDownstream).not.toHaveBeenCalled();

    // Run all timers to process both frame A (delayed 400ms) and frame B (0-delay but queued after A)
    vi.runAllTimers();

    // Both frames should have been dispatched, in FIFO order
    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]?.[0]).toBe("frameA");
    expect(dispatches[1]?.[0]).toBe("frameB");

    // Frame B should not have been dispatched before frame A
    expect(dispatches[0]![1]! <= dispatches[1]![1]!).toBe(true);
  });

  it("keeps the disabled-empty-pipeline path synchronous", () => {
    const host = makeHost();
    const controller = new NetworkSimController(host, "CP-001");
    controller.applyConfig(disabledConfig());

    const upstreamSettlements: string[] = [];
    const downstreamLogCalls: string[] = [];
    host.log.mockImplementation((msg: string) => {
      downstreamLogCalls.push(msg);
    });

    // Send upstream with disabled config and empty pipeline
    const upstreamResult = controller.sendUpstream(
      "test-upstream",
      (settlement) => {
        upstreamSettlements.push(settlement.outcome);
      },
    );

    // Should return true and call writeUpstream synchronously
    expect(upstreamResult).toBe(true);
    expect(host.writeUpstream).toHaveBeenCalledWith("test-upstream");
    expect(upstreamSettlements).toEqual(["written"]);

    // No timers should have been set
    expect(vi.getTimerCount()).toBe(0);

    // Receive downstream with disabled config and empty pipeline
    controller.receiveDownstream("test-downstream");

    // Should call dispatchDownstream synchronously
    expect(host.dispatchDownstream).toHaveBeenCalledWith("test-downstream");

    // No timers should have been set
    expect(vi.getTimerCount()).toBe(0);
  });
});
