import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OCPP_CALL_RESPONSE_TIMEOUT_MS } from "../../../domain/types/OcppCall";
import { ExpertCalls } from "../ExpertCalls";

describe("ExpertCalls", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lets answers to CALLs it did not start through", () => {
    const calls = new ExpertCalls(() => false);
    expect(calls.claimResult("other", {})).toBe(false);
    expect(calls.claimError("other", { errorCode: "x" })).toBe(false);
  });

  it("still claims an answer that arrives after the caller timed out", async () => {
    const calls = new ExpertCalls(() => false);
    const answer = calls.start("m1", { action: "Heartbeat", payload: {} });
    vi.advanceTimersByTime(OCPP_CALL_RESPONSE_TIMEOUT_MS);
    await expect(answer).rejects.toMatchObject({ reason: "timeout" });
    // Without applyResponse the late answer must not reach the station.
    expect(calls.claimResult("m1", {})).toBe(true);
    expect(calls.claimResult("m1", {})).toBe(false);
  });

  it("lets the answer through when the caller asked to applyResponse", () => {
    const calls = new ExpertCalls(() => false);
    void calls.start("m1", {
      action: "Heartbeat",
      payload: {},
      applyResponse: true,
    });
    expect(calls.claimError("m1", { errorCode: "GenericError" })).toBe(false);
  });

  it("reports a non-string error code from a non-conformant CSMS as a string", async () => {
    const calls = new ExpertCalls(() => false);
    const answer = calls.start("m1", { action: "Heartbeat", payload: {} });
    calls.claimError("m1", {
      errorCode: 42 as unknown as string,
      errorDescription: undefined,
    });
    await expect(answer).resolves.toMatchObject({
      errorCode: "42",
      errorDescription: "",
    });
  });
});
