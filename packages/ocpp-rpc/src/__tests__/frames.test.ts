import { describe, expect, it } from "vitest";

import {
  OCPPMessageType,
  decodeFrame,
  encodeCall,
  encodeCallError,
  encodeCallResult,
  encodeCallResultError,
  encodeSend,
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
    [
      "CALLRESULTERROR with details",
      () =>
        encodeCallResultError("m7", "FormatViolation", "bad", { field: "x" }),
      '[5,"m7","FormatViolation","bad",{"field":"x"}]',
    ],
    [
      "CALLRESULTERROR without details",
      () => encodeCallResultError("m8", "FormatViolation", ""),
      '[5,"m8","FormatViolation","",{}]',
    ],
    [
      "SEND",
      () => encodeSend("m9", "NotifyPeriodicEventStream", { id: 1, b: [2] }),
      '[6,"m9","NotifyPeriodicEventStream",{"id":1,"b":[2]}]',
    ],
  ])("encodes a %s byte for byte", (_name, encode, expected) => {
    expect(encode()).toBe(expected);
  });

  it("numbers the message types as OCPP-J does", () => {
    expect([
      OCPPMessageType.CALL,
      OCPPMessageType.CALLRESULT,
      OCPPMessageType.CALLERROR,
      OCPPMessageType.CALLRESULTERROR,
      OCPPMessageType.SEND,
    ]).toEqual([2, 3, 4, 5, 6]);
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

  it("decodes an OCPP 2.1 SEND", () => {
    expect(
      decodeFrame('[6,"m1","NotifyPeriodicEventStream",{"id":1}]'),
    ).toEqual({
      kind: "send",
      messageId: "m1",
      action: "NotifyPeriodicEventStream",
      payload: { id: 1 },
    });
  });

  it("decodes an OCPP 2.1 CALLRESULTERROR, with or without details", () => {
    expect(decodeFrame('[5,"m1","FormatViolation","bad",{"x":1}]')).toEqual({
      kind: "callResultError",
      messageId: "m1",
      errorCode: "FormatViolation",
      errorDescription: "bad",
      errorDetails: { x: 1 },
    });
    expect(decodeFrame('[5,"m1","FormatViolation","bad"]')).toEqual({
      kind: "callResultError",
      messageId: "m1",
      errorCode: "FormatViolation",
      errorDescription: "bad",
      errorDetails: undefined,
    });
  });

  // A 1.6 or 2.0.1 reader: the 2.1 types are unknown there, malformed or not,
  // exactly as before the codec learnt them.
  it.each([
    '[5,"m1","FormatViolation","bad",{}]',
    '[5,"m1",42]',
    '[6,"m1","NotifyPeriodicEventStream",{}]',
    '[6,"m1",42,{}]',
  ])("reports %s as unknown-message-type with ocpp21: false", (raw) => {
    expect(decodeFrame(raw, { ocpp21: false })).toEqual({
      kind: "invalid",
      reason: "unknown-message-type",
      raw,
      messageId: "m1",
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
    ["unknown-message-type", '[7,"m1","X",{}]', "m1"],
    ["unknown-message-type", '[1,"m1","X",{}]', "m1"],
    ["invalid-message-id", '[2,7,"Heartbeat",{}]', undefined],
    ["invalid-message-id", '[3,"",{}]', undefined],
    ["invalid-action", '[2,"m1",42,{}]', "m1"],
    ["invalid-error", '[4,"m1",42,"no",{}]', "m1"],
    ["invalid-error", '[4,"m1","GenericError",7]', "m1"],
    ["wrong-length", '[2,"m1","Heartbeat"]', "m1"],
    ["wrong-length", '[3,"m1",{},{}]', "m1"],
    ["wrong-length", '[4,"m1","GenericError"]', "m1"],
    ["invalid-action", '[6,"m1","",{}]', "m1"],
    ["invalid-error", '[5,"m1","FormatViolation",7]', "m1"],
    ["wrong-length", '[6,"m1","NotifyPeriodicEventStream"]', "m1"],
    ["wrong-length", '[5,"m1","FormatViolation"]', "m1"],
    ["wrong-length", '[5,"m1","FormatViolation","bad",{},{}]', "m1"],
  ])("reports %s for %s, without throwing", (reason, raw, messageId) => {
    const decoded = decodeFrame(raw);
    expect(decoded).toMatchObject({ kind: "invalid", reason, raw });
    expect(decoded.kind === "invalid" && decoded.messageId).toBe(
      messageId ?? undefined,
    );
  });
});
