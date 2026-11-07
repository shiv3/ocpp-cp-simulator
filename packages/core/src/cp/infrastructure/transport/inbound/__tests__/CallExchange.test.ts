import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingCallCompletion } from "../../../../domain/charge-point/ChargePointEvents";
import type { GenerationToken } from "../../network-sim/NetworkSimController";
import type {
  CloseCause,
  Settlement,
} from "../../network-sim/NetworkSimPipeline";
import {
  ResponseEffectQueue,
  type EffectDropReason,
} from "../../network-sim/ResponseEffectQueue";
import { CallExchange, CallExchangeError } from "../CallExchange";

const gen = (
  n: number,
  closeCause: CloseCause | null = null,
): GenerationToken => ({
  gen: n,
  closeCause,
});

/** A transport double that records frames and lets a test settle each one. */
class Harness {
  currentGen = 1;
  announced: IncomingCallCompletion[] = [];
  frames: Array<
    | { kind: "result"; payload: unknown }
    | { kind: "error"; code: string; description: string }
  > = [];
  hooks: Array<((s: Settlement) => void) | undefined> = [];
  warnings: string[] = [];
  deferred: Array<() => void> = [];
  failNextWrite = false;
  readonly effects = new ResponseEffectQueue({
    isGenerationCurrent: (g) => g.gen === this.currentGen,
    defer: (run) => this.deferred.push(run),
    log: () => {},
  });

  exchange(generation: GenerationToken = gen(1)): CallExchange {
    return new CallExchange({
      action: "Reset",
      messageId: "m-1",
      generation,
      isGenerationCurrent: (g) => g.gen === this.currentGen,
      announce: (c) => this.announced.push(c),
      writeResult: (payload, _g, onSettled) => {
        if (this.failNextWrite) {
          this.failNextWrite = false;
          throw new Error("write failed");
        }
        this.frames.push({ kind: "result", payload });
        this.hooks.push(onSettled);
      },
      writeError: (code, description, _g, onSettled) => {
        this.frames.push({ kind: "error", code, description });
        this.hooks.push(onSettled);
      },
      effects: this.effects,
      warn: (m) => this.warnings.push(m),
    });
  }

  runDeferred(): void {
    while (this.deferred.length > 0) this.deferred.shift()!();
  }
}

