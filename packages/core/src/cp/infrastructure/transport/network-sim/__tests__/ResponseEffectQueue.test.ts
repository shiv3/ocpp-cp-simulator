import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ResponseEffectQueue,
  isHandlerOutcome,
  normalizeHandlerResult,
  type HandlerOutcome,
  type ResponseEffectQueueDeps,
} from "../ResponseEffectQueue";
import type { CloseCause } from "../NetworkSimPipeline";
import type { GenerationToken } from "../NetworkSimController";

// Helper to create a fake GenerationToken
function makeGen(
  gen: number,
  closeCause: CloseCause | null = null,
): GenerationToken {
  return { gen, closeCause };
}

// Fake deps implementation for testing
class FakeDeps implements ResponseEffectQueueDeps {
  deferredCallbacks: Array<() => void> = [];
  logs: string[] = [];
  currentGen: number = 0;

  isGenerationCurrent(gen: GenerationToken): boolean {
    return gen.gen === this.currentGen;
  }

  defer(run: () => void): void {
    this.deferredCallbacks.push(run);
  }

  log(message: string): void {
    this.logs.push(message);
  }

  runAllDeferred(): void {
    while (this.deferredCallbacks.length > 0) {
      const cb = this.deferredCallbacks.shift()!;
      cb();
    }
  }
}

