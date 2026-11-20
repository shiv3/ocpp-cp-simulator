import { describe, expect, it } from "vitest";

import {
  OCPPMessageType,
  decodeFrame,
  encodeCall,
  encodeCallError,
  encodeCallResult,
} from "@ocpp-cp-simulator/ocpp-rpc/index";

// The expected strings are literals on purpose: they pin the exact bytes the
// simulator wrote before the codec moved here (key order, `{}` details).
describe("frame encoders", () => {
  it.each([
    [
      "CALL",
      () => encodeCall("m1", "Heartbeat", {}),
      '[2,"m1","Heartbeat",{}]',
    ],
    [
      "CALL with a nested payload, keys kept in insertion order",
      () => encodeCall("m2", "Authorize", { idTag: "T", a: { z: 1, b: 2 } }),
      '[2,"m2","Authorize",{"idTag":"T","a":{"z":1,"b":2}}]',
    ],
    [
      "CALLRESULT",
      () => encodeCallResult("m3", { status: "Accepted" }),
      '[3,"m3",{"status":"Accepted"}]',
    ],
    [
      "CALLRESULT with an undefined payload",
      () => encodeCallResult("m4", undefined),
      '[3,"m4",null]',
    ],
    [
      "CALLERROR with details",
      () => encodeCallError("m5", "InternalError", "boom", { reason: "disk" }),
      '[4,"m5","InternalError","boom",{"reason":"disk"}]',
    ],
    [
      "CALLERROR without details",
      () => encodeCallError("m6", "NotImplemented", "no handler"),
      '[4,"m6","NotImplemented","no handler",{}]',
    ],
  ])("encodes a %s byte for byte", (_name, encode, expected) => {
    expect(encode()).toBe(expected);
  });

  it("numbers the message types as OCPP-J does", () => {
    expect([
      OCPPMessageType.CALL,
      OCPPMessageType.CALLRESULT,
      OCPPMessageType.CALLERROR,
    ]).toEqual([2, 3, 4]);
  });
});

describe("decodeFrame", () => {
  it("decodes a CALL", () => {
    expect(decodeFrame('[2,"m1","BootNotification",{"a":1}]')).toEqual({
      kind: "call",
      messageId: "m1",
      action: "BootNotification",
      payload: { a: 1 },
    });
  });

  it("decodes a CALLRESULT", () => {
    expect(decodeFrame('[3,"m1",{"status":"Accepted"}]')).toEqual({
      kind: "callResult",
      messageId: "m1",
      payload: { status: "Accepted" },
    });
  });

  it("decodes a CALLERROR, with or without details", () => {
    expect(decodeFrame('[4,"m1","GenericError","no",{"x":1}]')).toEqual({
      kind: "callError",
      messageId: "m1",
      errorCode: "GenericError",
      errorDescription: "no",
      errorDetails: { x: 1 },
    });
    expect(decodeFrame('[4,"m1","GenericError","no"]')).toEqual({
      kind: "callError",
      messageId: "m1",
      errorCode: "GenericError",
      errorDescription: "no",
      errorDetails: undefined,
    });
  });

  it("round-trips what the encoders write", () => {
    expect(decodeFrame(encodeCallError("m9", "NotImplemented", "x"))).toEqual({
      kind: "callError",
      messageId: "m9",
      errorCode: "NotImplemented",
      errorDescription: "x",
      errorDetails: {},
    });
  });

  it.each([
    ["not-json", "[2,", undefined],
    ["not-array", '{"a":1}', undefined],
    ["unknown-message-type", '[5,"m1","X",{}]', "m1"],
    ["invalid-message-id", '[2,7,"Heartbeat",{}]', undefined],
    ["invalid-message-id", '[3,"",{}]', undefined],
    ["invalid-action", '[2,"m1",42,{}]', "m1"],
    ["invalid-error", '[4,"m1",42,"no",{}]', "m1"],
    ["invalid-error", '[4,"m1","GenericError",7]', "m1"],
    ["wrong-length", '[2,"m1","Heartbeat"]', "m1"],
    ["wrong-length", '[3,"m1",{},{}]', "m1"],
    ["wrong-length", '[4,"m1","GenericError"]', "m1"],
  ])("reports %s for %s, without throwing", (reason, raw, messageId) => {
    const decoded = decodeFrame(raw);
    expect(decoded).toMatchObject({ kind: "invalid", reason, raw });
    expect(decoded.kind === "invalid" && decoded.messageId).toBe(
      messageId ?? undefined,
    );
  });
});
