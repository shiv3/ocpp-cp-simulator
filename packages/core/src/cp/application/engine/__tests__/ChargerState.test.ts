import { describe, expect, it } from "vitest";
import {
  assertJsonSerializable,
  initialChargerState,
  reduceChargerState,
} from "../ChargerState";

describe("ChargerState", () => {
  it("is JSON-serializable from the start", () => {
    const state = initialChargerState();
    expect(() => assertJsonSerializable(state)).not.toThrow();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("records a notification without touching the old state", () => {
    const before = initialChargerState();
    const after = reduceChargerState(before, {
      type: "notified",
      kind: "firmware",
      status: "Downloading",
      requestId: 4,
    });
    expect(after.firmware).toEqual({ status: "Downloading", requestId: 4 });
    expect(before.firmware.status).toBe("Idle");
  });

  it("keeps behavior data until the behavior is unloaded", () => {
    let state = reduceChargerState(initialChargerState(), {
      type: "behavior.loaded",
      behaviorId: "a",
    });
    state.behaviors.a.count = 3;
    state = reduceChargerState(state, { type: "connection.closed" });
    expect(state.behaviors.a).toEqual({ count: 3 });
    state = reduceChargerState(state, {
      type: "behavior.unloaded",
      behaviorId: "a",
    });
    expect(state.behaviors.a).toBeUndefined();
  });

  it("rejects state that JSON would change", () => {
    // A key set to undefined is an absent key (JSON drops it): the usual way
    // to clear one. In an array, undefined would become null: refused.
    expect(() => assertJsonSerializable({ a: undefined })).not.toThrow();
    expect(() => assertJsonSerializable({ a: [undefined] })).toThrow();
    expect(() => assertJsonSerializable({ a: new Date() })).toThrow();
    expect(() => assertJsonSerializable({ a: Number.NaN })).toThrow();
    expect(() => assertJsonSerializable({ a: () => 1 })).toThrow();
    expect(() =>
      assertJsonSerializable({ a: [1, "x", null, { b: true }] }),
    ).not.toThrow();
  });
});
