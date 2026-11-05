import { describe, it, expect } from "vitest";
import {
  splitStopReason,
  STOP_REASONS,
  STOP_TRANSACTION_REASONS,
  TRANSACTION_STOPPED_REASONS,
} from "../Transaction";

// #335: `stop_transaction { reason }` is one parameter over two vocabularies.
describe("splitStopReason", () => {
  it("keeps a 1.6 reason for StopTransaction.req and, where 2.0.1 spells it the same, names it explicitly too", () => {
    expect(splitStopReason("EVDisconnected")).toEqual({
      stopReason: "EVDisconnected",
      stoppedReason: "EVDisconnected",
    });
  });

  it("leaves a 1.6-only reason to the encoder's mapping", () => {
    // HardReset → ImmediateReset happens in the 2.0.1 encoder, not here.
    expect(splitStopReason("HardReset")).toEqual({
      stopReason: "HardReset",
      stoppedReason: undefined,
    });
  });

  it("sends a 2.0.1-only reason verbatim and falls back to Other on 1.6", () => {
    expect(splitStopReason("SOCLimitReached")).toEqual({
      stopReason: "Other",
      stoppedReason: "SOCLimitReached",
    });
  });

  it("is a no-op for an absent reason", () => {
    expect(splitStopReason(undefined)).toEqual({});
  });

  it("accepts exactly the union of the two vocabularies, once each", () => {
    const union = new Set<string>([
      ...STOP_TRANSACTION_REASONS,
      ...TRANSACTION_STOPPED_REASONS,
    ]);
    expect(new Set(STOP_REASONS)).toEqual(union);
    expect(STOP_REASONS.length).toBe(union.size);
  });
});
