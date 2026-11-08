import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  ResponseEffectQueue,
  type EffectDropReason,
  type ResponseEffectQueueDeps,
} from "../ResponseEffectQueue";
import type { CloseCause } from "../NetworkSimPipeline";
import type { GenerationToken } from "../NetworkSimController";

const gen = (
  n: number,
  closeCause: CloseCause | null = null,
): GenerationToken => ({
  gen: n,
  closeCause,
});

class Deps implements ResponseEffectQueueDeps {
  deferred: Array<() => void> = [];
  current = 1;
  isGenerationCurrent(g: GenerationToken): boolean {
    return g.gen === this.current;
  }
  defer(run: () => void): void {
    this.deferred.push(run);
  }
  log(): void {}
  runDeferred(): void {
    while (this.deferred.length > 0) this.deferred.shift()!();
  }
}

describe("ResponseEffectQueue onDropped", () => {
  let deps: Deps;
  let queue: ResponseEffectQueue;
  let dropped: EffectDropReason[];
  let effect: Mock<() => void>;
  const onDropped = (reason: EffectDropReason) => dropped.push(reason);

  beforeEach(() => {
    deps = new Deps();
    queue = new ResponseEffectQueue(deps);
    dropped = [];
    effect = vi.fn<() => void>();
  });

  it("is not called for an effect that runs", () => {
    queue.register(gen(1), effect, onDropped)({ outcome: "written" });
    deps.runDeferred();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(dropped).toEqual([]);
  });

  it("is not called for an effect that throws", () => {
    const boom = vi.fn<() => void>(() => {
      throw new Error("boom");
    });
    queue.register(gen(1), boom, onDropped)({ outcome: "written" });
    deps.runDeferred();
    expect(boom).toHaveBeenCalledTimes(1);
    expect(dropped).toEqual([]);
  });

  it("reports stale when the generation was superseded before the effect ran", () => {
    queue.register(gen(1), effect, onDropped)({ outcome: "written" });
    deps.current = 2;
    deps.runDeferred();
    expect(effect).not.toHaveBeenCalled();
    expect(dropped).toEqual(["stale"]);
  });

  it("reports stale for write_failed and queue_overflow that went stale", () => {
    queue.register(gen(1), effect, onDropped)({ outcome: "write_failed" });
    queue.register(gen(1), effect, onDropped)({ outcome: "queue_overflow" });
    deps.current = 2;
    deps.runDeferred();
    expect(dropped).toEqual(["stale", "stale"]);
  });

  it("reports disposed at once, and never runs the effect", () => {
    queue.register(gen(1), effect, onDropped)({ outcome: "disposed" });
    deps.runDeferred();
    expect(effect).not.toHaveBeenCalled();
    expect(dropped).toEqual(["disposed"]);
  });

  it("reports disconnect for a held effect when the station closed it itself", () => {
    const g = gen(1, "manual");
    queue.register(g, effect, onDropped)({ outcome: "socket_closed" });
    expect(dropped).toEqual([]);
    queue.flushAfterCloseFinalization(g);
    deps.runDeferred();
    expect(effect).not.toHaveBeenCalled();
    expect(dropped).toEqual(["disconnect"]);
  });

  it("reports stale for a held effect whose generation moved on by the flush", () => {
    const g = gen(1, "network");
    queue.register(g, effect, onDropped)({ outcome: "socket_closed" });
    deps.current = 2;
    queue.flushAfterCloseFinalization(g);
    deps.runDeferred();
    expect(dropped).toEqual(["stale"]);
  });

  it("does not report a held effect that runs after a network close", () => {
    const g = gen(1, "network");
    queue.register(g, effect, onDropped)({ outcome: "socket_closed" });
    queue.flushAfterCloseFinalization(g);
    deps.runDeferred();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(dropped).toEqual([]);
  });

  it("reports a late-registered effect on a finalized generation", () => {
    const manual = gen(1, "manual");
    queue.flushAfterCloseFinalization(manual);
    queue.register(manual, effect, onDropped)({ outcome: "socket_closed" });
    expect(dropped).toEqual(["disconnect"]);

    const network = gen(2, "network");
    queue.flushAfterCloseFinalization(network);
    queue.register(network, effect, onDropped)({ outcome: "socket_closed" });
    deps.current = 3;
    deps.runDeferred();
    expect(dropped).toEqual(["disconnect", "stale"]);
  });

  it("a throwing onDropped does not break the queue", () => {
    const other = vi.fn<() => void>();
    queue.register(gen(1), effect, () => {
      throw new Error("handler");
    })({ outcome: "disposed" });
    queue.register(gen(1), other)({ outcome: "written" });
    deps.runDeferred();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("existing callers are unaffected: no onDropped, every path still works", () => {
    queue.register(gen(1), effect)({ outcome: "disposed" });
    queue.register(gen(1), effect)({ outcome: "written" });
    deps.current = 2;
    deps.runDeferred();
    expect(effect).not.toHaveBeenCalled();
  });
});