describe("CallExchange", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  describe("a single answer", () => {
    it("sends the first answer and announces it before the transport sees it", () => {
      const order: string[] = [];
      const ex = new CallExchange({
        action: "Reset",
        messageId: "m-1",
        generation: gen(1),
        isGenerationCurrent: () => true,
        announce: () => order.push("announce"),
        writeResult: () => order.push("write"),
        writeError: () => order.push("write"),
        effects: h.effects,
        warn: () => {},
      });
      expect(ex.state).toBe("open");
      void ex.respond({ status: "Accepted" });
      expect(order).toEqual(["announce", "write"]);
      expect(ex.state).toBe("answered");
    });

    it("writes in the same turn: nothing is deferred by a microtask (#456)", () => {
      const ex = h.exchange();
      ex.reply({ status: "Accepted" });
      // No await between the answer and this check.
      expect(h.frames).toEqual([
        { kind: "result", payload: { status: "Accepted" } },
      ]);
    });

    it("a second answer is not sent and throws, whichever kind", () => {
      const ex = h.exchange();
      ex.reply({ status: "Accepted" });
      expect(() => ex.reply({ status: "Rejected" })).toThrow(CallExchangeError);
      expect(() => ex.replyError("InternalError", "x")).toThrow(
        CallExchangeError,
      );
      expect(() => void ex.respond({})).toThrow(CallExchangeError);
      expect(() => void ex.suppress()).toThrow(CallExchangeError);
      expect(h.frames).toHaveLength(1);
      expect(h.announced).toHaveLength(1);
    });

    it("a CALLERROR announces its code", () => {
      const ex = h.exchange();
      ex.replyError("NotSupported", "no");
      expect(h.announced).toEqual([
        {
          action: "Reset",
          messageId: "m-1",
          outcome: "CallError",
          errorCode: "NotSupported",
        },
      ]);
      expect(h.frames).toEqual([
        { kind: "error", code: "NotSupported", description: "no" },
      ]);
    });

    it("a write that throws leaves the CALL open for a CALLERROR", () => {
      const ex = h.exchange();
      h.failNextWrite = true;
      expect(() => ex.reply({ status: "Accepted" })).toThrow("write failed");
      expect(ex.state).toBe("open");
      ex.replyError("InternalError", "write failed");
      expect(ex.state).toBe("answered");
      expect(h.frames).toEqual([
        { kind: "error", code: "InternalError", description: "write failed" },
      ]);
    });
  });

  describe("settlement", () => {
    it("reply gives the transport no hook, so the transport's discard logging stays as it was", () => {
      h.exchange().reply({ status: "Accepted" });
      h.exchange().replyError("InternalError", "x");
      expect(h.hooks).toEqual([undefined, undefined]);
    });

    it("an effect gets a hook even on a reply", () => {
      const effect = vi.fn();
      h.exchange().reply({}, { effect });
      expect(h.hooks[0]).toBeTypeOf("function");
      h.hooks[0]!({ outcome: "written" });
      h.runDeferred();
      expect(effect).toHaveBeenCalledTimes(1);
    });

    it("resolves delivered when the frame was written", async () => {
      const ex = h.exchange();
      const settlement = ex.respond({ status: "Accepted" });
      h.hooks[0]!({ outcome: "written" });
      await expect(settlement).resolves.toEqual({ delivered: true });
      await expect(ex.settled).resolves.toEqual({ delivered: true });
    });

    it.each([
      "socket_closed",
      "disposed",
      "write_failed",
      "queue_overflow",
    ] as const)(
      "resolves not delivered on the %s drop path",
      async (outcome) => {
        const settlement = h.exchange().respond({ status: "Accepted" });
        h.hooks[0]!({ outcome });
        await expect(settlement).resolves.toEqual({
          delivered: false,
          reason: outcome,
        });
      },
    );

    it("the same holds for a CALLERROR", async () => {
      const ok = h.exchange().respondError("InternalError", "x");
      h.hooks[0]!({ outcome: "written" });
      await expect(ok).resolves.toEqual({ delivered: true });

      const dropped = h.exchange().respondError("InternalError", "x");
      h.hooks[1]!({ outcome: "queue_overflow" });
      await expect(dropped).resolves.toEqual({
        delivered: false,
        reason: "queue_overflow",
      });
    });

    it("settles once even if the transport reports twice", async () => {
      const effect = vi.fn();
      const settlement = h.exchange().respond({}, { effect });
      h.hooks[0]!({ outcome: "written" });
      h.hooks[0]!({ outcome: "write_failed" });
      h.runDeferred();
      await expect(settlement).resolves.toEqual({ delivered: true });
      expect(effect).toHaveBeenCalledTimes(1);
    });

    it("suppress resolves not delivered with the reason suppressed", async () => {
      const ex = h.exchange();
      const settlement = ex.suppress();
      expect(ex.state).toBe("suppressed");
      expect(h.announced).toEqual([
        { action: "Reset", messageId: "m-1", outcome: "NoResponse" },
      ]);
      expect(h.frames).toEqual([]);
      await expect(settlement).resolves.toEqual({
        delivered: false,
        reason: "suppressed",
      });
    });
  });

  describe("effects and onEffectDropped", () => {
    it("runs the effect once the frame is written", () => {
      const effect = vi.fn();
      const dropped: EffectDropReason[] = [];
      void h.exchange().respond(
        {},
        {
          effect,
          onEffectDropped: (r) => dropped.push(r),
        },
      );
      expect(effect).not.toHaveBeenCalled();
      h.hooks[0]!({ outcome: "written" });
      h.runDeferred();
      expect(effect).toHaveBeenCalledTimes(1);
      expect(dropped).toEqual([]);
    });

    it("reports a disposed generation to onEffectDropped", async () => {
      const dropped: EffectDropReason[] = [];
      const settlement = h.exchange().respond(
        {},
        {
          effect: vi.fn(),
          onEffectDropped: (r) => dropped.push(r),
        },
      );
      h.hooks[0]!({ outcome: "disposed" });
      await settlement;
      expect(dropped).toEqual(["disposed"]);
    });

    it("reports a generation that went stale before the effect could run", async () => {
      const dropped: EffectDropReason[] = [];
      const effect = vi.fn();
      const settlement = h.exchange().respond(
        {},
        {
          effect,
          onEffectDropped: (r) => dropped.push(r),
        },
      );
      h.hooks[0]!({ outcome: "written" });
      h.currentGen = 2;
      h.runDeferred();
      await settlement;
      expect(effect).not.toHaveBeenCalled();
      expect(dropped).toEqual(["stale"]);
    });
  });

  describe("stale generation", () => {
    it("an answer on a changed connection is not sent and settles stale", async () => {
      const ex = h.exchange(gen(1));
      h.currentGen = 2;
      const dropped: EffectDropReason[] = [];
      const effect = vi.fn();
      const settlement = ex.respond(
        { status: "Accepted" },
        {
          effect,
          onEffectDropped: (r) => dropped.push(r),
        },
      );
      await expect(settlement).resolves.toEqual({
        delivered: false,
        reason: "stale",
      });
      expect(h.frames).toEqual([]);
      expect(effect).not.toHaveBeenCalled();
      expect(dropped).toEqual(["stale"]);
      expect(ex.state).toBe("abandoned");
      expect(h.warnings).toHaveLength(1);
      expect(h.announced).toEqual([
        { action: "Reset", messageId: "m-1", outcome: "NoResponse" },
      ]);
    });

    it("an answer after the exchange was abandoned settles stale and does not throw", async () => {
      const ex = h.exchange();
      ex.abandon();
      await expect(ex.respondError("InternalError", "x")).resolves.toEqual({
        delivered: false,
        reason: "stale",
      });
      expect(() => ex.reply({})).not.toThrow();
      expect(h.frames).toEqual([]);
      // announced once, at the abandon
      expect(h.announced).toHaveLength(1);
    });
  });

  describe("disconnect", () => {
    it("abandon announces NoResponse and settles stale", async () => {
      const ex = h.exchange();
      ex.abandon();
      expect(ex.state).toBe("abandoned");
      expect(h.announced).toEqual([
        { action: "Reset", messageId: "m-1", outcome: "NoResponse" },
      ]);
      await expect(ex.settled).resolves.toEqual({
        delivered: false,
        reason: "stale",
      });
    });

    it("abandon does nothing once the CALL was answered or suppressed", () => {
      const answered = h.exchange();
      answered.reply({});
      answered.abandon();
      expect(answered.state).toBe("answered");
      const suppressed = h.exchange();
      void suppressed.suppress();
      suppressed.abandon();
      expect(suppressed.state).toBe("suppressed");
      expect(h.announced.map((a) => a.outcome)).toEqual([
        "CallResult",
        "NoResponse",
      ]);
    });

    it("suppress after abandon does not throw and announces nothing more", async () => {
      const ex = h.exchange();
      ex.abandon();
      await expect(ex.suppress()).resolves.toEqual({
        delivered: false,
        reason: "stale",
      });
      expect(h.announced).toHaveLength(1);
    });
  });

  describe("onClosed", () => {
    it("fires when the exchange leaves open, by answer, suppress or abandon, and at once if it already has", () => {
      const calls: string[] = [];
      const a = h.exchange();
      a.onClosed(() => calls.push("answered"));
      a.reply({});
      const s = h.exchange();
      s.onClosed(() => calls.push("suppressed"));
      void s.suppress();
      const b = h.exchange();
      b.onClosed(() => calls.push("abandoned"));
      b.abandon();
      b.onClosed(() => calls.push("late"));
      expect(calls).toEqual(["answered", "suppressed", "abandoned", "late"]);
    });
  });
});