describe("ResponseEffectQueue", () => {
  let deps: FakeDeps;
  let queue: ResponseEffectQueue;

  beforeEach(() => {
    deps = new FakeDeps();
    deps.currentGen = 1;
    queue = new ResponseEffectQueue(deps);
  });

  describe("isHandlerOutcome", () => {
    it("returns true for a valid HandlerOutcome", () => {
      const outcome: HandlerOutcome = {
        kind: "handler-outcome",
        payload: { status: "ok" },
        afterResponseSettled: () => {},
      };
      expect(isHandlerOutcome(outcome)).toBe(true);
    });

    it("returns false for null", () => {
      expect(isHandlerOutcome(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isHandlerOutcome(undefined)).toBe(false);
    });

    it("returns false for plain objects without kind", () => {
      expect(isHandlerOutcome({ payload: "test" })).toBe(false);
    });

    it("returns false for objects with wrong kind", () => {
      expect(isHandlerOutcome({ kind: "something-else" })).toBe(false);
    });
  });

  describe("normalizeHandlerResult", () => {
    it("normalizes a HandlerOutcome to payload and effect", () => {
      const effect = () => {};
      const outcome: HandlerOutcome = {
        kind: "handler-outcome",
        payload: { status: "ok" },
        afterResponseSettled: effect,
      };
      const result = normalizeHandlerResult(outcome);
      expect(result.payload).toEqual({ status: "ok" });
      expect(result.effect).toBe(effect);
    });

    it("normalizes a bare payload to payload with null effect", () => {
      const payload = { status: "ok" };
      const result = normalizeHandlerResult(payload);
      expect(result.payload).toEqual(payload);
      expect(result.effect).toBeNull();
    });

    it("treats null as payload with null effect", () => {
      const result = normalizeHandlerResult(null);
      expect(result.payload).toBeNull();
      expect(result.effect).toBeNull();
    });
  });

  describe("register and settlement outcomes", () => {
    it("defers effect on 'written' outcome when generation is current", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      hook({ outcome: "written" });

      // Effect should be deferred, not run yet
      expect(effectFn).not.toHaveBeenCalled();
      expect(deps.deferredCallbacks).toHaveLength(1);

      // Run deferred callbacks
      deps.runAllDeferred();

      // Now effect should have been run
      expect(effectFn).toHaveBeenCalled();
    });

    it("skips effect on 'written' outcome when generation is stale", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      // Advance current generation
      deps.currentGen = 2;

      hook({ outcome: "written" });

      // Run deferred callbacks
      deps.runAllDeferred();

      // Effect should not have been run (stale generation)
      expect(effectFn).not.toHaveBeenCalled();
      expect(
        deps.logs.some((log) => log.includes("skipped stale effect")),
      ).toBe(true);
    });

    it("defers effect on 'write_failed' outcome", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      hook({ outcome: "write_failed" });

      deps.runAllDeferred();

      expect(effectFn).toHaveBeenCalled();
    });

    it("defers effect on 'queue_overflow' outcome", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      hook({ outcome: "queue_overflow" });

      deps.runAllDeferred();

      expect(effectFn).toHaveBeenCalled();
    });

    it("holds effect on 'socket_closed' outcome without finalization", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      hook({ outcome: "socket_closed", closeCause: "network" });

      // Effect should not be deferred or run yet
      expect(effectFn).not.toHaveBeenCalled();
      expect(deps.deferredCallbacks).toHaveLength(0);
    });

    it("drops effect on 'disposed' outcome", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      hook({ outcome: "disposed" });

      deps.runAllDeferred();

      expect(effectFn).not.toHaveBeenCalled();
      expect(
        deps.logs.some((log) => log.includes("dropped effect for disposed")),
      ).toBe(true);
    });
  });

  describe("flushAfterCloseFinalization", () => {
    it("runs held effects for 'network' closeCause", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1, null);
      const hook = queue.register(gen, effectFn);

      // Hold the effect
      hook({ outcome: "socket_closed", closeCause: "network" });

      // Finalize with network cause
      queue.flushAfterCloseFinalization(makeGen(1, "network"));

      // Effect should be deferred, not run yet
      expect(effectFn).not.toHaveBeenCalled();

      // Run deferred callbacks
      deps.runAllDeferred();

      // Now effect should have been run
      expect(effectFn).toHaveBeenCalled();
    });

    it("runs held effects for 'simulated' closeCause", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      hook({ outcome: "socket_closed" });

      queue.flushAfterCloseFinalization(makeGen(1, "simulated"));

      deps.runAllDeferred();

      expect(effectFn).toHaveBeenCalled();
    });

    it("drops held effects for 'manual' closeCause", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      hook({ outcome: "socket_closed" });

      queue.flushAfterCloseFinalization(makeGen(1, "manual"));

      deps.runAllDeferred();

      expect(effectFn).not.toHaveBeenCalled();
      expect(
        deps.logs.some((log) => log.includes("dropped effect for manual")),
      ).toBe(true);
    });

    it("drops held effects for 'internal' closeCause", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      hook({ outcome: "socket_closed" });

      queue.flushAfterCloseFinalization(makeGen(1, "internal"));

      deps.runAllDeferred();

      expect(effectFn).not.toHaveBeenCalled();
      expect(
        deps.logs.some((log) => log.includes("dropped effect for internal")),
      ).toBe(true);
    });

    it("treats null closeCause as 'network' (defensive)", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      hook({ outcome: "socket_closed" });

      // Flush with null closeCause
      queue.flushAfterCloseFinalization(makeGen(1, null));

      deps.runAllDeferred();

      // Should run (treating as network)
      expect(effectFn).toHaveBeenCalled();
    });
  });

  describe("late registration after finalization", () => {
    it("resolves late socket_closed for 'network' closeCause immediately", () => {
      const effectFn = vi.fn();

      // First, finalize a generation
      queue.flushAfterCloseFinalization(makeGen(1, "network"));

      // Now register an effect for that generation (late registration)
      const hook = queue.register(makeGen(1, "network"), effectFn);
      hook({ outcome: "socket_closed", closeCause: "network" });

      // Effect should be deferred (not immediately run)
      expect(effectFn).not.toHaveBeenCalled();

      // Run deferred
      deps.runAllDeferred();

      // Should have been run
      expect(effectFn).toHaveBeenCalled();
    });

    it("resolves late socket_closed for 'simulated' closeCause immediately", () => {
      const effectFn = vi.fn();

      queue.flushAfterCloseFinalization(makeGen(1, "simulated"));

      const hook = queue.register(makeGen(1, "simulated"), effectFn);
      hook({ outcome: "socket_closed" });

      deps.runAllDeferred();

      expect(effectFn).toHaveBeenCalled();
    });

    it("drops late socket_closed for 'manual' closeCause", () => {
      const effectFn = vi.fn();

      queue.flushAfterCloseFinalization(makeGen(1, "manual"));

      const hook = queue.register(makeGen(1, "manual"), effectFn);
      hook({ outcome: "socket_closed" });

      deps.runAllDeferred();

      expect(effectFn).not.toHaveBeenCalled();
      expect(
        deps.logs.some((log) => log.includes("dropped late-registered effect")),
      ).toBe(true);
    });

    it("drops late socket_closed for 'internal' closeCause", () => {
      const effectFn = vi.fn();

      queue.flushAfterCloseFinalization(makeGen(1, "internal"));

      const hook = queue.register(makeGen(1, "internal"), effectFn);
      hook({ outcome: "socket_closed" });

      deps.runAllDeferred();

      expect(effectFn).not.toHaveBeenCalled();
      expect(
        deps.logs.some((log) => log.includes("dropped late-registered effect")),
      ).toBe(true);
    });
  });

  describe("exception isolation", () => {
    it("catches exceptions in effects and logs them", () => {
      const errorEffect = () => {
        throw new Error("Test error");
      };
      const successEffect = vi.fn();

      const gen = makeGen(1);
      const hook1 = queue.register(gen, errorEffect);
      const hook2 = queue.register(gen, successEffect);

      hook1({ outcome: "written" });
      hook2({ outcome: "written" });

      // Run deferred
      expect(() => deps.runAllDeferred()).not.toThrow();

      // Success effect should still have been called
      expect(successEffect).toHaveBeenCalled();

      // Error should be logged
      expect(deps.logs.some((log) => log.includes("effect threw"))).toBe(true);
    });
  });

  describe("generation staleness at run-time", () => {
    it("skips deferred effect when generation becomes stale", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      hook({ outcome: "written" });

      // Generation advances before the deferred callback runs
      deps.currentGen = 2;

      // Run deferred
      deps.runAllDeferred();

      // Effect should not have run
      expect(effectFn).not.toHaveBeenCalled();
    });
  });

  describe("exactly-once semantics", () => {
    it("never runs an effect twice", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      // First settlement via 'written'
      hook({ outcome: "written" });

      // Run deferred — effect should run once
      deps.runAllDeferred();
      expect(effectFn).toHaveBeenCalledTimes(1);

      // Clear the deferred queue and try to double-settle
      deps.deferredCallbacks = [];
      deps.currentGen = 2;

      // This should not affect anything (no held effects)
      queue.flushAfterCloseFinalization(makeGen(1, "network"));

      // Run any remaining deferred
      deps.runAllDeferred();

      // Effect count should still be 1 (never called twice)
      expect(effectFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("multiple generations", () => {
    it("handles multiple generations independently", () => {
      const effect1 = vi.fn();
      const effect2 = vi.fn();

      // Register effect for gen 1 (which is current)
      const hook1 = queue.register(makeGen(1), effect1);

      // Advance to gen 2 and register effect for gen 2
      deps.currentGen = 2;
      const hook2 = queue.register(makeGen(2), effect2);

      // Settle both with 'written'
      hook1({ outcome: "written" });
      hook2({ outcome: "written" });

      // Run deferred
      deps.runAllDeferred();

      // Gen 1 effect should not run (it's stale), but gen 2 should run
      expect(effect1).not.toHaveBeenCalled(); // Stale when it runs
      expect(effect2).toHaveBeenCalled(); // Current, so it runs
    });

    it("handles socket_closed and flush independently per generation", () => {
      const effect1 = vi.fn();
      const effect2 = vi.fn();

      deps.currentGen = 1;
      const hook1 = queue.register(makeGen(1), effect1);

      deps.currentGen = 2;
      const hook2 = queue.register(makeGen(2), effect2);

      // Hold both
      hook1({ outcome: "socket_closed" });
      hook2({ outcome: "socket_closed" });

      // Flush only gen 1 with network (while gen 1 is still current)
      deps.currentGen = 1;
      queue.flushAfterCloseFinalization(makeGen(1, "network"));

      deps.runAllDeferred();

      // Gen 1 effect should have run (it was current at deferred time), gen 2 should still be held
      expect(effect1).toHaveBeenCalled();
      expect(effect2).not.toHaveBeenCalled();

      // Clear deferred and flush gen 2 with manual
      deps.deferredCallbacks = [];
      deps.currentGen = 2; // Back to gen 2
      queue.flushAfterCloseFinalization(makeGen(2, "manual"));

      deps.runAllDeferred();

      // Gen 2 effect should be dropped (not run) because of manual cause
      expect(effect2).not.toHaveBeenCalled();
    });
  });

  describe("stale effect skipping during finalization flush", () => {
    it("skips deferred effects during flush if generation becomes stale", () => {
      const effectFn = vi.fn();
      const gen = makeGen(1);
      const hook = queue.register(gen, effectFn);

      // Hold the effect
      hook({ outcome: "socket_closed" });

      // Flush
      queue.flushAfterCloseFinalization(makeGen(1, "network"));

      // Generation advances before the deferred callback runs
      deps.currentGen = 2;

      // Run deferred
      deps.runAllDeferred();

      // Effect should be skipped (stale)
      expect(effectFn).not.toHaveBeenCalled();
      expect(
        deps.logs.some((log) =>
          log.includes("skipped stale effect during finalization"),
        ),
      ).toBe(true);
    });
  });
});
