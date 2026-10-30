import { afterEach, describe, expect, it, vi } from "vitest";

import { RawFrameSender } from "../RawFrameSender";
import type {
  IncomingFrameInterceptor,
  OCPPWebSocket,
  TransportObserverEvents,
} from "../OCPPWebSocket";
import type { Settlement } from "../network-sim/NetworkSimPipeline";
import { EventEmitter } from "../../../shared/EventEmitter";
import { OcppCallNoAnswerError } from "../../../domain/errors/OcppCallErrors";

/**
 * #393 review: the sender's own rules, on a fake transport that holds each
 * frame until the test settles it, as a network-sim delay would.
 */
function fakeTransport() {
  let interceptor: IncomingFrameInterceptor | null = null;
  const pending: Array<(s: Settlement) => void> = [];
  const observers = new EventEmitter<TransportObserverEvents>();
  const transport = {
    observers,
    isConnected: () => true,
    currentGeneration: () => ({ gen: 1, closeCause: null }),
    setIncomingInterceptor: (next: IncomingFrameInterceptor | null) => {
      interceptor = next;
    },
    sendRaw: (
      _raw: string,
      _gen: unknown,
      onSettled?: (s: Settlement) => void,
    ) => {
      if (onSettled) pending.push(onSettled);
    },
  };
  return {
    sender: new RawFrameSender(transport as unknown as OCPPWebSocket),
    /** Settles the oldest frame the transport holds. */
    settle: (s: Settlement) => pending.shift()?.(s),
    /** Delivers an incoming frame; true when the sender consumed it. */
    receive: (frame: unknown[]) => interceptor?.(frame) ?? false,
    observers,
  };
}

describe("RawFrameSender (#393 review)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not let a reply answer a frame that is not on the wire yet", async () => {
    const t = fakeTransport();
    const sending = t.sender.send({ frame: '[2,"r1"]', waitMs: 1000 });
    expect(t.receive([3, "r1", {}])).toBe(false);
    t.settle({ outcome: "written" });
    expect(t.receive([3, "r1", {}])).toBe(true);
    await expect(sending).resolves.toMatchObject({ reply: [3, "r1", {}] });
  });

  it("counts the time the frame spends queued against the wait", async () => {
    vi.useFakeTimers();
    const t = fakeTransport();
    const sending = t.sender.send({ frame: "[]", waitMs: 500 });
    // Still queued (a network-sim delay): the wait runs out regardless.
    await vi.advanceTimersByTimeAsync(500);
    await expect(sending).resolves.toEqual({
      sentFrame: "[]",
      messageId: null,
      reply: null,
      closed: null,
    });
    // Written afterwards: nothing is left waiting for it.
    t.settle({ outcome: "written" });
    expect(t.receive([4, "-1", "RpcFrameworkError", "", {}])).toBe(false);
  });

  it.each(["queue_overflow", "write_failed", "disposed"] as const)(
    "rejects a frame dropped with %s instead of reporting a close",
    async (outcome) => {
      const t = fakeTransport();
      const sending = t.sender.send({ frame: "[]" });
      t.settle({ outcome });
      await expect(sending).rejects.toBeInstanceOf(OcppCallNoAnswerError);
      await expect(sending).rejects.toMatchObject({ reason: "dropped" });
    },
  );

  it("reports the close cause of a frame dropped by a closing socket", async () => {
    const t = fakeTransport();
    const sending = t.sender.send({ frame: "[]" });
    t.settle({ outcome: "socket_closed", closeCause: "internal" });
    await expect(sending).resolves.toMatchObject({ closed: "internal" });
  });

  it("settles a written frame's wait when the generation ends", async () => {
    const t = fakeTransport();
    const sending = t.sender.send({ frame: "[]", waitMs: 25_000 });
    t.settle({ outcome: "written" });
    t.observers.emit("closed", { cause: "disposed" });
    await expect(sending).resolves.toMatchObject({
      reply: null,
      closed: "disposed",
    });
  });
});
