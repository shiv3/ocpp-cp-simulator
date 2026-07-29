// src/cli/exportK6/__tests__/frames.test.ts
import { describe, expect, it } from "vitest";
import {
  createMessageIdGenerator,
  decodeFrame,
  encodeCall,
  encodeCallError,
  encodeCallResult,
} from "../runtime/frames";

describe("frames", () => {
  it("encodes a CALL as [2, id, action, payload]", () => {
    expect(JSON.parse(encodeCall("m1", "BootNotification", { a: 1 }))).toEqual([
      2,
      "m1",
      "BootNotification",
      { a: 1 },
    ]);
  });

  it("encodes a CALLRESULT as [3, id, payload]", () => {
    expect(JSON.parse(encodeCallResult("m1", { status: "Accepted" }))).toEqual([
      3,
      "m1",
      { status: "Accepted" },
    ]);
  });

  it("encodes a CALLERROR as [4, id, code, description, {}]", () => {
    expect(JSON.parse(encodeCallError("m1", "NotSupported", "nope"))).toEqual([
      4,
      "m1",
      "NotSupported",
      "nope",
      {},
    ]);
  });

  it("decodes an incoming CALL", () => {
    expect(
      decodeFrame('[2,"x","RemoteStartTransaction",{"idTag":"T"}]'),
    ).toEqual({
      kind: "call",
      messageId: "x",
      action: "RemoteStartTransaction",
      payload: { idTag: "T" },
    });
  });

  it("decodes an incoming CALLRESULT", () => {
    expect(decodeFrame('[3,"x",{"currentTime":"t"}]')).toEqual({
      kind: "result",
      messageId: "x",
      payload: { currentTime: "t" },
    });
  });

  it("decodes an incoming CALLERROR", () => {
    expect(decodeFrame('[4,"x","InternalError","boom",{}]')).toEqual({
      kind: "error",
      messageId: "x",
      errorCode: "InternalError",
      errorDescription: "boom",
    });
  });

  it("returns null for junk", () => {
    expect(decodeFrame("not json")).toBeNull();
    expect(decodeFrame('{"a":1}')).toBeNull();
    expect(decodeFrame("[9]")).toBeNull();
  });

  it("generates sequential prefixed message ids", () => {
    const gen = createMessageIdGenerator("vu3");
    expect(gen()).toBe("vu3-1");
    expect(gen()).toBe("vu3-2");
  });
});
