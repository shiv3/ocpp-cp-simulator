import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CallWaiters as RpcCallWaiters,
  OCPPMessageType as RpcMessageType,
  encodeCall,
} from "@ocpp-cp-simulator/ocpp-rpc/index";

import { OCPPMessageType } from "../../../domain/types/OcppTypes";
import { CallWaiters } from "../CallWaiters";
import { encodeCallFrame } from "../callFrame";

describe("CallWaiters", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () =>
    new CallWaiters<string>(100, (id) => new Error(`${id} timed out`));

  it("resolves the waiter registered under an id, once", async () => {
    const waiters = make();
    const answer = waiters.register("a");
    waiters.resolve("a", "ok");
    waiters.resolve("a", "again");
    await expect(answer).resolves.toBe("ok");
  });

  it("rejects on its timer and forgets the id", async () => {
    const waiters = make();
    const answer = waiters.register("a");
    vi.advanceTimersByTime(100);
    await expect(answer).rejects.toThrow("a timed out");
    // Settling a forgotten id is a no-op.
    waiters.reject("a", new Error("late"));
  });

  it("rejects every pending waiter", async () => {
    const waiters = make();
    const a = waiters.register("a");
    const b = waiters.register("b");
    waiters.rejectAll((id) => new Error(`${id} closed`));
    await expect(a).rejects.toThrow("a closed");
    await expect(b).rejects.toThrow("b closed");
    vi.advanceTimersByTime(100);
  });

  it("ignores an id nobody waits for", () => {
    expect(() => make().resolve("nobody", "x")).not.toThrow();
  });
});

describe("core's ocpp-rpc seam (#978)", () => {
  it("is the ocpp-rpc CallWaiters", () => {
    expect(new CallWaiters<string>(1, () => new Error())).toBeInstanceOf(
      RpcCallWaiters,
    );
  });

  it("writes frames and message types through the ocpp-rpc codec", () => {
    expect(OCPPMessageType).toBe(RpcMessageType);
    expect(encodeCallFrame("m1", "Heartbeat", {})).toBe(
      encodeCall("m1", "Heartbeat", {}),
    );
  });
});
